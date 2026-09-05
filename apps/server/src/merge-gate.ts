// Merge closure, exact head only (company pipeline design §19).
//
// The bundled Gitea is the version control of every project, so "merged into
// the default branch" is the real end of a card. When a project turns on
// completion_requires_merge, an approved card does not finish: it parks on
// waiting_on_external with the exact head SHA the review authorized. Only that
// head landing on the default branch closes the card. A different head — new
// commits pushed after approval, or a merge of something else — is drift: the
// authorization is void and the card goes back to review.
//
// The top half is pure and unit tested; the bottom half is the database glue
// used by the three approval sites and by the Gitea webhook receiver. Nothing
// here runs at load time.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from './db/client.ts';
import { activityLog, cardComments, externalEvents, externalWaits, kanbanCards, mergeIntents, projects, taskLogs, taskRuns, workProducts } from './db/schema.ts';
import { executeAuthorizedMerge, settleMergeIntent } from './authorized-merge.ts';
import { managedMergeTarget } from './managed-project-policy.ts';
import { recordStageAction, type CardActionActor } from './card-actions.ts';
import { publishLiveEvent } from './live.ts';
import { giteaBranchContainsCommit, giteaConfigFromEnv, giteaPullRequest, giteaResolveCommit, giteaSlug } from './gitea.ts';
import { normalizeAgentResult } from './agent-results.ts';
import { pollDecision, EXTERNAL_POLL_MAX } from './external-polling.ts';
import { applyExternalEvent, rootCardId } from './external-events.ts';
import { enqueueTaskRun } from './dispatch.ts';
import { openPanelRound, panelRequiredForCard } from './review-rounds.ts';
import { completionCondition, completionStillCurrent, guardedCompletionUpdate } from './completion-guard.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type ExternalWaitRow = typeof externalWaits.$inferSelect;

export const MERGE_WAIT_PROVIDER = 'gitea';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type MergeWorkProduct = {
  id?: string | null;
  type?: string | null;
  title?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  pullRequestUrl?: string | null;
  repoUrl?: string | null;
  url?: string | null;
  createdAt?: Date | string | null;
};

export type MergeProject = {
  repoUrl?: string | null;
  defaultBranch?: string | null;
  completionRequiresMerge?: boolean | null;
};

export type MergeCandidate = {
  kind: 'pull_request' | 'branch';
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  branch: string | null;
  headSha: string | null;
  workProductId: string | null;
};

