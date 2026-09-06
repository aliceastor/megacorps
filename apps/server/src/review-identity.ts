import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { kanbanCards, taskRuns } from './db/schema.ts';
import { completionCondition } from './completion-guard.ts';
import { resolveMergeEvidence, type MergeGatePlan } from './merge-gate.ts';

type Card = typeof kanbanCards.$inferSelect;
type Resolved = Extract<MergeGatePlan, { disposition: 'wait' }>;
export type ReviewIdentity = {
  id: string; scope: string; projectId: string; repoUrl: string;
  defaultBranch: string; headSha: string; externalId: string;
  candidateKey: string; capturedAt: string;
};
const candidateKey = (plan: Resolved) => JSON.stringify([plan.candidate.kind, plan.candidate.workProductId ?? null, plan.candidate.pullRequestNumber ?? null, plan.candidate.pullRequestUrl ?? null, plan.candidate.branch ?? null, plan.candidate.headSha ?? null]);
export function reviewIdentityMatches(identity: ReviewIdentity, plan: Resolved): boolean {
  return identity.projectId === plan.project.id && identity.repoUrl === plan.project.repoUrl && identity.defaultBranch === plan.defaultBranch && identity.headSha === plan.headSha && identity.externalId === plan.externalId && identity.candidateKey === candidateKey(plan);
}
export function reviewIdentityContext(identity: ReviewIdentity | null | undefined): string {
  return identity ? `\nReview evidence identity (approval applies only to this snapshot):\nRepository: ${identity.repoUrl}\nPR / ref: ${identity.externalId}\nBase: ${identity.defaultBranch}\nFull reviewed head: ${identity.headSha}\nIdentity: ${identity.id}\nInspect this exact head. A changed head requires a new review.\n` : '';
}

/** Same attempt resumes its stored identity; a retry cannot adopt a newer head. */
export async function beginReviewIdentity(card: Card, scope: string, options: { taskRunId?: string | null; fetchImpl?: typeof fetch; humanGate?: boolean } = {}): Promise<ReviewIdentity | null> {
  const [original] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
  if (!original || ['done', 'cancelled'].includes(original.columnStatus ?? '')) return null;
  const [run] = options.taskRunId ? await db.select().from(taskRuns).where(eq(taskRuns.id, options.taskRunId)).limit(1) : [];
  const stored = run?.reviewIdentity ?? (original.reviewIdentity?.scope === scope ? original.reviewIdentity : null);
  const plan = await resolveMergeEvidence(original, options);
  if (plan.disposition !== 'wait') return stored ?? null;
  if (stored) {
    if (options.taskRunId && !run?.reviewIdentity) await db.transaction(async tx => {
      const [fresh] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
      await tx.select().from(taskRuns).where(eq(taskRuns.id, options.taskRunId!)).for('update').limit(1);
      const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(card, options.taskRunId, options.humanGate)).limit(1);
      if (authorized && fresh?.reviewIdentity?.id === stored.id) await tx.update(taskRuns).set({ reviewIdentity: stored }).where(and(eq(taskRuns.id, options.taskRunId!), isNull(taskRuns.reviewIdentity)));
    });
    return stored;
  }
  const identity: ReviewIdentity = { id: randomUUID(), scope, projectId: plan.project.id, repoUrl: plan.project.repoUrl!, defaultBranch: plan.defaultBranch, headSha: plan.headSha, externalId: plan.externalId, candidateKey: candidateKey(plan), capturedAt: new Date().toISOString() };
  return db.transaction(async tx => {
    const [fresh] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
    const [activeRun] = options.taskRunId ? await tx.select().from(taskRuns).where(eq(taskRuns.id, options.taskRunId)).for('update').limit(1) : [];
    if (activeRun?.reviewIdentity) return activeRun.reviewIdentity;
    if (!fresh || fresh.mergeGateVersion !== original.mergeGateVersion) return null;
    const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(card, options.taskRunId, options.humanGate)).limit(1);
    if (!authorized) return null;
    await tx.update(kanbanCards).set({ reviewIdentity: identity }).where(eq(kanbanCards.id, card.id));
    if (options.taskRunId) await tx.update(taskRuns).set({ reviewIdentity: identity }).where(and(eq(taskRuns.id, options.taskRunId), isNull(taskRuns.reviewIdentity)));
    return identity;
  });
}
