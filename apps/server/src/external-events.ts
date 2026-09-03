// External event application (company pipeline design §13 item 2, §19).
//
// The transition a POST /api/external-events used to perform inline now lives
// here so three callers share exactly one behaviour: the session route, the
// bundled Gitea receiver (no session user, actor system/gitea) and the
// timeout sweep. Nothing in this file runs at load time; it imports dispatch
// for the shared lifecycle primitives the same way review-rounds.ts does.

import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { normalizeCardStatus } from '@megacorps/shared';
import { recordStageAction, type CardActionActor } from './card-actions.ts';
import { db } from './db/client.ts';
import { activityLog, externalEvents, externalWaits, kanbanCards, taskLogs } from './db/schema.ts';
import { cascadeParentStatus, completionBlockedByChildren, enqueueTaskRun } from './dispatch.ts';
import { publishLiveEvent } from './live.ts';
import { notify } from './notifications.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type ExternalWaitRow = typeof externalWaits.$inferSelect;

export type ExternalEventStatus = 'success' | 'failure' | 'cancelled' | 'waiting' | 'timeout' | 'info';

export type ApplyExternalEventInput = {
  companyId?: string | null;
  projectId?: string | null;
  rootCardId?: string | null;
  provider: string;
  eventType: string;
  externalId?: string | null;
  externalUrl?: string | null;
  status: ExternalEventStatus;
  payloadSummary?: string | null;
  payload?: Record<string, unknown>;
  // Resolve only this wait instead of every waiting row on the card. The
  // session route keeps the historical card-wide behaviour by leaving it unset.
  waitId?: string | null;
  // Merge closure (§19): a merged pull request is the end of the card, not a
  // reason to review it again, so the merge gate asks for done explicitly.
  successStatus?: 'done' | 'in_review' | null;
};

export type ApplyExternalEventResult = {
  event: typeof externalEvents.$inferSelect | null;
  newStatus: string | null;
};

function hashValue(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export async function rootCardId(card: CardRow): Promise<string> {
  let current = card;
  const seen = new Set<string>();
  while (current.parentCardId && !seen.has(current.parentCardId)) {
    seen.add(current.id);
    const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, current.parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

// Pure: the card status an external event asks for, before the children gate.
export function externalEventNextStatus(card: Pick<CardRow, 'columnStatus' | 'reviewerId' | 'assigneeId'>, status: ExternalEventStatus, successStatus?: 'done' | 'in_review' | null): string | null {
  if (status === 'success') return successStatus ?? (card.reviewerId ? 'in_review' : 'done');
  if (status === 'failure' || status === 'cancelled') return card.assigneeId ? 'in_progress' : 'blocked';
  if (status === 'timeout') return 'blocked';
  return card.columnStatus;
}

export async function applyExternalEvent(args: { card: CardRow; input: ApplyExternalEventInput; actor: CardActionActor }): Promise<ApplyExternalEventResult> {
  const { card, input, actor } = args;
  const companyId = input.companyId ?? card.companyId;
  const now = new Date();
  const payload = input.payload ?? {};
  const [event] = await db.insert(externalEvents).values({
    companyId,
    projectId: input.projectId ?? card.projectId,
    rootCardId: input.rootCardId ?? await rootCardId(card),
    cardId: card.id,
    provider: input.provider,
    eventType: input.eventType,
    externalId: input.externalId ?? null,
    externalUrl: input.externalUrl ?? null,
    status: input.status,
    payloadHash: hashValue(payload),
    payloadSummary: input.payloadSummary ?? null,
    payload,
    processedAt: now,
  }).returning();
  const resolvedAt = input.status === 'waiting' || input.status === 'info' ? undefined : now;
  await db.update(externalWaits).set({ status: input.status, resolvedAt }).where(input.waitId
    ? and(eq(externalWaits.id, input.waitId), eq(externalWaits.status, 'waiting'))
    : and(eq(externalWaits.cardId, card.id), eq(externalWaits.status, 'waiting')));
  let nextStatus = externalEventNextStatus(card, input.status, input.successStatus);
  if (nextStatus !== card.columnStatus && nextStatus) {
    const fromStatus = normalizeCardStatus(card.columnStatus) ?? 'todo';
    const requestedToStatus = normalizeCardStatus(nextStatus) ?? fromStatus;
    const childBlock = await completionBlockedByChildren(card, requestedToStatus);
    const toStatus = childBlock ? 'in_progress' : requestedToStatus;
    nextStatus = toStatus;
    await db.update(kanbanCards).set({
      columnStatus: toStatus,
      rollupStatus: childBlock ? 'waiting_on_children' : toStatus === 'done' ? 'done' : undefined,
      lastError: toStatus === 'blocked' ? input.payloadSummary ?? `${input.provider} ${input.eventType} ${input.status}` : null,
      completedAt: toStatus === 'done' ? now : null,
      updatedAt: now,
    }).where(eq(kanbanCards.id, card.id));
    const action = input.status === 'success'
      ? 'external_success'
      : toStatus === 'in_progress'
        ? 'external_failure'
        : toStatus === 'blocked'
          ? 'block'
          : 'manual_move';
    await recordStageAction({ cardId: card.id, agentId: card.assigneeId, actor, fromStatus, toStatus, action, detail: childBlock ? `External ${input.provider}/${input.eventType} reported ${input.status}; ${childBlock.message}` : `External ${input.provider}/${input.eventType} reported ${input.status}.`, metadata: { externalEventId: event?.id, requestedToStatus, childBlock } });
    if (childBlock) await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'children', status: 'queued', message: childBlock.message });
    if (toStatus === 'in_review') await enqueueTaskRun(card.id, 'review', 'queue');
    if (toStatus === 'done') await cascadeParentStatus(card.parentCardId);
  }
  await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: input.status === 'failure' || input.status === 'timeout' ? 'failed' : 'success', message: `External event ${input.provider}/${input.eventType}: ${input.status}`, output: input.payloadSummary ?? undefined });
  await db.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, userId: actor.userId ?? null, agentId: card.assigneeId, action: 'external_event.received', entityType: 'card', entityId: card.id, details: { externalEventId: event?.id, provider: input.provider, eventType: input.eventType, status: input.status } });
  publishLiveEvent({ type: 'card.updated', companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'external_event.received' });
  return { event: event ?? null, newStatus: nextStatus };
}