// Gitea PR URLs look like http://host/org/repo/pulls/12; GitHub uses /pull/12.
// Anything else (a commit URL, a branch compare) has no PR number.
export function parsePullRequestNumber(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = /\/pulls?\/(\d+)(?:[/?#]|$)/.exec(url.trim());
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

// `<org>/<repo>` out of any clone/browse URL, host- and case-insensitive, with
// embedded credentials and a trailing .git removed. Returns null when the URL
// does not carry two path segments.
export function repoFullNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Embedded credentials first (http://user:token@host/...), so the colon in
  // them is never mistaken for an scp separator or a port.
  const withoutCredentials = withoutScheme.replace(/^[^/@]*@/, '');
  // scp-style git@host:org/repo.git — but host:3300/org/repo is a port, not a path.
  const scp = /^([^/:]+):([^/]+)(\/.*)$/.exec(withoutCredentials);
  const path = scp && !/^\d+$/.test(scp[2] ?? '')
    ? `${scp[2]}${scp[3]}`
    : withoutCredentials.split('/').slice(1).join('/');
  const segments = stripGitSuffix(path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const org = segments[0];
  const repo = segments[1];
  if (!org || !repo) return null;
  return `${org.toLowerCase()}/${repo.toLowerCase()}`;
}

export function sameRepoFullName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return stripGitSuffix(a.trim()).toLowerCase() === stripGitSuffix(b.trim()).toLowerCase();
}

// The org/repo MegaCorps administers for a project. Falls back to the Gitea
// slug rules so a project whose repoUrl was written by hand still resolves.
export function repoSlugFromProject(project: Pick<MergeProject, 'repoUrl'> | null | undefined): { org: string; repo: string } | null {
  const fullName = repoFullNameFromUrl(project?.repoUrl);
  if (!fullName) return null;
  const [org, repo] = fullName.split('/');
  if (!org || !repo) return null;
  return { org: giteaSlug(org), repo: giteaSlug(repo) };
}

export function normalizeBranchRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.trim().replace(/^refs\/heads\//, '') || null;
}

// Authorization and closure compare full provider-verified SHAs only.
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(left) && left === right;
}

function origin(url: string | null | undefined): string | null {
  try { return new URL(url ?? '').origin.toLowerCase(); } catch { return null; }
}

/** Origins are interchangeable only when configured as this provider's aliases. */
export function mergeRepositoryMatches(url: string, projectUrl: string | null | undefined): boolean {
  if (!projectUrl || repoFullNameFromUrl(url) !== repoFullNameFromUrl(projectUrl)) return false;
  const actual = origin(url), expected = origin(projectUrl);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const config = giteaConfigFromEnv();
  const aliases = config ? [config.apiUrl, config.internalUrl, config.externalUrl].map(origin) : [];
  return aliases.includes(actual) && aliases.includes(expected);
}

function productOnProjectRepo(product: MergeWorkProduct, project: MergeProject): boolean {
  const urls = [product.repoUrl, product.pullRequestUrl, product.type === 'pull_request' ? product.url : null].filter((url): url is string => Boolean(url));
  return urls.every((url) => mergeRepositoryMatches(url, project.repoUrl));
}

function productTime(product: MergeWorkProduct): number {
  const value = product.createdAt;
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

// What this card wants merged: the newest pull request on the project repo,
// otherwise the newest commit/branch that is not already the default branch.
// A work product that only points at the default branch has nothing to merge.
export function selectMergeCandidate(products: MergeWorkProduct[], project: MergeProject | null | undefined): MergeCandidate | null {
  if (!project) return null;
  const defaultBranch = (project.defaultBranch ?? 'main').trim().toLowerCase();
  const relevant = products
    .map((product) => ({ ...product, pullRequestUrl: product.pullRequestUrl || (product.type === 'pull_request' ? product.url : null) }))
    .filter((product) => productOnProjectRepo(product, project))
    .slice()
    .sort((a, b) => productTime(b) - productTime(a));

  const prProduct = relevant.find((product) => parsePullRequestNumber(product.pullRequestUrl) !== null);
  if (prProduct?.pullRequestUrl) {
    const number = parsePullRequestNumber(prProduct.pullRequestUrl);
    const headSha = prProduct.commitSha?.trim()
      || relevant.find((product) => product.pullRequestUrl === prProduct.pullRequestUrl && product.commitSha)?.commitSha?.trim()
      || null;
    return {
      kind: 'pull_request',
      pullRequestUrl: prProduct.pullRequestUrl,
      pullRequestNumber: number,
      branch: normalizeBranchRef(prProduct.branch),
      headSha: headSha || null,
      workProductId: prProduct.id ?? null,
    };
  }

  const branchProduct = relevant.find((product) => {
    const branch = normalizeBranchRef(product.branch);
    if (branch && branch.toLowerCase() === defaultBranch) return false;
    return Boolean(branch || product.commitSha);
  });
  if (!branchProduct) return null;
  const branch = normalizeBranchRef(branchProduct.branch);
  if (!branch && !branchProduct.commitSha) return null;
  return {
    kind: 'branch',
    pullRequestUrl: null,
    pullRequestNumber: null,
    branch,
    headSha: branchProduct.commitSha?.trim() || null,
    workProductId: branchProduct.id ?? null,
  };
}

export type MergeWaitFacts = {
  provider: string | null;
  status: string | null;
  externalId: string | null;
  authorizedHeadSha: string | null;
};

export type MergeEventFacts = {
  kind: 'pull_request' | 'push';
  defaultBranch: string;
  // pull_request
  action?: string | null;
  merged?: boolean | null;
  headSha?: string | null;
  baseRef?: string | null;
  pullRequestNumber?: number | null;
  // push
  ref?: string | null;
  containsAuthorizedHead?: boolean | null;
};

export type MergeVerdict = 'success' | 'drift' | 'failure' | 'ignore';

// The whole exact-head rule in one function so the receiver stays a router.
export function mergeVerdict(input: { wait: MergeWaitFacts; event: MergeEventFacts }): MergeVerdict {
  const { wait, event } = input;
  if (wait.provider !== MERGE_WAIT_PROVIDER) return 'ignore';
  if (wait.status !== 'waiting') return 'ignore';
  const defaultBranch = normalizeBranchRef(event.defaultBranch) ?? 'main';

  if (event.kind === 'push') {
    const branch = normalizeBranchRef(event.ref);
    if (!branch || branch.toLowerCase() !== defaultBranch.toLowerCase()) return 'ignore';
    if (!wait.authorizedHeadSha) return 'ignore';
    return event.containsAuthorizedHead ? 'success' : 'ignore';
  }

  // pull_request: only the wait that authorized this PR may react to it.
  if (wait.externalId && (event.pullRequestNumber == null || String(event.pullRequestNumber) !== wait.externalId)) return 'ignore';
  const action = (event.action ?? '').trim().toLowerCase();
  const closed = action === 'closed' || action === 'merged';
  if (closed && event.merged) {
    const base = normalizeBranchRef(event.baseRef);
    if (!base || base !== defaultBranch) return 'ignore';
    // Every wait the merge gate creates carries an authorized head. A wait
    // without one was made by hand (POST /api/cards/:id/external-waits) and
    // keeps the plain "this pull request merged" meaning.
    if (!wait.authorizedHeadSha) return 'success';
    return sameCommit(wait.authorizedHeadSha, event.headSha) ? 'success' : 'drift';
  }
  if (closed && !event.merged) return 'failure';
  if (action === 'synchronized' || action === 'synchronize') {
    if (!wait.authorizedHeadSha || !event.headSha) return 'ignore';
    return sameCommit(wait.authorizedHeadSha, event.headSha) ? 'ignore' : 'drift';
  }
  return 'ignore';
}

export function mergeAuthorizedMessage(input: { headSha: string; candidate: MergeCandidate; defaultBranch: string }): string {
  const target = input.candidate.kind === 'pull_request'
    ? `pull request ${input.candidate.pullRequestNumber != null ? `#${input.candidate.pullRequestNumber}` : ''}${input.candidate.pullRequestUrl ? ` (${input.candidate.pullRequestUrl})` : ''}`.trim()
    : `branch ${input.candidate.branch ?? 'unknown'}`;
  return [
    `Merge authorized for head ${input.headSha}.`,
    `This card is done only when exactly that commit is merged into ${input.defaultBranch} via ${target}.`,
    'Pushing another commit to it after this point voids the authorization and reopens review.',
  ].join(' ');
}

export function mergeDriftMessage(input: { authorized: string | null; observed: string | null; reason: string }): string {
  return [
    `Merge authorization void: head drifted from ${input.authorized ?? 'unknown'} to ${input.observed ?? 'unknown'}.`,
    input.reason,
    'The card is back in review so the new head can be authorized.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Database glue
// ---------------------------------------------------------------------------

export type MergeSkipReason = 'not_required' | 'no_repo' | 'no_candidate' | 'no_head' | 'provider_unavailable' | 'wrong_base' | 'head_drift' | 'closed_unmerged';

export type MergeGatePlan =
  | { disposition: 'wait'; project: ProjectRow; candidate: MergeCandidate; headSha: string; defaultBranch: string; waitingFor: string; externalId: string; externalUrl: string | null }
  | { disposition: 'not_required'; reason: 'not_required'; detail: null }
  | { disposition: 'blocked'; reason: Exclude<MergeSkipReason, 'not_required'>; detail: string };

const MERGE_COMMENT_LIMIT = 4000;

function clip(value: string, max = MERGE_COMMENT_LIMIT): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function postMergeComment(card: CardRow, action: string, body: string, metadata: Record<string, unknown>): Promise<void> {
  const [comment] = await db.insert(cardComments).values({
    cardId: card.id,
    authorType: 'system',
    action,
    body: clip(body),
    metadata,
  }).returning();
  if (comment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: comment.id, cardId: card.id, projectId: card.projectId, action });
}

async function mergeActivity(card: CardRow, action: string, details: Record<string, unknown>, actor: CardActionActor): Promise<void> {
  await db.insert(activityLog).values({
    companyId: card.companyId,
    actorType: actor.type,
    actorId: actor.id,
    userId: actor.userId ?? null,
    agentId: card.assigneeId,
    action,
    entityType: 'card',
    entityId: card.id,
    details,
  });
}

async function projectForCard(card: Pick<CardRow, 'projectId'>): Promise<ProjectRow | null> {
  if (!card.projectId) return null;
  const [project] = await db.select().from(projects).where(and(eq(projects.id, card.projectId), isNull(projects.deletedAt))).limit(1);
  return project ?? null;
}

// Read-only: decides whether an approved card must park, and on which head.
// Always verify current provider head/base/state, then compare reported evidence.
export async function planMergeGate(card: CardRow, options: { fetchImpl?: typeof fetch } = {}): Promise<MergeGatePlan> {
  const project = await projectForCard(card);
  const blocked = (reason: Exclude<MergeSkipReason, 'not_required'>, detail: string): MergeGatePlan => ({ disposition: 'blocked', reason, detail });
  if (!project || project.completionRequiresMerge !== true) return { disposition: 'not_required', reason: 'not_required', detail: null };
  if (!project.repoUrl) return blocked('no_repo', 'Configure the project repository before approving merge completion.');
  const products = await db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt)).limit(50);
  let candidate = selectMergeCandidate(products, project);
  if (!candidate) {
    const evidence = products.filter((product) => product.projectId === card.projectId).map((product) => {
      const metadata = product.metadata;
      return metadata && typeof metadata === 'object' && 'evidenceReport' in metadata ? metadata.evidenceReport : null;
    }).find(Boolean);
    const report = evidence ? normalizeAgentResult({ report: evidence }) : normalizeAgentResult({ output: card.executionLog ?? '' });
    const refs = report.source === 'report' && report.outcome === 'completed' ? report.report?.artifactRefs ?? [] : [];
    const urls = [...new Set(refs.filter((url) => parsePullRequestNumber(url) && mergeRepositoryMatches(url, project.repoUrl)))];
    if (urls.length === 1) candidate = selectMergeCandidate([{ type: 'pull_request', url: urls[0] }], project);
  }
  if (!candidate) return blocked('no_candidate', 'Report one project pull request or a non-default branch/commit work product with reviewed evidence. Foreign repository URLs cannot authorize completion.');
  if (project.autoMergeAfterApproval && candidate.kind !== 'pull_request') return blocked('no_candidate', 'Automatic authorized merge requires a project pull request. Open a pull request and report its URL and exact head as evidence before requesting approval.');

  const defaultBranch = normalizeBranchRef(project.defaultBranch) ?? 'main';
  let headSha: string | null = null;
  let pullRequestUrl = candidate.pullRequestUrl;
  const config = giteaConfigFromEnv();
  const slug = repoSlugFromProject(project);
  if (!config || !slug || ![config.apiUrl, config.internalUrl, config.externalUrl].some((alias) => origin(alias) === origin(project.repoUrl))) return blocked('provider_unavailable', 'Configure the authoritative Gitea provider for this repository, then retry evidence verification.');
  try {
      if (candidate.pullRequestNumber != null) {
        const pull = await giteaPullRequest(config, slug.org, slug.repo, candidate.pullRequestNumber, options.fetchImpl);
        if (!pull) return blocked('no_head', 'The project pull request was not found. Correct its URL and resubmit for review.');
        if (!['open', 'closed'].includes(pull.state ?? '') || typeof pull.merged !== 'boolean') return blocked('provider_unavailable', 'The provider returned incomplete pull request state. Restore provider access and retry evidence verification.');
        if (normalizeBranchRef(pull.base?.ref) !== defaultBranch) return blocked('wrong_base', `The pull request must target ${defaultBranch}; correct its base and resubmit for review.`);
        if (pull.state === 'closed' && !pull.merged) return blocked('closed_unmerged', 'The pull request closed without merging. Reopen or replace it and resubmit for review.');
        headSha = pull.head?.sha?.trim().toLowerCase() ?? null;
        pullRequestUrl = pullRequestUrl ?? pull?.html_url ?? null;
      } else {
        headSha = await giteaResolveCommit(config, slug.org, slug.repo, candidate.branch ?? candidate.headSha ?? '', options.fetchImpl);
      }
      if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) return blocked('no_head', 'The provider did not return a full head SHA. Restore repository access and retry verification.');
      if (candidate.headSha) {
        const reported = /^[0-9a-f]{40}$/i.test(candidate.headSha) ? candidate.headSha : /^[0-9a-f]{7,39}$/i.test(candidate.headSha) ? await giteaResolveCommit(config, slug.org, slug.repo, candidate.headSha, options.fetchImpl) : null;
        if (!sameCommit(reported, headSha)) return blocked('head_drift', 'The reported/reviewed commit differs from the provider head. Review the current head before authorizing it.');
      }
  } catch {
    return blocked('provider_unavailable', 'Gitea evidence verification is unavailable. Restore provider access and retry; completion remains blocked.');
  }

  const externalId = candidate.kind === 'pull_request' && candidate.pullRequestNumber != null
    ? String(candidate.pullRequestNumber)
    : candidate.branch ?? headSha;
  const waitingFor = `merge into ${defaultBranch}`;
  return { disposition: 'wait', project, candidate, headSha, defaultBranch, waitingFor, externalId, externalUrl: pullRequestUrl };
}

// The card stops here instead of finishing: waiting_on_external with the exact
// authorized head recorded, locks released like any other external wait.
const cardMergeOperations = new Map<string, Promise<unknown>>();
async function serializeMerge<T>(cardId: string, operation: () => Promise<T>): Promise<T> {
  const previous = cardMergeOperations.get(cardId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  cardMergeOperations.set(cardId, current);
  try { return await current; } finally { if (cardMergeOperations.get(cardId) === current) cardMergeOperations.delete(cardId); }
}

export async function parkForMerge(card: CardRow, plan: Extract<MergeGatePlan, { disposition: 'wait' }>, options: { approvedBy?: string | null; actor?: CardActionActor; note?: string | null; fromStatus?: string | null; fetchImpl?: typeof fetch; taskRunId?: string | null } = {}): Promise<ExternalWaitRow | null> {
  const result = await serializeMerge(card.id, async () => parkForMergeLocked(card, plan, options));
  // Committed first: this read closes the event-before-wait race.
  if (result?.created) await reconcileMergeWait(result.wait.id, { immediate: true, fetchImpl: options.fetchImpl });
  return result?.wait ?? null;
}

async function parkForMergeLocked(card: CardRow, plan: Extract<MergeGatePlan, { disposition: 'wait' }>, options: { approvedBy?: string | null; actor?: CardActionActor; note?: string | null; fromStatus?: string | null; taskRunId?: string | null }): Promise<{ wait: ExternalWaitRow; created: boolean } | null> {
  const actor: CardActionActor = options.actor ?? { type: 'system', id: 'merge-gate' };
  const now = new Date();
  const committed = await db.transaction(async (tx) => {
    // The card row serializes wait creation across server processes.
    const [fresh] = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!fresh || !['in_review', 'needs_review', 'waiting_on_external', 'in_progress'].includes(fresh.columnStatus ?? '')) return null;
    if (options.taskRunId) await tx.select().from(taskRuns).where(eq(taskRuns.id, options.taskRunId)).for('update').limit(1);
    const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(card, options.taskRunId)).limit(1);
    if (!authorized) return null;
    const waits = await tx.select().from(externalWaits).where(and(eq(externalWaits.cardId, card.id), eq(externalWaits.provider, MERGE_WAIT_PROVIDER), eq(externalWaits.status, 'waiting'))).orderBy(desc(externalWaits.createdAt));
    const existing = waits.find((wait) => sameCommit(wait.authorizedHeadSha, plan.headSha) && wait.externalId === plan.externalId);
    if (existing) {
      const [intent] = await tx.select().from(mergeIntents).where(eq(mergeIntents.waitId, existing.id)).limit(1);
      if (!intent || intent.gateVersion === (fresh.mergeGateVersion ?? 0)) return { wait: existing, created: false };
      if (!['prepared', 'retryable'].includes(intent.state)) return null;
      // A later completed review can authorize the same SHA, but never reuse
      // a permission decision invalidated by an intervening gate mutation.
      await tx.update(mergeIntents).set({ state: 'superseded', lastResult: 'A new review authorized a fresh wait after gate changes.' }).where(eq(mergeIntents.id, intent.id));
    }
    const [parked] = await tx.update(kanbanCards).set({ columnStatus: 'waiting_on_external', completedAt: null, lastError: null, executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: now }).where(completionCondition(card, options.taskRunId)).returning();
    if (!parked) return null;
    for (const wait of waits) await tx.update(externalWaits).set({ status: 'superseded', resolvedAt: now }).where(eq(externalWaits.id, wait.id));
    const [wait] = await tx.insert(externalWaits).values({ companyId: card.companyId, cardId: card.id, waitingFor: plan.waitingFor, provider: MERGE_WAIT_PROVIDER, externalId: plan.externalId, externalUrl: plan.externalUrl, status: 'waiting', authorizedHeadSha: plan.headSha, pollIntervalSeconds: 30, pollCount: 0 }).returning();
    if (!wait) throw new Error('merge_wait_create_failed');
    const target = managedMergeTarget(plan.project, giteaConfigFromEnv());
    if (target && plan.candidate.pullRequestNumber) {
      const [version] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).limit(1);
      await tx.insert(mergeIntents).values({ cardId: card.id, projectId: plan.project.id, waitId: wait.id, originatingTaskRunId: options.taskRunId ?? null, headSha: plan.headSha, repoFullName: `${target.org}/${target.repo}`, defaultBranch: plan.defaultBranch, gateVersion: version!.mergeGateVersion ?? 0, state: 'prepared', attemptCount: 0 });
    }
    return { wait, created: true };
  });
  if (!committed || !committed.created) return committed;
  const { wait } = committed;
  const fromStatus = options.fromStatus ?? card.columnStatus ?? 'in_review';
  const body = mergeAuthorizedMessage({ headSha: plan.headSha, candidate: plan.candidate, defaultBranch: plan.defaultBranch });
  await recordStageAction({
    cardId: card.id,
    agentId: card.assigneeId,
    actor,
    fromStatus,
    toStatus: 'waiting_on_external',
    action: 'wait_external',
    detail: options.note ? `${options.note} ${body}` : body,
    metadata: { externalWaitId: wait?.id ?? null, authorizedHeadSha: plan.headSha, pullRequestUrl: plan.candidate.pullRequestUrl, branch: plan.candidate.branch, approvedBy: options.approvedBy ?? null },
  });
  await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: 'queued', message: `Waiting on the merge of ${plan.headSha} into ${plan.defaultBranch}.` });
  await postMergeComment(card, 'merge_authorized', body, {
    authorizedHeadSha: plan.headSha,
    pullRequestUrl: plan.candidate.pullRequestUrl,
    pullRequestNumber: plan.candidate.pullRequestNumber,
    branch: plan.candidate.branch,
    defaultBranch: plan.defaultBranch,
    externalWaitId: wait?.id ?? null,
  });
  await mergeActivity(card, 'merge_gate.authorized', { externalWaitId: wait?.id ?? null, authorizedHeadSha: plan.headSha, pullRequestUrl: plan.candidate.pullRequestUrl, defaultBranch: plan.defaultBranch, approvedBy: options.approvedBy ?? null }, actor);
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'merge_gate.authorized' });
  return committed;
}

