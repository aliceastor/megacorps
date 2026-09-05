import { and, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { approvals, kanbanCards, taskLogs, taskRuns } from './db/schema.ts';
import { recordStageAction } from './card-actions.ts';
import { notify } from './notifications.ts';
import { publishLiveEvent } from './live.ts';

export type RetryKind = 'review' | 'message' | 'message_review';
export type RunRetryState = Partial<Record<RetryKind, { failures: number; nextRunAt: string | null }>>;
export const RUN_FAILURE_LIMIT = 5;
const RETRY_MINUTES = [1, 5, 15, 30] as const;

export function isRetryKind(kind: string): kind is RetryKind {
  return kind === 'review' || kind === 'message' || kind === 'message_review';
}

export function runRetryReady(card: { columnStatus: string | null; runRetryState?: RunRetryState | null }, kind: string, now = new Date()): boolean {
  if (!isRetryKind(kind)) return true;
  if (card.columnStatus === 'blocked') return false;
  const retry = card.runRetryState?.[kind];
  return !retry || (retry.failures < RUN_FAILURE_LIMIT && (!retry.nextRunAt || new Date(retry.nextRunAt) <= now));
}

export function assertRunRetryNotExhausted(card: { columnStatus: string | null; runRetryState?: RunRetryState | null }, kind: RetryKind): void {
  if (card.columnStatus === 'blocked') throw new Error('card_blocked');
  if ((card.runRetryState?.[kind]?.failures ?? 0) >= RUN_FAILURE_LIMIT) throw new Error(`${kind}_retry_exhausted`);
}

// Explicit operator actions reset all kinds; ordinary success resets only its
// own kind, so healthy reviews cannot hide failing message runs.
export async function resetRunRetries(cardId: string): Promise<void> {
  await db.update(kanbanCards).set({ runRetryState: {} }).where(eq(kanbanCards.id, cardId));
}

export type RunCompletion = {
  status: 'success' | 'failed' | 'cancelled';
  error?: string | null;
  output?: string | null;
  costUsd?: number;
  durationSeconds?: number;
  releaseLock?: boolean;
  // A rejected deliverable is a valid review, not an adapter failure.
  retryableFailure?: boolean;
};

export async function completeRetryableRun(runId: string, input: RunCompletion): Promise<boolean> {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
  if (!run || !isRetryKind(run.kind)) return false;
  const kind = run.kind;
  const result = await db.transaction(async (tx) => {
    // Card lock preserves concurrent outcomes of different kinds. Updating the
    // run and its streak together also makes duplicate callbacks idempotent.
    const [card] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, run.cardId)).for('update').limit(1);
    if (!card) return null;
    const now = new Date();
    const [finished] = await tx.update(taskRuns).set({
      status: input.status, error: input.error ?? null, output: input.output ?? null,
      costUsd: input.costUsd === undefined ? undefined : input.costUsd.toString(),
      durationSeconds: input.durationSeconds, completedAt: now, updatedAt: now,
      ...(input.releaseLock ? { lockedBy: null, lockedAt: null } : {}),
    }).where(and(eq(taskRuns.id, runId), inArray(taskRuns.status, ['queued', 'running']))).returning();
    if (!finished || input.status === 'cancelled') return null;
    const state: RunRetryState = { ...card.runRetryState };
    const failed = input.status === 'failed' && input.retryableFailure === true;
    const failures = failed ? Math.min(RUN_FAILURE_LIMIT, (state[kind]?.failures ?? 0) + 1) : 0;
    const exhausted = failures >= RUN_FAILURE_LIMIT;
    if (failed) state[kind] = {
      failures,
      nextRunAt: exhausted ? null : new Date(now.getTime() + RETRY_MINUTES[failures - 1]! * 60_000).toISOString(),
    };
    else delete state[kind];
    const [humanGate] = exhausted ? await tx.select({ id: approvals.id }).from(approvals).where(and(
      eq(approvals.cardId, card.id), eq(approvals.type, 'task_review'), eq(approvals.status, 'pending'),
      drizzleSql`${approvals.payload}->>'humanGate' = 'true'`,
    )).limit(1) : [];
    const block = exhausted && !humanGate && !['done', 'cancelled', 'blocked', 'waiting_on_client'].includes(card.columnStatus ?? '');
    const reason = `${kind} failed ${failures} consecutive time(s): ${input.error ?? 'adapter failure'}`;
    await tx.update(kanbanCards).set({
      runRetryState: state,
      ...(block ? { columnStatus: 'blocked', lastError: reason, nextRunAt: null, completedAt: null } : {}),
      updatedAt: now,
    }).where(eq(kanbanCards.id, card.id));
    if (failed) await tx.insert(taskLogs).values({
      cardId: card.id, agentId: run.agentId, type: 'retry', status: exhausted ? 'failed' : 'warning',
      message: exhausted ? `${reason}; automatic retries stopped; operator action required.` : `${reason}; next ${kind} attempt no earlier than ${state[kind]!.nextRunAt}.`,
    });
    return { card, block, reason };
  });
  if (result) {
    const { card, block, reason } = result;
    if (block) {
      await recordStageAction({ cardId: card.id, agentId: run.agentId, actor: { type: 'system', id: 'run-retry' }, fromStatus: card.columnStatus, toStatus: 'blocked', action: 'block', detail: reason, logStatus: 'failed' });
      await notify({ companyId: card.companyId, type: 'card_blocked', title: `Task blocked: ${card.title}`, body: reason, entityType: 'card', entityId: card.id, cardId: card.id });
    }
    publishLiveEvent({ type: 'card.updated', companyId: card.companyId, cardId: card.id, entityType: 'card', entityId: card.id });
  }
  return true;
}