const TIMEOUT_SWEEP_BATCH = 20;

// Design §13 item 2: external_waits.timeout_at had no consumer, so an external
// system that never answered left the card parked forever. Due waits now block
// the card and ring the bell, in bounded batches so one tick cannot stall.
export async function sweepExternalWaitTimeouts(app: FastifyInstance): Promise<number> {
  const due: ExternalWaitRow[] = await db.select().from(externalWaits)
    .where(and(eq(externalWaits.status, 'waiting'), isNotNull(externalWaits.timeoutAt), lte(externalWaits.timeoutAt, new Date())))
    .orderBy(externalWaits.timeoutAt)
    .limit(TIMEOUT_SWEEP_BATCH);
  let handled = 0;
  for (const wait of due) {
    try {
      const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, wait.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (!card) {
        await db.update(externalWaits).set({ status: 'cancelled', resolvedAt: new Date() }).where(eq(externalWaits.id, wait.id));
        continue;
      }
      const summary = `Timed out waiting for ${wait.provider}: ${wait.waitingFor}.`;
      await applyExternalEvent({
        card,
        actor: { type: 'system', id: 'external-wait-timeout' },
        input: {
          provider: wait.provider,
          eventType: 'wait.timeout',
          status: 'timeout',
          externalId: wait.externalId,
          externalUrl: wait.externalUrl,
          payloadSummary: summary,
          payload: { externalWaitId: wait.id, waitingFor: wait.waitingFor, timeoutAt: wait.timeoutAt?.toISOString() ?? null },
          waitId: wait.id,
        },
      });
      await notify({
        companyId: card.companyId,
        type: 'external_timeout',
        title: `External wait timed out: ${card.title}`,
        body: summary,
        entityType: 'card',
        entityId: card.id,
        cardId: card.id,
        agentId: card.assigneeId,
      });
      handled += 1;
    } catch (error) {
      app.log.warn({ error, externalWaitId: wait.id }, 'external wait timeout sweep skipped a wait');
    }
  }
  if (handled > 0) app.log.info({ handled }, 'external waits timed out');
  return handled;
}