export function mergeCompletionStatus(plan: MergeGatePlan): 'done' | 'blocked' | 'waiting_on_external' {
  return plan.disposition === 'not_required' ? 'done' : plan.disposition === 'blocked' ? 'blocked' : 'waiting_on_external';
}

export async function noteMergeEvidenceRequired(card: CardRow, plan: Extract<MergeGatePlan, { disposition: 'not_required' | 'blocked' }>, taskRunId?: string | null): Promise<void> {
  if (plan.reason === 'not_required') return;
  const body = `Completion blocked: ${plan.detail}`;
  const updated = await guardedCompletionUpdate(card, { columnStatus: 'blocked', completedAt: null, rollupStatus: null, lastError: body, executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date() }, taskRunId);
  if (!updated) return;
  await postMergeComment(card, 'merge_evidence_required', body, { reason: plan.reason });
  await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: 'warning', message: body });
  await mergeActivity(card, 'merge_gate.blocked', { reason: plan.reason, detail: plan.detail }, { type: 'system', id: 'merge-gate' });
}

/** Apply one reviewed completion plan; only not_required permits direct Done. */
export async function applyMergeGatePlan(card: CardRow, plan: MergeGatePlan, options: { approvedBy?: string | null; actor?: CardActionActor; fromStatus?: string | null; fetchImpl?: typeof fetch; taskRunId?: string | null } = {}): Promise<void> {
  if (plan.disposition === 'wait') await parkForMerge(card, plan, options);
  else await noteMergeEvidenceRequired(card, plan, options.taskRunId);
}

