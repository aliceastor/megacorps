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
import { activityLog, cardComments, externalEvents, externalWaits, kanbanCards, projects, taskLogs, workProducts } from './db/schema.ts';
import { recordStageAction, type CardActionActor } from './card-actions.ts';
import { publishLiveEvent } from './live.ts';
import { giteaBranchContainsCommit, giteaConfigFromEnv, giteaPullRequest, giteaSlug } from './gitea.ts';
import { applyExternalEvent, rootCardId } from './external-events.ts';
import { enqueueTaskRun } from './dispatch.ts';
import { openPanelRound, panelRequiredForCard } from './review-rounds.ts';

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

// Agents report short SHAs as often as full ones; a prefix of at least seven
// hex characters is still the same commit, anything shorter is not trusted.
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

function productOnProjectRepo(product: MergeWorkProduct, projectFullName: string | null): boolean {
  const own = repoFullNameFromUrl(product.repoUrl) ?? repoFullNameFromUrl(product.pullRequestUrl) ?? repoFullNameFromUrl(product.url);
  if (!own) return true; // no repo information: assume the project repo
  if (!projectFullName) return true;
  return own === projectFullName;
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
  const projectFullName = repoFullNameFromUrl(project.repoUrl);
  const defaultBranch = (project.defaultBranch ?? 'main').trim().toLowerCase();
  const relevant = products
    .filter((product) => productOnProjectRepo(product, projectFullName))
    .slice()
    .sort((a, b) => productTime(b) - productTime(a));

  const prProduct = relevant.find((product) => Boolean(product.pullRequestUrl));
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
  if (event.pullRequestNumber != null && wait.externalId && String(event.pullRequestNumber) !== wait.externalId) return 'ignore';
  const action = (event.action ?? '').trim().toLowerCase();
  const closed = action === 'closed' || action === 'merged';
  if (closed && event.merged) {
    const base = normalizeBranchRef(event.baseRef);
    if (base && base.toLowerCase() !== defaultBranch.toLowerCase()) return 'ignore';
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

export type MergeSkipReason = 'not_required' | 'no_repo' | 'no_candidate' | 'no_head';

export type MergeGatePlan =
  | { park: true; project: ProjectRow; candidate: MergeCandidate; headSha: string; defaultBranch: string; waitingFor: string; externalId: string; externalUrl: string | null }
  | { park: false; reason: MergeSkipReason; detail: string | null };

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
// The head comes from the reported work product, and only when that is missing
// does MegaCorps ask Gitea for the pull request head.
export async function planMergeGate(card: CardRow, options: { fetchImpl?: typeof fetch } = {}): Promise<MergeGatePlan> {
  const project = await projectForCard(card);
  if (!project || project.completionRequiresMerge !== true) return { park: false, reason: 'not_required', detail: null };
  if (!project.repoUrl) return { park: false, reason: 'no_repo', detail: 'the project requires a merge but has no repository URL' };
  const products = await db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt)).limit(50);
  const candidate = selectMergeCandidate(products, project);
  if (!candidate) return { park: false, reason: 'no_candidate', detail: 'no pull request, commit, or non-default branch was reported as a work product' };

  const defaultBranch = normalizeBranchRef(project.defaultBranch) ?? 'main';
  let headSha = candidate.headSha;
  let pullRequestUrl = candidate.pullRequestUrl;
  if (!headSha && candidate.pullRequestNumber != null) {
    const config = giteaConfigFromEnv();
    const slug = repoSlugFromProject(project);
    if (config && slug) {
      try {
        const pull = await giteaPullRequest(config, slug.org, slug.repo, candidate.pullRequestNumber, options.fetchImpl);
        headSha = pull?.head?.sha ?? null;
        pullRequestUrl = pullRequestUrl ?? pull?.html_url ?? null;
      } catch {
        headSha = null;
      }
    }
  }
  if (!headSha) {
    return {
      park: false,
      reason: 'no_head',
      detail: candidate.kind === 'pull_request'
        ? 'the reported pull request carries no head commit SHA and Gitea could not supply one'
        : 'the reported branch work product carries no commit SHA',
    };
  }

  const externalId = candidate.kind === 'pull_request' && candidate.pullRequestNumber != null
    ? String(candidate.pullRequestNumber)
    : candidate.branch ?? headSha;
  const waitingFor = `merge into ${defaultBranch}`;
  return { park: true, project, candidate, headSha, defaultBranch, waitingFor, externalId, externalUrl: pullRequestUrl };
}

