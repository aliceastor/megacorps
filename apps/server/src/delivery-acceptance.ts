import { createHash } from 'node:crypto';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { approvals, companies, externalWaits, kanbanCards, mergeIntents, projects, reviewRounds, workProducts } from './db/schema.ts';
import { panelRequired } from './review-panel.ts';
import { acceptedDelegatedProducts, delegatedEvidenceStatus } from './delegated-acceptance.ts';

type Card = typeof kanbanCards.$inferSelect;
type Product = typeof workProducts.$inferSelect;
export type DeliveryAcceptance = { version: 1; assignment: string; evidence: string; productIds: string[]; acceptedAt: string; mergeWaitId: string | null; authorizedHeadSha: string | null; inherited?: boolean };
type Reader = Pick<typeof db, 'select'>;
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function hash(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex'); }
function assignment(card: Card) {
  return hash([card.id, card.companyId, card.projectId, card.parentCardId, card.title, card.body, card.assigneeId, card.reviewerId, card.requiresApproval, card.reviewMode, card.critical, card.decisionMode, card.coordinationOnly, card.requiredChildPolicy, card.childRequirementLevel, card.dependencyCardIds, card.tags]);
}
function evidence(products: Product[]) { return hash([...products].sort((a,b) => a.id.localeCompare(b.id))); }
async function productsFor(card: Card, reader: Reader) {
  const rows = await reader.select().from(workProducts).where(and(eq(workProducts.cardId, card.id), eq(workProducts.companyId, card.companyId)));
  return uniqueProducts([...rows.filter(p => p.projectId === (card.projectId ?? null) && p.agentId === card.assigneeId), ...await acceptedDelegatedProducts(card, reader)]);
}
async function requiredGatesPassed(card: Card, reader: Reader) {
  if (!(await delegatedEvidenceStatus(card, reader)).ready) return false;
  const [pending, rounds] = await Promise.all([
    reader.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.status, 'pending'))),
    reader.select().from(reviewRounds).where(eq(reviewRounds.cardId, card.id)),
  ]);
  if (pending.length || rounds.some(r => ['open', 'closing'].includes(r.status))) return false;
  const accepted = await reader.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.status, 'approved')));
  if (card.requiresApproval) {
    if (!accepted.length) return false;
  }
  const [company] = await reader.select().from(companies).where(eq(companies.id, card.companyId)).limit(1);
  if (panelRequired(card, company?.panelReviewDefault ?? null)) {
    const clientDecision = accepted.some(a => a.decidedByUserId && (a.payload as any)?.humanGate === true);
    if (!clientDecision && !rounds.some(r => r.status === 'closed' && r.decision === 'approved')) return false;
  }
  return true;
}
async function verifiedMerge(card: Card, reader: Reader, waitId?: string | null) {
  const [project] = card.projectId ? await reader.select().from(projects).where(and(eq(projects.id, card.projectId), eq(projects.companyId, card.companyId))).limit(1) : [];
  if (!project?.completionRequiresMerge) return { mergeWaitId: null, authorizedHeadSha: null };
  const waits = await reader.select().from(externalWaits).where(and(eq(externalWaits.cardId, card.id), eq(externalWaits.companyId, card.companyId), eq(externalWaits.status, 'success')));
  const wait = waits.find(w => (!waitId || w.id === waitId) && /^[a-f0-9]{40}$/i.test(w.authorizedHeadSha ?? '') && w.provider === 'gitea');
  if (!wait) return null;
  if (project.autoMergeAfterApproval) {
    const intents = await reader.select().from(mergeIntents).where(and(eq(mergeIntents.cardId, card.id), eq(mergeIntents.waitId, wait.id)));
    if (!intents.some(i => i.state === 'verified' && i.headSha === wait.authorizedHeadSha && i.projectId === card.projectId)) return null;
  }
  return { mergeWaitId: wait.id, authorizedHeadSha: wait.authorizedHeadSha };
}

/** Mint only at an accepted server completion boundary, never from reported metadata. */
export async function captureDeliveryAcceptance(card: Card, reader: Reader = db): Promise<DeliveryAcceptance | null> {
  const descendants = await acceptedDescendantEvidence(card, reader);
  if (descendants.issues.length || (descendants.requiredCount && !descendants.ready)) return null;
  const inherited = descendants.ready;
  const products = uniqueProducts([...(await productsFor(card, reader)), ...descendants.products]);
  if (!products.length || !(await requiredGatesPassed(card, reader))) return null;
  const merge = inherited ? { mergeWaitId: null, authorizedHeadSha: null } : await verifiedMerge(card, reader);
  if (!merge) return null;
  return { version: 1, assignment: assignment(card), evidence: evidence(products), productIds: products.map(p => p.id), acceptedAt: new Date().toISOString(), inherited, ...merge };
}

