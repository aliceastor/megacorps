import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { approvals, externalWaits, kanbanCards, mergeIntents, projects, reviewRounds } from './db/schema.ts';
import { childCompletionPolicySatisfied } from './dispatch.ts';
import { giteaConfigFromEnv, giteaMergePullRequest, giteaPullRequest } from './gitea.ts';
import { inspectManagedProject, managedMergeTarget } from './managed-project-policy.ts';

const ACTIVE = ['in_flight', 'uncertain', 'accepted'];
export const MERGE_ATTEMPT_MAX = 3;
/** A prepared intent is written in the same transaction as the exact-head wait.
 * The irreversible boundary is the committed claim, before the network request.
 * All gate writers join the card row lock using migration 22's DB fence.
 */
export async function executeAuthorizedMerge(waitId: string, options: { fetchImpl?: typeof fetch } = {}): Promise<boolean> {
  const [original] = await db.select().from(mergeIntents).where(eq(mergeIntents.waitId, waitId)).limit(1);
  if (!original || !['prepared', 'retryable', 'uncertain', 'in_flight'].includes(original.state)) return false;
  if (original.attemptCount >= MERGE_ATTEMPT_MAX || (original.lastAttemptAt && Date.now() - original.lastAttemptAt.getTime() < 30_000)) return false;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, original.projectId), isNull(projects.deletedAt))).limit(1);
  const config = giteaConfigFromEnv();
  const target = project && managedMergeTarget(project, config);
  if (!project || !target || !config || `${target.org}/${target.repo}` !== original.repoFullName || (project.defaultBranch ?? 'main') !== original.defaultBranch) return false;
  const readiness = await inspectManagedProject(project, options);
  if (!readiness.ready) {
    await db.update(projects).set({ mergeReadiness: readiness }).where(eq(projects.id, project.id));
    return false;
  }
  const number = await db.select().from(externalWaits).where(eq(externalWaits.id, waitId)).limit(1).then(([wait]) => /^\d+$/.test(wait?.externalId ?? '') ? Number(wait!.externalId) : null);
  if (!number) return false;
  // Provider drift is handled by merge-gate's reconciliation; never adopt its
  // new head or trust a changed PR base as a fresh authorization.
  let pull;
  try { pull = await giteaPullRequest(config, target.org, target.repo, number, options.fetchImpl); } catch { return false; }
  if (pull?.state !== 'open' || pull.merged !== false || pull.head?.sha !== original.headSha || pull.base?.ref !== original.defaultBranch) return false;
  const claimed = await db.transaction(async (tx) => {
    const [card] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, original.cardId)).for('update').limit(1);
    const [intent] = await tx.select().from(mergeIntents).where(eq(mergeIntents.id, original.id)).limit(1);
    const [wait] = await tx.select().from(externalWaits).where(eq(externalWaits.id, waitId)).limit(1);
    const [freshProject] = await tx.select().from(projects).where(eq(projects.id, original.projectId)).limit(1);
    if (!card || !intent || !wait || !freshProject || card.deletedAt || freshProject.deletedAt || card.columnStatus !== 'waiting_on_external' || card.projectId !== intent.projectId || card.mergeGateVersion !== intent.gateVersion ||
      wait.status !== 'waiting' || wait.cardId !== card.id || wait.authorizedHeadSha !== intent.headSha || wait.externalId !== String(number) || wait.provider !== 'gitea' ||
      !managedMergeTarget(freshProject, config) || freshProject.managedRepoFullName !== intent.repoFullName || (freshProject.defaultBranch ?? 'main') !== intent.defaultBranch ||
      intent.attemptCount !== original.attemptCount || intent.state !== original.state) return null;
    const decisions = await tx.select().from(approvals).where(eq(approvals.cardId, card.id)).orderBy(desc(approvals.createdAt));
    const human = decisions.find((approval) => (approval.payload as { humanGate?: boolean } | null)?.humanGate === true);
    const rounds = await tx.select().from(reviewRounds).where(eq(reviewRounds.cardId, card.id));
    const children = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, card.id), isNull(kanbanCards.deletedAt)));
    if (decisions.some((approval) => approval.status === 'pending') || (card.requiresApproval && human?.status !== 'approved') || rounds.some((round) => ['open', 'closing'].includes(round.status)) || !childCompletionPolicySatisfied(card, children)) return null;
    const [row] = await tx.update(mergeIntents).set({ state: 'in_flight', attemptCount: intent.attemptCount + 1, lastAttemptAt: new Date(), lastResult: 'Exact-head merge request may be in flight; gate changes cannot guarantee cancellation.' }).where(eq(mergeIntents.id, intent.id)).returning();
    return row;
  });
  if (!claimed) return false;
  let state = 'uncertain', lastResult = 'Provider response unknown. Reconciliation will inspect this same intent before any bounded retry.';
  try {
    const status = await giteaMergePullRequest(config, target.org, target.repo, number, claimed.headSha, options.fetchImpl);
    state = status >= 200 && status < 300 ? 'accepted' : 'retryable';
    lastResult = state === 'accepted' ? 'Provider accepted the request; awaiting verified PR/head/base reconciliation.' : `Gitea HTTP ${status}: merge was not confirmed. Checks, permissions, mergeability or head drift require reconciliation; force merge is disabled.`;
  } catch { /* Includes network loss and unavailable provider: do not assume rejection. */ }
  // A webhook may already have resolved this intent while POST was in flight.
  await db.update(mergeIntents).set({ state, lastResult }).where(and(eq(mergeIntents.id, claimed.id), eq(mergeIntents.state, 'in_flight'), eq(mergeIntents.attemptCount, claimed.attemptCount)));
  return true;
}

/** Called only with provider-verified terminal PR state, under the card lock.
 * Clearing the fence and closing the wait must share the caller transaction.
 */
export async function settleMergeIntent(tx: Pick<typeof db, 'select' | 'update'>, waitId: string, head: string, state: 'verified' | 'drift' | 'closed'): Promise<void> {
  const intents = await tx.select().from(mergeIntents).where(eq(mergeIntents.waitId, waitId));
  for (const intent of intents) if (intent.headSha === head && (ACTIVE.includes(intent.state) || ['prepared', 'retryable'].includes(intent.state))) {
    await tx.update(mergeIntents).set({ state, lastResult: `Provider verification: ${state}.` }).where(eq(mergeIntents.id, intent.id));
  }
}