// The card stops here instead of finishing: waiting_on_external with the exact
// authorized head recorded, locks released like any other external wait.
export async function parkForMerge(card: CardRow, plan: Extract<MergeGatePlan, { park: true }>, options: { approvedBy?: string | null; actor?: CardActionActor; note?: string | null; fromStatus?: string | null } = {}): Promise<ExternalWaitRow | null> {
  const actor: CardActionActor = options.actor ?? { type: 'system', id: 'merge-gate' };
  const now = new Date();
  const [existing] = await db.select().from(externalWaits).where(and(
    eq(externalWaits.cardId, card.id),
    eq(externalWaits.provider, MERGE_WAIT_PROVIDER),
    eq(externalWaits.status, 'waiting'),
  )).orderBy(desc(externalWaits.createdAt)).limit(1);
  let wait = existing ?? null;
  if (!wait || !sameCommit(wait.authorizedHeadSha, plan.headSha)) {
    if (wait) await db.update(externalWaits).set({ status: 'superseded', resolvedAt: now }).where(eq(externalWaits.id, wait.id));
    const [created] = await db.insert(externalWaits).values({
      companyId: card.companyId,
      cardId: card.id,
      waitingFor: plan.waitingFor,
      provider: MERGE_WAIT_PROVIDER,
      externalId: plan.externalId,
      externalUrl: plan.externalUrl,
      status: 'waiting',
      authorizedHeadSha: plan.headSha,
    }).returning();
    wait = created ?? null;
  }
  const fromStatus = options.fromStatus ?? card.columnStatus ?? 'in_review';
  await db.update(kanbanCards).set({
    columnStatus: 'waiting_on_external',
    completedAt: null,
    lastError: null,
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: now,
  }).where(eq(kanbanCards.id, card.id));
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
  return wait;
}

// The gate was on but nothing could be authorized: say so on the board and let
// the card finish exactly as it would without the gate.
export async function noteMergeGateSkipped(card: CardRow, plan: Extract<MergeGatePlan, { park: false }>): Promise<void> {
  if (plan.reason === 'not_required') return;
  const body = `Merge gate skipped: ${plan.detail ?? plan.reason}. The card completes without waiting for a merge.`;
  await postMergeComment(card, 'merge_gate_skipped', body, { reason: plan.reason });
  await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: 'warning', message: body });
  await mergeActivity(card, 'merge_gate.skipped', { reason: plan.reason, detail: plan.detail }, { type: 'system', id: 'merge-gate' });
}

// Convenience for the two approval sites that decide their own next status:
// plan, then either park or leave a skip note. Returns true when parked.
export async function applyMergeGate(card: CardRow, options: { approvedBy?: string | null; actor?: CardActionActor } = {}): Promise<boolean> {
  const plan = await planMergeGate(card);
  if (plan.park) {
    await parkForMerge(card, plan, options);
    return true;
  }
  await noteMergeGateSkipped(card, plan);
  return false;
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
  const rows = await db.select({ wait: externalWaits, card: kanbanCards, project: projects })
    .from(externalWaits)
    .innerJoin(kanbanCards, eq(kanbanCards.id, externalWaits.cardId))
    .innerJoin(projects, eq(projects.id, kanbanCards.projectId))
    .where(and(
      eq(externalWaits.status, 'waiting'),
      eq(externalWaits.provider, MERGE_WAIT_PROVIDER),
      isNull(kanbanCards.deletedAt),
      isNull(projects.deletedAt),
    ))
    .orderBy(desc(externalWaits.createdAt))
    .limit(200);
  const wanted = repoFullNameFromUrl(`https://gitea.local/${stripGitSuffix(repoFullName)}`) ?? stripGitSuffix(repoFullName).toLowerCase();
  return rows.filter((row) => {
    const projectFullName = repoFullNameFromUrl(row.project.repoUrl);
    return projectFullName !== null && projectFullName === wanted;
  });
}

async function recordDrift(match: MergeWaitMatch, input: { observed: string | null; reason: string; eventType: string; payload: Record<string, unknown> }): Promise<void> {
  const { wait, card, project } = match;
  const now = new Date();
  const summary = `head drifted from ${wait.authorizedHeadSha ?? 'unknown'} to ${input.observed ?? 'unknown'}`;
  await db.insert(externalEvents).values({
    companyId: card.companyId,
    projectId: card.projectId,
    rootCardId: await rootCardId(card),
    cardId: card.id,
    provider: MERGE_WAIT_PROVIDER,
    eventType: input.eventType,
    externalId: wait.externalId,
    externalUrl: wait.externalUrl,
    status: 'info',
    payloadSummary: summary,
    payload: input.payload,
    processedAt: now,
  });
  await db.update(externalWaits).set({ status: 'superseded', resolvedAt: now }).where(eq(externalWaits.id, wait.id));
  const fromStatus = card.columnStatus ?? 'waiting_on_external';
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: 'in_review',
    completedAt: null,
    rollupStatus: null,
    updatedAt: now,
  }).where(eq(kanbanCards.id, card.id)).returning();
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
      const outcome = eventName === 'pull_request'
        ? await handlePullRequestEvent(match, payload)
        : await handlePushEvent(match, payload, { ...input, budget });
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      input.app?.log.warn({ error, externalWaitId: match.wait.id }, 'gitea merge event skipped a wait');
    }
  }
  return { event: eventName, matched: matches.length, outcomes };
}

async function handlePullRequestEvent(match: MergeWaitMatch, payload: GiteaPullRequestPayload): Promise<GiteaEventOutcome | null> {
  const { wait, card, project } = match;
  const pull = payload.pull_request ?? null;
  const number = pull?.number ?? payload.number ?? null;
  const headSha = pull?.head?.sha ?? null;
  const defaultBranch = normalizeBranchRef(project.defaultBranch) ?? 'main';
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