// Convenience for the two approval sites that decide their own next status:
// plan, then either park or leave a skip note. Returns true when parked.
export async function applyMergeGate(card: CardRow, options: { approvedBy?: string | null; actor?: CardActionActor } = {}): Promise<boolean> {
  const plan = await planMergeGate(card);
  await applyMergeGatePlan(card, plan, options);
  return plan.disposition !== 'not_required';
}

// ---------------------------------------------------------------------------
// Gitea webhook receiver
// ---------------------------------------------------------------------------

type GiteaPushPayload = {
  ref?: string;
  after?: string;
  commits?: Array<{ id?: string }>;
  repository?: { full_name?: string };
};

type GiteaPullRequestPayload = {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    merged?: boolean;
    html_url?: string;
    head?: { sha?: string; ref?: string } | null;
    base?: { sha?: string; ref?: string } | null;
  } | null;
  repository?: { full_name?: string };
};

export type MergeWaitMatch = { wait: ExternalWaitRow; card: CardRow; project: ProjectRow };

// Open gitea waits whose card belongs to a project bound to this repository.
// The repo match is on the clone URL path (host- and case-insensitive), which
// is the only stable identity a webhook payload and a project row share.
export async function openMergeWaitsForRepo(repoFullName: string): Promise<MergeWaitMatch[]> {
  const waits = await db.select().from(externalWaits).where(and(eq(externalWaits.status, 'waiting'), eq(externalWaits.provider, MERGE_WAIT_PROVIDER))).orderBy(desc(externalWaits.createdAt)).limit(200);
  const matches: MergeWaitMatch[] = [];
  for (const wait of waits) {
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, wait.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card || card.columnStatus !== 'waiting_on_external') continue;
    const project = await projectForCard(card);
    if (project && sameRepoFullName(repoFullNameFromUrl(project.repoUrl), repoFullName)) matches.push({ wait, card, project });
  }
  return matches;
}

