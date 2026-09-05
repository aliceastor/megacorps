import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { cardComments, kanbanCards } from './db/schema.ts';
import { companyStructure } from './company-workflow.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { guardedCompletionUpdate } from './completion-guard.ts';

type Card = typeof kanbanCards.$inferSelect;
type Comment = typeof cardComments.$inferSelect;
export async function blockDelegatedAssignment(card: Card, requestId: string, reason: string) {
  reason = await sanitizeCompanyOutput(card.companyId, reason);
  await retryMergeGateWrite(() => db.update(cardComments).set({ delegationStatus: 'failed' }).where(eq(cardComments.id, requestId)));
  const [current] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).limit(1);
  if (current) await guardedCompletionUpdate(current, { columnStatus: 'blocked', lastError: reason, completedAt: null, updatedAt: new Date() });
}
export async function routeDelegatedQuestion(card: Card, request: Comment, actorId: string | null, runId: string, question: string) {
  const structure = await companyStructure(card.companyId);
  const actor = structure.members.find(a => a.id === actorId);
  const responsibleId = [request.reviewerAgentId, structure.divisions.find(d => d.id === actor?.departmentId)?.headAgentId, actor?.bossId, structure.bosses[0]?.id].find(id => id && id !== actorId && structure.members.some(a => a.id === id && a.isActive !== false));
  if (!responsibleId) {
    await blockDelegatedAssignment(card, request.id, 'delegated_help_recipient_unavailable: Assign an active responsible head or manager to answer this delegated question.');
    return null;
  }
  const body = await sanitizeCompanyOutput(card.companyId, question);
  return retryMergeGateWrite(() => db.transaction(async tx => {
    await tx.select().from(cardComments).where(eq(cardComments.id, request.id)).for('update').limit(1);
    const prior = await tx.select().from(cardComments).where(and(eq(cardComments.parentCommentId, request.id), eq(cardComments.action, 'agent_question')));
    const existing = prior.find(row => (row.metadata as Record<string, unknown> | null)?.helpRunId === runId);
    if (existing) return existing;
    const [row] = await tx.insert(cardComments).values({ cardId: card.id, parentCommentId: request.id, agentId: actorId, action: 'agent_question', authorType: 'agent', body, assigneeAgentId: responsibleId, delegationStatus: 'queued', metadata: { helpRunId: runId, helpRequestId: request.id, originalAssigneeId: actorId } }).returning();
    await tx.update(cardComments).set({ delegationStatus: 'waiting' }).where(eq(cardComments.id, request.id));
    return row;
  }));
}

/** Claim once using the question row; ownership/thread changes invalidate it. */
export async function resumeDelegatedQuestion(question: Comment): Promise<Comment | null> {
  const metadata = question.metadata as Record<string, unknown> | null;
  if (!metadata?.helpRequestId || typeof metadata.originalAssigneeId !== 'string') return null;
  return retryMergeGateWrite(() => db.transaction(async tx => {
    const [request] = await tx.select().from(cardComments).where(and(eq(cardComments.id, String(metadata.helpRequestId)), eq(cardComments.cardId, question.cardId))).for('update').limit(1);
    if (!request || request.assigneeAgentId !== metadata.originalAssigneeId || request.delegationStatus !== 'waiting') return null;
    const [claimed] = await tx.update(cardComments).set({ delegationStatus: 'done' }).where(and(eq(cardComments.id, question.id), eq(cardComments.delegationStatus, 'queued'))).returning();
    if (!claimed) return null;
    const [resumed] = await tx.update(cardComments).set({ delegationStatus: 'queued' }).where(eq(cardComments.id, request.id)).returning();
    return resumed ?? null;
  }));
}
