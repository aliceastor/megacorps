import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { approvals, kanbanCards, taskRuns } from './db/schema.ts';
import { acceptedDescendantEvidence } from './delivery-acceptance.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { delegatedEvidenceStatus } from './delegated-acceptance.ts';

type Card = typeof kanbanCards.$inferSelect;
/** Compare the authority that produced a result, including the original run. */
export function completionCondition(card: Card, taskRunId?: string | null) {
  const same = (column: any, value: unknown) => value == null ? isNull(column) : eq(column, value);
  return and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt),
    same(kanbanCards.columnStatus, card.columnStatus), same(kanbanCards.assigneeId, card.assigneeId),
    same(kanbanCards.reviewerId, card.reviewerId), same(kanbanCards.projectId, card.projectId),
    same(kanbanCards.requiresApproval, card.requiresApproval),
    same(kanbanCards.executionLockId, card.executionLockId), same(kanbanCards.activeHeartbeatRunId, card.activeHeartbeatRunId),
    taskRunId ? sql`EXISTS (SELECT 1 FROM ${taskRuns} WHERE ${taskRuns.id} = ${taskRunId} AND ${taskRuns.cardId} = ${card.id} AND ${taskRuns.status} IN ('queued', 'running'))` : undefined,
    sql`NOT EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.cardId} = ${card.id} AND ${approvals.status} = 'pending' AND ${approvals.type} = 'task_review' AND ${approvals.payload}->>'humanGate' = 'true')`);
}

export async function completionStillCurrent(card: Card, taskRunId?: string | null): Promise<boolean> {
  if (['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '')) return false;
  const [current] = await db.select().from(kanbanCards).where(completionCondition(card, taskRunId)).limit(1);
  return Boolean(current);
}

export async function guardedCompletionUpdate(card: Card, values: Partial<typeof kanbanCards.$inferInsert>, taskRunId?: string | null): Promise<Card | undefined> {
  if (['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '')) return undefined;
  return retryMergeGateWrite(() => db.transaction(async (tx) => {
    await tx.select({ id: kanbanCards.id }).from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
    if (taskRunId) await tx.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).for('update').limit(1);
    if (values.columnStatus === 'done') {
      if (!(await delegatedEvidenceStatus(card, tx)).ready) return undefined;
      const descendants = await acceptedDescendantEvidence(card, tx, true);
      if (descendants.issues.length || (descendants.requiredCount && !descendants.ready)) return undefined;
    }
    const [updated] = await tx.update(kanbanCards).set(values).where(completionCondition(card, taskRunId)).returning();
    return updated;
  }));
}