async function recordDrift(match: MergeWaitMatch, input: { observed: string | null; reason: string; eventType: string; payload: Record<string, unknown> }): Promise<void> {
  const { wait, card, project } = match;
  const now = new Date();
  const summary = `head drifted from ${wait.authorizedHeadSha ?? 'unknown'} to ${input.observed ?? 'unknown'}`;
  const superseded = new Error('merge_drift_superseded');
  const updated = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!fresh || fresh.columnStatus !== 'waiting_on_external') return null;
    const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(card)).limit(1);
    if (!authorized) return null;
    await settleMergeIntent(tx, wait.id, wait.authorizedHeadSha!, 'drift');
    const [row] = await tx.update(kanbanCards).set({ columnStatus: 'in_review', completedAt: null, rollupStatus: null, updatedAt: now }).where(completionCondition(card)).returning();
    if (!row) return null;
    const [claimed] = await tx.update(externalWaits).set({ status: 'superseded', resolvedAt: now }).where(and(eq(externalWaits.id, wait.id), eq(externalWaits.status, 'waiting'), eq(externalWaits.authorizedHeadSha, wait.authorizedHeadSha!))).returning();
    if (!claimed) throw superseded;
    await tx.insert(externalEvents).values({ companyId: card.companyId, projectId: card.projectId, rootCardId: await rootCardId(card), cardId: card.id, provider: MERGE_WAIT_PROVIDER, eventType: input.eventType, externalId: wait.externalId, externalUrl: wait.externalUrl, status: 'info', payloadSummary: summary, payload: input.payload, processedAt: now });
    return row;
  }).catch((error) => { if (error === superseded) return null; throw error; });
  if (!updated) return;
  const fromStatus = card.columnStatus ?? 'waiting_on_external';
  const body = mergeDriftMessage({ authorized: wait.authorizedHeadSha, observed: input.observed, reason: input.reason });
  const actor: CardActionActor = { type: 'system', id: 'gitea' };
  await recordStageAction({
    cardId: card.id,
    agentId: card.assigneeId,
    actor,
    fromStatus,
    toStatus: 'in_review',
    action: 'reopen',
    detail: body,
    metadata: { externalWaitId: wait.id, authorizedHeadSha: wait.authorizedHeadSha, observedHeadSha: input.observed, eventType: input.eventType },
    logStatus: 'warning',
  });
  await postMergeComment(card, 'merge_drift', body, { externalWaitId: wait.id, authorizedHeadSha: wait.authorizedHeadSha, observedHeadSha: input.observed, eventType: input.eventType });
  await mergeActivity(card, 'merge_gate.drift', { externalWaitId: wait.id, authorizedHeadSha: wait.authorizedHeadSha, observedHeadSha: input.observed, eventType: input.eventType, defaultBranch: project.defaultBranch }, actor);
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'merge_gate.drift' });
  // A fresh authorization needs a fresh review: the same entry points the
  // normal in_review transition uses, so panel cards open a panel round.
  const fresh = updated ?? card;
  if (await panelRequiredForCard(fresh)) await openPanelRound(fresh, { kind: 'panel' });
  else await enqueueTaskRun(fresh.id, 'review', 'queue');
}

