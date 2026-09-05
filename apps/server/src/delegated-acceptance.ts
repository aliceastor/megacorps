import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, cardComments, kanbanCards, workProducts, taskRuns } from './db/schema.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
type Card = typeof kanbanCards.$inferSelect;
type Reader = Pick<typeof db, 'select'>;
async function currentDelivery(card: Card, report: typeof cardComments.$inferSelect, reader: Reader) {
  if (report.action !== 'delegate_report' || report.delegationStatus !== 'approved' || !report.parentCommentId) return null;
  const [request] = await reader.select().from(cardComments).where(and(eq(cardComments.id, report.parentCommentId), eq(cardComments.cardId, card.id))).limit(1);
  const runId = (report.metadata as any)?.taskRunId;
  if (request?.reviewerAgentId === request?.assigneeAgentId) return null;
  if (!request || request.action !== 'delegate_request' || request.delegationStatus !== 'approved' || !request.assigneeAgentId || request.assigneeAgentId !== report.agentId || request.assigneeAgentId !== report.assigneeAgentId || request.reviewerAgentId !== report.reviewerAgentId || !runId) return null;
  const [run] = await reader.select().from(taskRuns).where(and(eq(taskRuns.id, runId), eq(taskRuns.companyId, card.companyId), eq(taskRuns.cardId, card.id))).limit(1);
  if (!run || run.kind !== 'message' || run.status !== 'success' || run.agentId !== request.assigneeAgentId || run.messageCommentId !== request.id) return null;
  const members = await reader.select().from(agents).where(eq(agents.companyId, card.companyId));
  if (![request.assigneeAgentId, request.reviewerAgentId].every(id => members.some(a => a.id === id && !a.deletedAt))) return null;
  const rows = await reader.select().from(workProducts).where(and(eq(workProducts.cardId, card.id), eq(workProducts.companyId, card.companyId), eq(workProducts.taskRunId, runId)));
  const products = rows.filter(p => p.agentId === request.assigneeAgentId && p.projectId === (card.projectId ?? null));
  if (!products.length) return null;
  const shape = (row: typeof cardComments.$inferSelect) => [row.id, row.cardId, row.parentCommentId, row.agentId, row.assigneeAgentId, row.reviewerAgentId, row.reviewerScope, row.body, row.metadata];
  const proof = createHash('sha256').update(JSON.stringify([card.companyId, card.projectId, card.assigneeId, shape(request), shape(report), products.sort((a,b) => a.id.localeCompare(b.id))])).digest('hex');
  return { proof, products };
}
/** Called only after successful server review settlement, never from comment input. */
export async function acceptDelegatedDelivery(card: Card, reportId: string) {
  await retryMergeGateWrite(() => db.transaction(async tx => {
    await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
    const [report] = await tx.select().from(cardComments).where(and(eq(cardComments.id, reportId), eq(cardComments.cardId, card.id))).for('update', { noWait: true }).limit(1);
    if (!report) return;
    const current = await currentDelivery(card, report, tx);
    if (current) await tx.update(cardComments).set({ acceptedDelivery: current.proof }).where(eq(cardComments.id, reportId));
  }));
}
export async function acceptedDelegatedProducts(card: Card, reader: Reader = db): Promise<Array<typeof workProducts.$inferSelect>> {
  const reports = await reader.select().from(cardComments).where(and(eq(cardComments.cardId, card.id), eq(cardComments.action, 'delegate_report'), eq(cardComments.delegationStatus, 'approved')));
  const products: Array<typeof workProducts.$inferSelect> = [];
  for (const report of reports) {
    if (!report.acceptedDelivery) continue;
    const current = await currentDelivery(card, report, reader);
    if (current?.proof === report.acceptedDelivery) products.push(...current.products);
  }
  return [...new Map(products.map(p => [p.id, p])).values()];
}
export async function delegatedEvidenceStatus(card: Card, reader: Reader = db) {
  const requests = await reader.select().from(cardComments).where(and(eq(cardComments.cardId, card.id), eq(cardComments.action, 'delegate_request')));
  const reports = await reader.select().from(cardComments).where(and(eq(cardComments.cardId, card.id), eq(cardComments.action, 'delegate_report')));
  const missing: string[] = [];
  for (const request of requests.filter(r => r.delegationStatus !== 'cancelled')) {
    let accepted = false;
    for (const report of reports.filter(r => r.parentCommentId === request.id && r.acceptedDelivery)) {
      const current = await currentDelivery(card, report, reader);
      if (current?.proof === report.acceptedDelivery) { accepted = true; break; }
    }
    if (!accepted) missing.push(request.id);
  }
  return { ready: !missing.length, missing };
}
