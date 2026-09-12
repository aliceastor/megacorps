import { createHash } from 'node:crypto';
import type { AgentReport } from '@megacorps/shared';
import type { kanbanCards, workProducts } from './db/schema.ts';
type Card = typeof kanbanCards.$inferSelect;
type Product = typeof workProducts.$inferSelect;
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function childScope(card: Card) {
  return [card.id, card.companyId, card.projectId, card.parentCardId, card.title, card.body, card.assigneeId, card.reviewerId, card.requiresApproval, card.reviewMode, card.critical, card.reviewerIds, card.decisionMode, card.coordinationOnly, card.requiredChildPolicy, card.childRequirementLevel, card.dependencyCardIds, card.tags, card.splitRound, card.revisionCount, card.reviewIdentity];
}
/** Eligibility is deliberately single-child only. This fingerprint is evidence
 * identity, never an approval: the reviewer must explicitly approve this token. */
export function snapshotAssessmentCoverage(parent: Card, children: Card[], products: Product[]): string | null {
  const child = children[0];
  if (children.length !== 1 || !child || !products.length || !parent.body?.trim() || !child.body?.trim()) return null;
  if (parent.dependencyCardIds?.length || parent.reviewerIds?.length || parent.recurEveryMinutes) return null;
  if (parent.deletedAt || child.deletedAt || parent.requiresApproval || parent.reviewerId || parent.critical || parent.reviewMode === 'panel' || parent.requiredChildPolicy === 'manual') return null;
  if (!parent.assigneeId || child.reviewerId !== parent.assigneeId || child.assigneeId === parent.assigneeId || !child.assigneeId || child.parentCardId !== parent.id || child.companyId !== parent.companyId || child.projectId !== parent.projectId || (child.childRequirementLevel ?? 'required') !== 'required') return null;
  // Child completion increments the parent's fence; that is expected, while
  // live gates and acceptance are independently rechecked under card locks.
  const { mergeGateVersion: _fence, ...parentScope } = parent;
  return digest([parentScope, childScope(child), [...products].sort((a, b) => a.id.localeCompare(b.id))]);
}
export type ParentAssessmentCapture = { version: 1; token: string; parentId: string; childId: string; reviewerId: string; prompt: string };
export type ParentAssessmentReceipt = Omit<ParentAssessmentCapture, 'prompt'> & { summary: string; reviewOutputHash: string };
/** Call only at the accepted server review boundary, never for reported fields
 * received from authors or rejected / incomplete review turns. */
export function receiptFromParentAssessment(capture: ParentAssessmentCapture | null, report: AgentReport | null | undefined, output: string): ParentAssessmentReceipt | null {
  const assessment = report?.parentAssessment;
  if (!capture || report?.verdict !== 'approved' || report.status !== 'completed' || assessment?.verdict !== 'approved' || assessment.token !== capture.token) return null;
  const { prompt: _prompt, ...identity } = capture;
  return { ...identity, summary: assessment.summary, reviewOutputHash: digest(output) };
}
export function reviewOutputMatches(receipt: ParentAssessmentReceipt, output: string | null) { return Boolean(output && receipt.reviewOutputHash === digest(output)); }