export async function acceptedCardProducts(card: Card, reader: Reader = db, inheritedProducts: Product[] = []): Promise<Product[] | null> {
  const proof = card.deliveryAcceptance;
  if (card.columnStatus !== 'done' || card.deletedAt || !proof || proof.version !== 1 || proof.assignment !== assignment(card) || !(await requiredGatesPassed(card, reader))) return null;
  const products = uniqueProducts([...(await productsFor(card, reader)), ...(proof.inherited ? inheritedProducts : [])]);
  if (!products.length || proof.evidence !== evidence(products)) return null;
  const merge = proof.inherited && inheritedProducts.length ? { mergeWaitId: null, authorizedHeadSha: null } : await verifiedMerge(card, reader, proof.mergeWaitId);
  if (!merge || merge.authorizedHeadSha !== proof.authorizedHeadSha) return null;
  return products;
}

export async function sealDeliveryAcceptance(cardId: string): Promise<void> {
  // Keep PostgreSQL's full timestamp precision; the Date column mapper truncates
  // microseconds and raw Date parameters bypass Drizzle's timestamp encoder.
  const [card] = await db.select({ ...getTableColumns(kanbanCards), acceptanceUpdatedAt: sql<string | null>`${kanbanCards.updatedAt}::text` }).from(kanbanCards).where(and(eq(kanbanCards.id, cardId), eq(kanbanCards.columnStatus, 'done'), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) return;
  const deliveryAcceptance = await captureDeliveryAcceptance(card);
  if (!deliveryAcceptance) return;
  await db.update(kanbanCards).set({ deliveryAcceptance }).where(and(eq(kanbanCards.id, card.id), eq(kanbanCards.columnStatus, 'done'), sql`${kanbanCards.assigneeId} IS NOT DISTINCT FROM ${card.assigneeId}`, sql`${kanbanCards.reviewerId} IS NOT DISTINCT FROM ${card.reviewerId}`, sql`${kanbanCards.projectId} IS NOT DISTINCT FROM ${card.projectId}`, sql`${kanbanCards.body} IS NOT DISTINCT FROM ${card.body}`, sql`${kanbanCards.updatedAt} IS NOT DISTINCT FROM ${card.acceptanceUpdatedAt}`));
}

function uniqueProducts(products: Product[]) { return [...new Map(products.map(p => [p.id, p])).values()]; }
/** Read-only by default. Guarded completion may lock descendants NOWAIT inside
 * its own retried DB transaction; this helper never performs provider I/O. */
export async function acceptedDescendantEvidence(parent: Card, reader: Reader = db, lock = false) {
  const issues: string[] = [];
  const visited = new Set([parent.id]);
  const tree = new Map<string, Card[]>();
  let requiredCount = 0;
  async function loadTree(card: Card): Promise<void> {
    let query = reader.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, card.id), isNull(kanbanCards.deletedAt))).orderBy(kanbanCards.id);
    const children = await (lock ? query.for('update', { noWait: true }) : query);
    const valid: Card[] = [];
    for (const child of children) {
      if (visited.has(child.id) || visited.size > 500) { issues.push('Child tree cycle or evidence scan limit reached.'); continue; }
      visited.add(child.id);
      if (child.companyId !== parent.companyId || child.projectId !== parent.projectId) { issues.push(`Child ${child.id} has a different company or project.`); continue; }
      valid.push(child);
      await loadTree(child);
    }
    tree.set(card.id, valid);
  }
  async function visit(card: Card): Promise<Product[]> {
    const products: Product[] = [];
    for (const child of tree.get(card.id) ?? []) {
      const descendantProducts = await visit(child);
      if ((child.childRequirementLevel ?? 'required') === 'required' || (card.requiredChildPolicy === 'all_non_cancelled_accepted' && child.columnStatus !== 'cancelled') || (card.requiredChildPolicy === 'threshold' && child.columnStatus === 'done')) {
        requiredCount++;
        const accepted = await acceptedCardProducts(child, reader, descendantProducts);
        if (!accepted) issues.push(`Child ${child.id} (${child.title}) lacks current server-accepted evidence or has an incomplete required gate.`);
        else products.push(...accepted);
      }
      products.push(...descendantProducts);
    }
    return uniqueProducts(products);
  }
  // All relevant card locks are acquired before evidence/gate reads. New child
  // insertion fences its parent through the existing merge-card trigger.
  await loadTree(parent);
  const products = await visit(parent);
  return { ready: requiredCount > 0 && issues.length === 0, requiredCount, products: issues.length ? [] : products, issues };
}
