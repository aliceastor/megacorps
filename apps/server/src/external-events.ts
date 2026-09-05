import { sealDeliveryAcceptance, acceptedDescendantEvidence } from './delivery-acceptance.ts';
import { delegatedEvidenceStatus } from './delegated-acceptance.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
// External event application (company pipeline design §13 item 2, §19).
//
// The transition a POST /api/external-events used to perform inline now lives
// here so three callers share exactly one behaviour: the session route, the
// bundled Gitea receiver (no session user, actor system/gitea) and the
// timeout sweep. Nothing in this file runs at load time; it imports dispatch
// for the shared lifecycle primitives the same way review-rounds.ts does.

import { createHash } from 'node:crypto';
import { settleMergeIntent } from './authorized-merge.ts';
import { and, desc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { normalizeCardStatus } from '@megacorps/shared';
import { recordStageAction, type CardActionActor } from './card-actions.ts';
import { db } from './db/client.ts';
import { activityLog, approvals, externalEvents, externalWaits, kanbanCards, taskLogs } from './db/schema.ts';
import { addCardMessage, cascadeParentStatus, completionBlockedByChildren, enqueueTaskRun } from './dispatch.ts';
import { EXTERNAL_POLL_MAX, formatPollExhaustedMessage, pollDecision } from './external-polling.ts';
import { publishLiveEvent } from './live.ts';
import { notify } from './notifications.ts';
import { applyMergeGatePlan, mergeCompletionStatus, planMergeGate, reconcileMergeWait } from './merge-gate.ts';
import { completionCondition } from './completion-guard.ts';

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

export async function applyExternalEvent(args: { card: CardRow; input: ApplyExternalEventInput; actor: CardActionActor; verifiedMerge?: boolean }): Promise<ApplyExternalEventResult> {
  const { input, actor } = args;
  const now = new Date();
  const [current] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, args.card.id), isNull(kanbanCards.deletedAt))).limit(1);
  if (!current || ['done', 'cancelled'].includes(current.columnStatus ?? '')) return { event: null, newStatus: current?.columnStatus ?? null };
  let requestedStatus = externalEventNextStatus(current, input.status, args.verifiedMerge ? input.successStatus : undefined);
  const childBlock = await completionBlockedByChildren(current, normalizeCardStatus(requestedStatus) ?? 'todo');
  const mergePlan = !args.verifiedMerge && !childBlock && requestedStatus === 'done' ? await planMergeGate(current) : null;
  requestedStatus = childBlock ? 'in_progress' : mergePlan ? mergeCompletionStatus(mergePlan) : requestedStatus;
  const companyId = input.companyId ?? current.companyId;
  const superseded = new Error('external_completion_superseded');
  const committed = await retryMergeGateWrite(() => db.transaction(async (tx) => {
    const [card] = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id, current.id), isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!card || card.columnStatus !== current.columnStatus || ['done', 'cancelled'].includes(card.columnStatus ?? '')) return null;
    const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(current)).limit(1);
    if (!authorized) return null;
    if (requestedStatus === 'done') {
      const descendants = await acceptedDescendantEvidence(card, tx, true);
      if (descendants.issues.length || (descendants.requiredCount && !descendants.ready) || !(await delegatedEvidenceStatus(card, tx)).ready) return null;
    }
    // A supplied wait belongs only to a card that is still parked on it.
    // Reject before the first mutation; returning null commits a transaction.
    if (input.waitId && card.columnStatus !== 'waiting_on_external') return null;
    if (args.verifiedMerge && input.waitId && ['success', 'failure'].includes(input.status)) {
      const [verifiedWait] = await tx.select().from(externalWaits).where(and(eq(externalWaits.id, input.waitId), eq(externalWaits.cardId, card.id), eq(externalWaits.status, 'waiting'))).limit(1);
      if (!verifiedWait) return null;
      if (verifiedWait.authorizedHeadSha) await settleMergeIntent(tx, verifiedWait.id, verifiedWait.authorizedHeadSha, input.status === 'success' ? 'verified' : 'closed');
    }
    if (requestedStatus && requestedStatus !== card.columnStatus) {
      const [updated] = await tx.update(kanbanCards).set({ columnStatus: requestedStatus, rollupStatus: childBlock ? 'waiting_on_children' : requestedStatus === 'done' ? 'done' : undefined, lastError: requestedStatus === 'blocked' ? input.payloadSummary ?? 'External completion requires correction.' : null, completedAt: requestedStatus === 'done' ? now : null, updatedAt: now }).where(completionCondition(current)).returning();
      if (!updated) return null;
    }
    if (input.waitId) {
      const [claimed] = await tx.update(externalWaits).set({ status: input.status, resolvedAt: ['waiting', 'info'].includes(input.status) ? null : now }).where(and(eq(externalWaits.id, input.waitId), eq(externalWaits.cardId, card.id), eq(externalWaits.status, 'waiting'))).returning();
      if (!claimed) throw superseded; // Roll back the card write with the lost wait claim.
    } else {
      // Generic events must not consume a merge authorization before its evidence is verified.
      const waits = await tx.select().from(externalWaits).where(and(eq(externalWaits.cardId, card.id), eq(externalWaits.status, 'waiting')));
      for (const wait of waits) if (!wait.authorizedHeadSha) await tx.update(externalWaits).set({ status: input.status, resolvedAt: ['waiting', 'info'].includes(input.status) ? null : now }).where(eq(externalWaits.id, wait.id));
    }
    const [event] = await tx.insert(externalEvents).values({ companyId, projectId: input.projectId ?? card.projectId, rootCardId: input.rootCardId ?? await rootCardId(card), cardId: card.id, provider: input.provider, eventType: input.eventType, externalId: input.externalId ?? null, externalUrl: input.externalUrl ?? null, status: input.status, payloadHash: hashValue(input.payload ?? {}), payloadSummary: input.payloadSummary ?? null, payload: input.payload ?? {}, processedAt: now }).returning();
    return { card, event };
  })).catch((error) => { if (error === superseded) return null; throw error; });
  if (!committed) return { event: null, newStatus: current.columnStatus };
  const { card, event } = committed;
  const fromStatus = normalizeCardStatus(card.columnStatus) ?? 'todo';
  const toStatus = normalizeCardStatus(requestedStatus) ?? fromStatus;
  if (fromStatus !== toStatus) {
    await recordStageAction({ cardId: card.id, agentId: card.assigneeId, actor, fromStatus, toStatus, action: input.status === 'success' ? 'external_success' : toStatus === 'in_progress' ? 'external_failure' : toStatus === 'blocked' ? 'block' : 'manual_move', detail: childBlock?.message ?? 'External ' + input.provider + '/' + input.eventType + ' reported ' + input.status + '.', metadata: { externalEventId: event?.id, childBlock } });
    if (toStatus === 'in_review') await enqueueTaskRun(card.id, 'review', 'queue');
    if (toStatus === 'done') { await sealDeliveryAcceptance(card.id); await cascadeParentStatus(card.parentCardId); }
  }
  if (mergePlan) await applyMergeGatePlan({ ...card, columnStatus: requestedStatus }, mergePlan);
  await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: input.status === 'failure' || input.status === 'timeout' ? 'failed' : 'success', message: 'External event ' + input.provider + '/' + input.eventType + ': ' + input.status, output: input.payloadSummary ?? undefined });
  await db.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, userId: actor.userId ?? null, agentId: card.assigneeId, action: 'external_event.received', entityType: 'card', entityId: card.id, details: { externalEventId: event?.id, provider: input.provider, eventType: input.eventType, status: input.status } });
  publishLiveEvent({ type: 'card.updated', companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'external_event.received' });
  return { event: event ?? null, newStatus: requestedStatus };
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
      const applied = await applyExternalEvent({
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
      if (!applied.event) continue;
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

/** The open wait a card is parked on, newest first; the webhook reuses it instead of stacking duplicates. */
export async function openExternalWait(cardId: string): Promise<ExternalWaitRow | null> {
  const [wait] = await db.select().from(externalWaits)
    .where(and(eq(externalWaits.cardId, cardId), eq(externalWaits.status, 'waiting')))
    .orderBy(desc(externalWaits.createdAt))
    .limit(1);
  return wait ?? null;
}

const POLL_SWEEP_BATCH = 10;

// Design §13 item 1: poll_interval_seconds finally has a consumer. A due wait
// hands the card back to its owner for one bounded check; the owner either
// reports the outcome or parks it again, which the webhook folds into the same
// wait row so the budget keeps counting. Systems that call back (the Gitea
// receiver) never get here, because their waits carry no interval.
export async function sweepExternalWaitPolls(app: FastifyInstance): Promise<number> {
  const candidates: ExternalWaitRow[] = await db.select().from(externalWaits)
    .where(and(eq(externalWaits.status, 'waiting'), or(isNotNull(externalWaits.pollIntervalSeconds), and(eq(externalWaits.provider, 'gitea'), isNotNull(externalWaits.authorizedHeadSha))),
      sql`CASE WHEN ${externalWaits.provider} = 'gitea' AND ${externalWaits.authorizedHeadSha} IS NOT NULL THEN ${externalWaits.pollCount} < ${EXTERNAL_POLL_MAX} ELSE true END`,
      sql`EXISTS (SELECT 1 FROM ${kanbanCards} WHERE ${kanbanCards.id} = ${externalWaits.cardId} AND ${kanbanCards.columnStatus} = 'waiting_on_external' AND ${kanbanCards.deletedAt} IS NULL)`,
      sql`NOT EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.cardId} = ${externalWaits.cardId} AND ${approvals.status} = 'pending' AND ${approvals.type} = 'task_review' AND ${approvals.payload}->>'humanGate' = 'true')`))
    .orderBy(externalWaits.lastPolledAt, externalWaits.createdAt)
    .limit(POLL_SWEEP_BATCH * 3);
  const now = Date.now();
  let polled = 0;
  for (const wait of candidates) {
    if (polled >= POLL_SWEEP_BATCH) break;
    if (wait.provider === 'gitea' && wait.authorizedHeadSha) {
      if (await reconcileMergeWait(wait.id)) polled += 1;
      continue;
    }
    const decision = pollDecision(wait, now);
    if (!decision.poll) {
      if (decision.reason !== 'budget_spent') continue;
      // The budget ran out: say so once, then stop looking at this wait.
      try {
        const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, wait.cardId), isNull(kanbanCards.deletedAt))).limit(1);
        await db.update(externalWaits).set({ pollIntervalSeconds: null }).where(eq(externalWaits.id, wait.id));
        if (card) {
          const message = formatPollExhaustedMessage({ provider: wait.provider, waitingFor: wait.waitingFor, max: EXTERNAL_POLL_MAX });
          await addCardMessage({ cardId: card.id, authorType: 'system', action: 'external_poll_exhausted', body: message, metadata: { externalWaitId: wait.id, pollCount: wait.pollCount } });
          await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'external', status: 'warning', message });
          await notify({ companyId: card.companyId, type: 'external_poll_exhausted', title: `Stopped checking on: ${card.title}`, body: message, entityType: 'card', entityId: card.id, cardId: card.id, agentId: card.assigneeId });
        }
      } catch (error) {
        app.log.warn({ error, externalWaitId: wait.id }, 'external poll exhaustion note failed');
      }
      continue;
    }
    try {
      const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, wait.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (!card) {
        await db.update(externalWaits).set({ status: 'cancelled', resolvedAt: new Date() }).where(eq(externalWaits.id, wait.id));
        continue;
      }
      // Only a card actually parked on this wait is polled: a card someone
      // moved on by hand is none of the sweep's business.
      if (card.columnStatus !== 'waiting_on_external') continue;
      if (!card.assigneeId) continue;
      await db.update(externalWaits).set({ lastPolledAt: new Date(), pollCount: decision.attempt }).where(eq(externalWaits.id, wait.id));
      await db.insert(taskLogs).values({
        cardId: card.id,
        agentId: card.assigneeId,
        type: 'external',
        status: 'queued',
        message: `Check ${decision.attempt}/${EXTERNAL_POLL_MAX} queued for ${wait.provider}: ${wait.waitingFor}`,
      });
      await enqueueTaskRun(card.id, 'dispatch', 'queue');
      await db.insert(activityLog).values({
        companyId: card.companyId,
        actorType: 'system',
        actorId: 'external-wait-poll',
        agentId: card.assigneeId,
        action: 'external_wait.polled',
        entityType: 'card',
        entityId: card.id,
        details: { externalWaitId: wait.id, attempt: decision.attempt, provider: wait.provider, final: decision.final },
      });
      polled += 1;
    } catch (error) {
      app.log.warn({ error, externalWaitId: wait.id }, 'external wait poll sweep skipped a wait');
    }
  }
  if (polled > 0) app.log.info({ polled }, 'external waits polled');
  return polled;
}