export type GiteaEventOutcome = { verdict: MergeVerdict; cardId: string; waitId: string };

export type GiteaWebhookResult = { event: string; matched: number; outcomes: GiteaEventOutcome[] };

/** One bounded provider read, with persisted timing/budget; never dispatches an owner. */
export async function reconcileMergeWait(waitId: string, options: { immediate?: boolean; fetchImpl?: typeof fetch } = {}): Promise<boolean> {
  const [initial] = await db.select().from(externalWaits).where(eq(externalWaits.id, waitId)).limit(1);
  if (!initial) return false;
  return serializeMerge(initial.cardId, async () => {
    const [wait] = await db.select().from(externalWaits).where(eq(externalWaits.id, waitId)).limit(1);
    if (!wait || wait.status !== 'waiting' || !wait.authorizedHeadSha || wait.provider !== MERGE_WAIT_PROVIDER) return false;
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, wait.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card || card.columnStatus !== 'waiting_on_external' || !(await completionStillCurrent(card))) return false;
    const count = wait.pollCount ?? 0;
    if (count >= EXTERNAL_POLL_MAX || (!(options.immediate && count === 0) && !pollDecision({ ...wait, pollIntervalSeconds: wait.pollIntervalSeconds ?? 30 }, Date.now()).poll)) return false;
    const [claimed] = await db.update(externalWaits).set({ pollCount: count + 1, lastPolledAt: new Date(), pollIntervalSeconds: count + 1 >= EXTERNAL_POLL_MAX ? null : 30 }).where(and(eq(externalWaits.id, wait.id), eq(externalWaits.status, 'waiting'), eq(externalWaits.pollCount, count))).returning();
    if (!claimed) return false;
    const project = await projectForCard(card);
    const config = giteaConfigFromEnv();
    const slug = repoSlugFromProject(project);
    let reason = 'Gitea provider data is unavailable; merge completion remains pending.';
    try {
      if (project && config && slug) {
        const match = { wait, card, project };
        const number = parsePullRequestNumber(wait.externalUrl);
        if (number != null) {
          const pull = await giteaPullRequest(config, slug.org, slug.repo, number, options.fetchImpl);
          if (pull?.head?.sha && pull.base?.ref && typeof pull.merged === 'boolean' && ['open', 'closed'].includes(pull.state ?? '')) {
            const outcome = await handlePullRequestEvent(match, { action: pull.state === 'closed' || pull.merged ? 'closed' : 'synchronized', pull_request: pull, repository: { full_name: `${slug.org}/${slug.repo}` } });
            if (outcome) return true;
            if (await executeAuthorizedMerge(wait.id, options)) {
              const after = await giteaPullRequest(config, slug.org, slug.repo, number, options.fetchImpl);
              if (after?.head?.sha && after.base?.ref && typeof after.merged === 'boolean' && ['open', 'closed'].includes(after.state ?? '')) {
                const verified = await handlePullRequestEvent(match, { action: after.state === 'closed' || after.merged ? 'closed' : 'synchronized', pull_request: after, repository: { full_name: `${slug.org}/${slug.repo}` } });
                if (verified) return true;
              }
            }
            reason = `Merge check ${count + 1}/${EXTERNAL_POLL_MAX}: reviewed head is still waiting to merge into ${project.defaultBranch ?? 'main'}.`;
          }
        } else {
          const outcome = await handlePushEvent(match, { ref: `refs/heads/${project.defaultBranch ?? 'main'}`, repository: { full_name: `${slug.org}/${slug.repo}` } }, { fetchImpl: options.fetchImpl, budget: { containmentLookups: 1 } });
          if (outcome) return true;
          reason = 'The bounded provider history did not establish containment of the reviewed head. Merge evidence remains unknown; verify provider access or supply a pull request.';
        }
      }
    } catch { /* A provider/transport error is pending evidence, never completion. */ }
    if (count + 1 >= EXTERNAL_POLL_MAX) reason += ' The 24 automatic checks are exhausted. Restore the missing evidence or provide the verified merge event.';
    await db.update(kanbanCards).set({ lastError: reason, updatedAt: new Date() }).where(completionCondition(card));
    await db.insert(taskLogs).values({ cardId: card.id, type: 'webhook', status: 'warning', message: reason });
    return true;
  });
}

