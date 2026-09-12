import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { activityLog, agents, approvals, companies, kanbanCards, positions, taskRuns, workProducts } from './db/schema.ts';
import { acceptedDescendantEvidence, captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { acceptedDelegatedProducts } from './delegated-acceptance.ts';
import { completionCondition } from './completion-guard.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import { panelRequired } from './review-panel.ts';
import { snapshotAssessmentCoverage, reviewOutputMatches, type ParentAssessmentCapture, type ParentAssessmentReceipt } from './assessment-reuse.ts';
type Card = typeof kanbanCards.$inferSelect;
type Reader = Pick<typeof db, 'select'>;
async function bossOwns(parent: Card, reader: Reader) {
  if (!parent.assigneeId) return false;
  const [agent] = await reader.select().from(agents).where(and(eq(agents.id, parent.assigneeId), eq(agents.companyId, parent.companyId), isNull(agents.deletedAt))).limit(1);
  if (!agent?.positionId || agent.isActive === false) return false;
  const [position] = await reader.select().from(positions).where(and(eq(positions.id, agent.positionId), eq(positions.companyId, parent.companyId))).limit(1);
  return Boolean(position?.isCompanyBoss && position.isActive !== false);
}
async function idleParent(parent: Card, reader: Reader) {
  if (parent.columnStatus !== 'in_progress' || parent.rollupStatus !== 'waiting_on_children' || parent.executionLockId || parent.activeHeartbeatRunId) return false;
  const [company] = await reader.select().from(companies).where(eq(companies.id, parent.companyId)).limit(1);
  if (!company || panelRequired(parent, company.panelReviewDefault)) return false;
  const [runs, ownProducts, pending] = await Promise.all([
    reader.select().from(taskRuns).where(and(eq(taskRuns.cardId, parent.id), inArray(taskRuns.status, ['queued', 'running']))).limit(1),
    reader.select().from(workProducts).where(eq(workProducts.cardId, parent.id)).limit(1),
    reader.select().from(approvals).where(and(eq(approvals.cardId, parent.id), eq(approvals.status, 'pending'))).limit(1),
  ]);
  return !runs.length && !ownProducts.length && !pending.length && await bossOwns(parent, reader);
}
/** Snapshot before the review model runs. The prompt asks for an explicit
 * additional assessment, not implicit equivalence of department and root scope. */
export async function captureParentAssessment(child: Card, reviewerId: string): Promise<ParentAssessmentCapture | null> {
  if (!child.parentCardId || child.reviewerId !== reviewerId) return null;
  const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, child.parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!parent || parent.assigneeId !== reviewerId || !await idleParent(parent, db)) return null;
  const children = await db.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, parent.id), isNull(kanbanCards.deletedAt)));
  const currentChild = children.find(row => row.id === child.id);
  if (!currentChild) return null;
  const descendants = await acceptedDescendantEvidence(currentChild);
  if (descendants.issues.length) return null;
  const own = await db.select().from(workProducts).where(and(eq(workProducts.cardId, child.id), eq(workProducts.companyId, child.companyId)));
  const products = [...new Map([...own.filter(p => p.agentId === currentChild.assigneeId && p.projectId === currentChild.projectId), ...await acceptedDelegatedProducts(currentChild), ...descendants.products].map(p => [p.id, p])).values()];
  const token = snapshotAssessmentCoverage(parent, children, products);
  if (!token || parent.body.length > 12000 || parent.title.length > 500) return null;
  return { version: 1, token, parentId: parent.id, childId: child.id, reviewerId,
    prompt: `Combined parent goal assessment (optional; original reviewer authority and all gates remain):\nParent card ${parent.id}: ${parent.title}\n${parent.body}\nAssess whether the original child artifacts and cited reviewer checks also satisfy this entire parent goal. Preserve limitations; do not repeat professional QA or author a replacement deliverable. If evidence is sufficient, include parentAssessment: {"token":"${token}","verdict":"approved","summary":"Cite original products and actual reviewer checks covering the parent criteria; include limitations"} in your completed approved megacorps-report. If coverage is missing use verdict revision_requested or omit parentAssessment. Approval authorizes reuse of this one goal assessment only while scope, authors, artifacts and gates remain current.` };
}
/** SQL-only, bounded transaction. Returns a completed card only after current
 * server acceptance validates; otherwise the normal owner assessment proceeds.
 * No adapter invocation, score, product, or synthetic task-run is produced. */
export async function tryReuseParentAssessment(parentId: string): Promise<Card | null> {
  return retryMergeGateWrite(() => db.transaction(async tx => {
    const [parent] = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id, parentId), isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!parent || !await idleParent(parent, tx)) return null;
    const evidence = await acceptedDescendantEvidence(parent, tx, true);
    if (!evidence.ready) return null;
    const children = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, parent.id), isNull(kanbanCards.deletedAt)));
    const token = snapshotAssessmentCoverage(parent, children, evidence.products);
    const child = children[0];
    if (!token || !child) return null;
    const activities = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, parent.companyId), eq(activityLog.entityType, 'card'), eq(activityLog.entityId, child.id), eq(activityLog.actorType, 'agent'), eq(activityLog.actorId, parent.assigneeId!), eq(activityLog.action, 'review.approved'))).orderBy(desc(activityLog.createdAt)).limit(1);
    const receipt = (activities[0]?.details as { parentAssessment?: ParentAssessmentReceipt } | null)?.parentAssessment;
    if (!receipt || receipt.version !== 1 || receipt.token !== token || receipt.parentId !== parent.id || receipt.childId !== child.id || receipt.reviewerId !== parent.assigneeId || !receipt.summary?.trim() || !reviewOutputMatches(receipt, child.reviewFeedback)) return null;
    const acceptance = await captureDeliveryAcceptance(parent, tx);
    if (!acceptance) return null;
    const [updated] = await tx.update(kanbanCards).set({ columnStatus: 'done', rollupStatus: 'done', completedAt: new Date(), updatedAt: new Date(), nextRunAt: null, lastError: null }).where(completionCondition(parent)).returning();
    if (!updated || updated.columnStatus !== 'done') return null;
    // The status-change trigger clears receipts. Mint after the transition in
    // this same transaction so completion, valid acceptance and audit commit together.
    const [sealed] = await tx.update(kanbanCards).set({ deliveryAcceptance: acceptance }).where(eq(kanbanCards.id, updated.id)).returning();
    await tx.insert(activityLog).values({companyId:parent.companyId,actorType:'system',actorId:'cascade',agentId:parent.assigneeId,action:'parent.assessment_reused',entityType:'card',entityId:parent.id,details:{childId:child.id,reviewerId:receipt.reviewerId,sourceActivityId:activities[0]!.id,token,summary:receipt.summary,acceptedProductIds:evidence.products.map(p=>p.id)}});
    return sealed ?? null;
  }));
}