export async function handleGiteaWebhookEvent(input: { eventName: string; payload: unknown; app?: FastifyInstance; fetchImpl?: typeof fetch }): Promise<GiteaWebhookResult> {
  const eventName = (input.eventName || '').trim().toLowerCase();
  if (eventName !== 'push' && eventName !== 'pull_request') return { event: eventName || 'unknown', matched: 0, outcomes: [] };
  const payload = (input.payload ?? {}) as GiteaPushPayload & GiteaPullRequestPayload;
  const repoFullName = payload.repository?.full_name?.trim();
  if (!repoFullName) return { event: eventName, matched: 0, outcomes: [] };
  const matches = await openMergeWaitsForRepo(repoFullName);
  if (matches.length === 0) return { event: eventName, matched: 0, outcomes: [] };

  const outcomes: GiteaEventOutcome[] = [];
  // One push can only be asked to walk the branch history a few times; the
  // waits it does not list stay parked until the next event.
  const budget = { containmentLookups: PUSH_CONTAINMENT_LOOKUPS };
  for (const match of matches) {
    try {
      const outcome = await serializeMerge(match.card.id, async () => {
        const [wait] = await db.select().from(externalWaits).where(eq(externalWaits.id, match.wait.id)).limit(1);
        const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, match.card.id), isNull(kanbanCards.deletedAt))).limit(1);
        if (!wait || wait.status !== 'waiting' || !card || card.columnStatus !== 'waiting_on_external') return null;
        const fresh = { ...match, wait, card };
        if (match.project.autoMergeAfterApproval) {
          // Webhooks are hints: re-read the provider before releasing the fence.
          const config = giteaConfigFromEnv(), target = managedMergeTarget(match.project, config);
          const number = parsePullRequestNumber(wait.externalUrl);
          if (!config || !target || !number) return null;
          const pull = await giteaPullRequest(config, target.org, target.repo, number, input.fetchImpl);
          if (!pull || typeof pull.merged !== 'boolean' || !['open', 'closed'].includes(pull.state ?? '')) return null;
          return handlePullRequestEvent(fresh, { action: pull.state === 'closed' || pull.merged ? 'closed' : 'synchronized', pull_request: pull, repository: payload.repository });
        }
        return eventName === 'pull_request' ? handlePullRequestEvent(fresh, payload) : handlePushEvent(fresh, payload, { ...input, budget });
      });
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      input.app?.log.warn({ error, externalWaitId: match.wait.id }, 'gitea merge event skipped a wait');
    }
  }
  return { event: eventName, matched: matches.length, outcomes };
}

async function handlePullRequestEvent(match: MergeWaitMatch, payload: GiteaPullRequestPayload): Promise<GiteaEventOutcome | null> {
  const { wait, card, project } = match;
  if (project.completionRequiresMerge && !sameCommit(wait.authorizedHeadSha, wait.authorizedHeadSha)) return null;
  const pull = payload.pull_request ?? null;
  const number = pull?.number ?? payload.number ?? null;
  const headSha = pull?.head?.sha ?? null;
  const defaultBranch = normalizeBranchRef(project.defaultBranch) ?? 'main';
  if (project.autoMergeAfterApproval && pull?.base?.ref && normalizeBranchRef(pull.base.ref) !== defaultBranch) {
    const message = `Pull request retargeted from authorized ${defaultBranch} to ${pull.base.ref}. Gitea 1.22 cannot atomically bind the merge request to a base branch. ${pull.merged ? 'The provider reports an external merge; MegaCorps cannot undo or cancel that effect.' : 'No further merge will be initiated for this changed target.'} Completion remains unverified; inspect the provider state and target branch.`;
    await db.update(mergeIntents).set({ lastResult: message }).where(eq(mergeIntents.waitId, wait.id));
    await db.update(kanbanCards).set({ lastError: message, updatedAt: new Date() }).where(completionCondition(card));
    return { verdict: 'ignore', cardId: card.id, waitId: wait.id };
  }
  const verdict = mergeVerdict({
    wait: { provider: wait.provider, status: wait.status, externalId: wait.externalId, authorizedHeadSha: wait.authorizedHeadSha },
    event: {
      kind: 'pull_request',
      defaultBranch,
      action: payload.action ?? null,
      merged: pull?.merged ?? false,
      headSha,
      baseRef: pull?.base?.ref ?? null,
      pullRequestNumber: number,
    },
  });
  if (verdict === 'ignore') return null;
  const eventType = `pull_request.${(payload.action ?? 'unknown').toLowerCase()}`;
  if (verdict === 'drift') {
    await recordDrift(match, {
      observed: headSha,
      reason: payload.action === 'closed' || payload.action === 'merged'
        ? 'the merged head is not the head review authorized.'
        : 'new commits were pushed to the pull request after review approval.',
      eventType,
      payload: { action: payload.action ?? null, pullRequestNumber: number, headSha, baseRef: pull?.base?.ref ?? null, repository: payload.repository?.full_name ?? null },
    });
    return { verdict, cardId: card.id, waitId: wait.id };
  }
  await applyExternalEvent({
    card,
    verifiedMerge: true,
    actor: { type: 'system', id: 'gitea' },
    input: {
      provider: MERGE_WAIT_PROVIDER,
      eventType,
      status: verdict === 'success' ? 'success' : 'failure',
      externalId: wait.externalId,
      externalUrl: pull?.html_url ?? wait.externalUrl,
      payloadSummary: verdict === 'success'
        ? `Pull request ${number != null ? `#${number}` : ''} merged head ${headSha ?? wait.authorizedHeadSha} into ${defaultBranch}.`.trim()
        : `Pull request ${number != null ? `#${number}` : ''} was closed without merging.`.trim(),
      payload: { action: payload.action ?? null, pullRequestNumber: number, headSha, baseRef: pull?.base?.ref ?? null, repository: payload.repository?.full_name ?? null },
      waitId: wait.id,
      successStatus: 'done',
    },
  });
  return { verdict, cardId: card.id, waitId: wait.id };
}

const PUSH_CONTAINMENT_LOOKUPS = 5;

async function handlePushEvent(match: MergeWaitMatch, payload: GiteaPushPayload, ctx: { fetchImpl?: typeof fetch; budget: { containmentLookups: number } }): Promise<GiteaEventOutcome | null> {
  const { wait, card, project } = match;
  const defaultBranch = normalizeBranchRef(project.defaultBranch) ?? 'main';
  const branch = normalizeBranchRef(payload.ref);
  if (!branch || branch.toLowerCase() !== defaultBranch.toLowerCase() || !wait.authorizedHeadSha) return null;
  const listed = [payload.after, ...(payload.commits ?? []).map((commit) => commit?.id)].filter(Boolean) as string[];
  let contains = listed.some((sha) => sameCommit(sha, wait.authorizedHeadSha));
  if (!contains && ctx.budget.containmentLookups > 0) {
    // Gitea truncates long push payloads; ask the API whether the branch tip
    // history now carries the authorized head before deciding it did not land.
    const config = giteaConfigFromEnv();
    const slug = repoSlugFromProject(project);
    if (config && slug) {
      ctx.budget.containmentLookups -= 1;
      try {
        contains = await giteaBranchContainsCommit(config, slug.org, slug.repo, defaultBranch, wait.authorizedHeadSha, { fetchImpl: ctx.fetchImpl });
      } catch {
        contains = false;
      }
    }
  }
  const verdict = mergeVerdict({
    wait: { provider: wait.provider, status: wait.status, externalId: wait.externalId, authorizedHeadSha: wait.authorizedHeadSha },
    event: { kind: 'push', defaultBranch, ref: payload.ref ?? null, containsAuthorizedHead: contains },
  });
  if (verdict !== 'success') return null;
  await applyExternalEvent({
    card,
    verifiedMerge: true,
    actor: { type: 'system', id: 'gitea' },
    input: {
      provider: MERGE_WAIT_PROVIDER,
      eventType: 'push',
      status: 'success',
      externalId: wait.externalId,
      externalUrl: wait.externalUrl,
      payloadSummary: `Authorized head ${wait.authorizedHeadSha} is on ${defaultBranch}.`,
      payload: { ref: payload.ref ?? null, after: payload.after ?? null, repository: (payload as GiteaPushPayload).repository?.full_name ?? null },
      waitId: wait.id,
      successStatus: 'done',
    },
  });
  return { verdict, cardId: card.id, waitId: wait.id };
}
