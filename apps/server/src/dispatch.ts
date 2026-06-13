import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { inferCardTransitionAction, normalizeCardStatus, type CardStatus } from '@megacorps/shared';
import { db, sql as rawSql } from './db/client.ts';
import { activityLog, agentRuntimes, agents, approvals, budgetPolicies, cardActions, cardComments, cardRequiredTools, companies, costEvents, cronRuns, departments, goals, heartbeatRuns, kanbanCards, knowledgeDocs, positions, projects, taskLogs, taskRuns, toolRegistry, workProducts } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import { configuredWebhookSharedSecret } from './webhook-secret.ts';
import { publishLiveEvent } from './live.ts';
import { findAdapterSession, rememberAdapterSession } from './adapter-sessions.ts';
import { recordStageAction } from './card-actions.ts';
import { dependenciesMet as cardDependenciesMet } from './card-dependencies.ts';
import { agentRuntimeAvailable, createRuntimeAvailabilityCache, type RuntimeAvailabilityCache } from './runner-availability.ts';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';
import { notify } from './notifications.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
export type DelegationReport = { id?: string; name: string; slug: string; departmentId?: string | null; positionName?: string | null; departmentName?: string | null };
type AvailableDelegationReport = DelegationReport & { id: string };
type CompanyStructureAgent = Pick<AgentRow, 'id' | 'name' | 'slug' | 'bossId' | 'role' | 'title' | 'positionId' | 'departmentId' | 'adapterType' | 'runtimeId' | 'isActive'>;
type GoalRow = typeof goals.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type RuntimeRow = typeof agentRuntimes.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
type AdapterSessionRow = NonNullable<Awaited<ReturnType<typeof findAdapterSession>>>;
type KanbanContextOptions = {
  focusCardId?: string;
  focusAgentId?: string | null;
  budgetChars?: number;
  projectId?: string | null;
  includeGoals?: boolean;
  includeInvocationPositionPrompt?: boolean;
  includeFocusProjectRepo?: boolean;
};
type PromptBuildOptions = { continuation?: boolean; since?: Date | null; kind?: TaskRunKind };
type LogStatus = 'queued' | 'running' | 'success' | 'warning' | 'failed';
type TaskRunKind = 'dispatch' | 'review';
type TaskRunSource = 'manual' | 'loop' | 'startup' | 'queue';

const LOOP_INTERVAL_MS = Number(process.env.DISPATCH_LOOP_INTERVAL_MS ?? 10_000);
const CONTEXT_CHAR_BUDGET = Number(process.env.DISPATCH_CONTEXT_CHAR_BUDGET ?? 32_000);
const KANBAN_CONTEXT_CARD_LIMIT = Number(process.env.DISPATCH_CONTEXT_CARD_LIMIT ?? 160);
const KANBAN_CONTEXT_RECORD_LIMIT = Number(process.env.DISPATCH_CONTEXT_RECORD_LIMIT ?? 30);
const TASK_RUN_CANDIDATE_SCAN_LIMIT = Number(process.env.TASK_RUN_CANDIDATE_SCAN_LIMIT ?? 250);
const MESSAGE_BOARD_COMMENT_LIMIT = Number(process.env.MESSAGE_BOARD_COMMENT_LIMIT ?? 20_000);
const TASK_BODY_CHAR_LIMIT = Number(process.env.DISPATCH_TASK_BODY_CHAR_LIMIT ?? 12_000);
const KNOWLEDGE_DOC_CHAR_LIMIT = Number(process.env.DISPATCH_KNOWLEDGE_DOC_CHAR_LIMIT ?? 4_000);
const BUDGET_RESET_DAY = Number(process.env.BUDGET_RESET_DAY ?? 1);
const TASK_RUN_WORKER_INTERVAL_MS = Number(process.env.TASK_RUN_WORKER_INTERVAL_MS ?? 2_000);
const TASK_RUN_WORKER_BATCH_SIZE = Number(process.env.TASK_RUN_WORKER_BATCH_SIZE ?? 1);
const TASK_RUN_WORKER_ID = process.env.TASK_RUN_WORKER_ID ?? `server-${Math.random().toString(36).slice(2, 10)}`;
const TASK_RUN_STALE_MS = Number(process.env.TASK_RUN_STALE_MS ?? 10 * 60 * 1000);
const EXECUTION_LOCK_TTL_MS = Math.max(60_000, Number(process.env.EXECUTION_LOCK_TTL_MS ?? 10 * 60 * 1000));
let loopRunning = false;
let taskRunWorkerClaiming = false;
const activeTaskRunIds = new Set<string>();
const companyLastTick = new Map<string, number>();
const cronState = {
  enabled: process.env.DISPATCH_LOOP_ENABLED !== 'false',
  intervalMs: LOOP_INTERVAL_MS,
  running: false,
  lastStartedAt: null as string | null,
  lastCompletedAt: null as string | null,
  lastStatus: 'idle',
  lastError: null as string | null,
};

function nextBackoff(retryCount: number): Date {
  const seconds = Math.min(300, 10 * 2 ** Math.max(0, retryCount));
  return new Date(Date.now() + seconds * 1000);
}

function isTerminalCardStatus(status: string | null | undefined): boolean {
  return status === 'done' || status === 'blocked' || status === 'cancelled';
}

function terminalRunStatus(status: string | null | undefined): 'success' | 'failed' | 'cancelled' {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'failed';
  return 'success';
}

function reviewCanRun(status: string | null | undefined): boolean {
  return status === 'in_review' || status === 'needs_review';
}

function resolveEffectiveReviewerId(card: CardRow, agent: AgentRow): string | null {
  if (card.reviewerId && card.reviewerId !== agent.id) return card.reviewerId;
  if (agent.bossId && agent.bossId !== agent.id) return agent.bossId;
  return null;
}

function assigneeNeedsReview(output: string | null | undefined): boolean {
  const text = output ?? '';
  return /\b(needs[_ -]?review|needs[_ -]?guidance|needs[_ -]?reviewer|escalat(?:e|ed|ion)|cannot[_ -]?complete|unable[_ -]?to[_ -]?complete|stuck|blocked:)\b/i.test(text);
}

function asksForConfirmationInsteadOfWorking(output: string | null | undefined): boolean {
  const text = output?.trim() ?? '';
  if (!text) return false;
  const englishConfirmation = /\b(please\s+confirm|awaiting\s+confirmation|waiting\s+for\s+confirmation|do\s+you\s+want\s+me\s+to|would\s+you\s+like\s+me\s+to|want\s+me\s+to|should\s+i\s+(?:continue|proceed|start|submit|post)|shall\s+i\s+(?:continue|proceed|start|submit|post)|may\s+i\s+(?:continue|proceed|start|submit|post))\b/i;
  const chineseConfirmation = /(\u8acb\u554f|\u78ba\u8a8d|\u4e0d\u78ba\u5b9a|\u662f\u5426|\u8981\u4e0d\u8981|\u53ef\u4ee5\u55ce|\u53ef\u5426|\u8981\u6211|\u60a8\u60f3|\u4f60\u60f3|\u5148\u770b|\u518d\u6c7a\u5b9a|\u540c\u610f|\u6279\u51c6|\u51c6\u8a31|\u6211\u53ef\u4ee5|\u6211\u61c9\u8a72|\u53ef\u4e0d\u53ef\u4ee5).{0,80}(\u7e7c\u7e8c|\u958b\u59cb|\u76f4\u63a5|\u57f7\u884c|\u52d5\u624b|\u63d0\u4ea4|\u9001\u51fa|POST|post|\u56de\u5831|\u5b8c\u6210|\u6c7a\u5b9a|\u78ba\u8a8d)/i;
  return englishConfirmation.test(text) || chineseConfirmation.test(text);
}

export function delegationItems(output: string | null | undefined): string[] {
  const lines = (output ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*(?:#{1,4}\s*)?(?:DELEGATE|DELEGATION|SUB-?TASKS?|TASKS FOR DIRECT REPORTS)\s*:?\s*$/i.test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (items.length > 0 && /^\s*(?:#{1,4}\s*)?(?:STATUS|DONE|FINAL|OUTPUT|REVIEW|NOTES?|RECOMMENDATION)\s*:?\s*$/i.test(line)) break;
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!match) continue;
    const title = match[1]?.replace(/\s+/g, ' ').trim();
    if (title && !items.includes(title)) items.push(title.slice(0, 180));
    if (items.length >= 8) break;
  }
  return items;
}

function directReportList(reports: DelegationReport[]): string {
  if (reports.length === 0) return 'the active direct reports listed in the assignment context';
  return reports.map((report) => {
    const slug = report.slug && report.slug !== report.name ? `slug: ${report.slug}` : null;
    const position = `position: ${report.positionName ?? 'none'}`;
    const department = `department: ${report.departmentName ?? 'none'}`;
    return `${report.name} (${[slug, position, department].filter(Boolean).join(', ')})`;
  }).join(', ');
}

function oneLine(value: string | null | undefined, maxChars = 600): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text ? clipText(text, maxChars).replace(/\s+/g, ' ') : 'none';
}

function promptDiagnostic(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return 'none';
  if (text.startsWith('collaboration_mode_requires_delegation')) {
    return 'collaboration_mode_requires_delegation (see Completion protocol for the required DELEGATE format).';
  }
  return text;
}

function companyStructureLines(input: {
  agents: CompanyStructureAgent[];
  departmentById: Map<string, typeof departments.$inferSelect>;
  positionById: Map<string, typeof positions.$inferSelect>;
}): string[] {
  const activeAgents = input.agents.filter((agent) => agent.isActive !== false);
  return activeAgents.map((agent) => {
    const position = agent.positionId ? input.positionById.get(agent.positionId) : undefined;
    const department = agent.departmentId ? input.departmentById.get(agent.departmentId) : undefined;
    const directReportSlugs = activeAgents
      .filter((report) => report.bossId === agent.id)
      .map((report) => report.slug)
      .sort((left, right) => left.localeCompare(right));
    const positionName = position?.name ?? agent.title ?? agent.role ?? 'none';
    const departmentName = department?.name ?? 'none';
    const positionDescription = oneLine(position?.description ?? position?.prompt, 600);
    return `[${agent.name} (${agent.slug}), ${positionName} | ${departmentName}, ${positionDescription}|[list: ${directReportSlugs.join(', ') || 'none'}]]`;
  });
}

export function collaborationDelegationInstructions(reports: DelegationReport[] = []): string {
  const first = reports[0];
  const second = reports[1];
  return [
    'Collaboration Mode is ON.',
    'If you have active direct reports, you MUST split this work into meaningful sub-tasks and delegate them to the most suitable employees so more appropriate staff participate and improve quality.',
    'Do not complete the current leader card directly with status="done" or status="in_review" while active direct reports are available.',
    `Active direct reports to consider: ${directReportList(reports)}.`,
    'Return the delegation plan exactly like this in stdout, or send status="in_progress" with this block in the webhook summary/output:',
    'DELEGATE:',
    first ? `- ${first.name}: <sub-task title and expected deliverable>` : '- <direct report name or slug>: <sub-task title and expected deliverable>',
    second ? `- ${second.name}: <another sub-task title and expected deliverable>` : '- <another direct report name or slug>: <another sub-task title and expected deliverable>',
    'Each bullet becomes one child Kanban card. Prefix a bullet with "name:" or "slug:" to target a specific direct report; omit the prefix only if any direct report can take it.',
    'If you truly have no active direct reports, complete the work yourself and state that no active direct reports were available for delegation.',
  ].join('\n');
}

export function optionalDelegationInstructions(reports: DelegationReport[] = []): string {
  const first = reports[0];
  const second = reports[1];
  return [
    'Collaboration Mode is OFF.',
    'You may complete the work directly when that is the best path.',
    'If you have active direct reports and the task has meaningful parts that fit their skills, you may split those parts into delegated sub-tasks so suitable employees participate and improve quality.',
    `Active direct reports to consider: ${directReportList(reports)}.`,
    'To delegate, return the delegation plan exactly like this in stdout, or send status="in_progress" with this block in the webhook summary/output:',
    'DELEGATE:',
    first ? `- ${first.name}: <sub-task title and expected deliverable>` : '- <direct report name or slug>: <sub-task title and expected deliverable>',
    second ? `- ${second.name}: <another sub-task title and expected deliverable>` : '- <another direct report name or slug>: <another sub-task title and expected deliverable>',
    'Each bullet becomes one child Kanban card. Prefix a bullet with "name:" or "slug:" to target a specific direct report; omit the prefix only if any direct report can take it.',
  ].join('\n');
}

export async function activeDirectReportsForAgent(companyId: string, bossId: string): Promise<AvailableDelegationReport[]> {
  const rows = await db.select({
    id: agents.id,
    name: agents.name,
    slug: agents.slug,
    departmentId: agents.departmentId,
    adapterType: agents.adapterType,
    runtimeId: agents.runtimeId,
    positionName: positions.name,
    departmentName: departments.name,
  }).from(agents)
    .leftJoin(positions, eq(agents.positionId, positions.id))
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(and(
    eq(agents.companyId, companyId),
    eq(agents.bossId, bossId),
    eq(agents.isActive, true),
    isNull(agents.deletedAt),
  ));
  const availabilityCache = createRuntimeAvailabilityCache();
  const available = await Promise.all(rows.map(async (report) => (
    await agentRuntimeAvailable({ companyId, runtimeId: report.runtimeId, adapterType: report.adapterType ?? 'hermes-ssh' }, availabilityCache)
      ? report
      : null
  )));
  return available.filter((report): report is NonNullable<typeof report> => Boolean(report)).map((report) => ({
    id: report.id,
    name: report.name,
    slug: report.slug,
    departmentId: report.departmentId,
    positionName: report.positionName,
    departmentName: report.departmentName,
  }));
}

async function activeDirectReportsForCard(card: CardRow): Promise<DelegationReport[]> {
  if (!card.assigneeId) return [];
  return activeDirectReportsForAgent(card.companyId, card.assigneeId);
}

async function promptVisibleAgents(companyId: string, agentRows: CompanyStructureAgent[], cache?: RuntimeAvailabilityCache): Promise<CompanyStructureAgent[]> {
  const visible = await Promise.all(agentRows.map(async (agent) => {
    if (agent.isActive === false) return null;
    const available = await agentRuntimeAvailable({ companyId, runtimeId: agent.runtimeId, adapterType: agent.adapterType ?? 'hermes-ssh' }, cache);
    return available ? agent : null;
  }));
  return visible.filter((agent): agent is CompanyStructureAgent => Boolean(agent));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dispatchCompletionDecision(output: string | null | undefined, effectiveReviewerId: string | null): { needsHelpReview: boolean; nextStatus: CardStatus; topLevelGuidanceAccepted: boolean } {
  const needsHelpReview = assigneeNeedsReview(output);
  const nextStatus = needsHelpReview
    ? effectiveReviewerId ? 'needs_review' : 'done'
    : effectiveReviewerId ? 'in_review' : 'done';
  return { needsHelpReview, nextStatus, topLevelGuidanceAccepted: needsHelpReview && !effectiveReviewerId };
}

export function completionStatusForQualityGate(requestedStatus: CardStatus | 'success', qualityReviewerId: string | null): CardStatus {
  if ((requestedStatus === 'done' || requestedStatus === 'success') && qualityReviewerId) return 'in_review';
  if (requestedStatus === 'in_review') return qualityReviewerId ? 'in_review' : 'done';
  if (requestedStatus === 'success') return 'done';
  return requestedStatus;
}

type ChildPolicyCard = Pick<CardRow, 'requiredChildPolicy'>;
type ChildPolicyRow = Pick<CardRow, 'columnStatus' | 'childRequirementLevel' | 'estimatedWeight'>;
type ChildBlockRow = ChildPolicyRow & Pick<CardRow, 'title'>;

export type ChildCompletionBlock = {
  blocked: true;
  targetStatus: 'done' | 'in_review';
  childCount: number;
  incompleteCount: number;
  incompleteTitles: string[];
  message: string;
};

function childWeight(child: Pick<CardRow, 'estimatedWeight'>): number {
  const weight = Number(child.estimatedWeight ?? 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function childIsDone(child: Pick<CardRow, 'columnStatus'>): boolean {
  return child.columnStatus === 'done';
}

function childCanBeIgnored(child: Pick<CardRow, 'columnStatus'>): boolean {
  return child.columnStatus === 'cancelled';
}

export function childCompletionPolicySatisfied(parent: ChildPolicyCard, children: ChildPolicyRow[]): boolean {
  if (children.length === 0) return true;
  const required = children.filter((child) => (child.childRequirementLevel ?? 'required') === 'required');
  const policy = parent.requiredChildPolicy ?? 'all_required_accepted';
  if (policy === 'all_non_cancelled_accepted') return children.filter((child) => !childCanBeIgnored(child)).every(childIsDone);
  if (policy === 'threshold') {
    const totalWeight = children.reduce((sum, child) => sum + childWeight(child), 0);
    const doneWeight = children.reduce((sum, child) => sum + (childIsDone(child) ? childWeight(child) : 0), 0);
    return doneWeight >= totalWeight * 0.8;
  }
  if (required.length > 0) return required.every(childIsDone);
  return children.every((child) => childIsDone(child) || childCanBeIgnored(child));
}

function blockingChildrenForPolicy(parent: ChildPolicyCard, children: ChildBlockRow[]): ChildBlockRow[] {
  if (childCompletionPolicySatisfied(parent, children)) return [];
  const required = children.filter((child) => (child.childRequirementLevel ?? 'required') === 'required');
  const policy = parent.requiredChildPolicy ?? 'all_required_accepted';
  if (policy === 'all_non_cancelled_accepted') return children.filter((child) => !childCanBeIgnored(child) && !childIsDone(child));
  if (policy === 'threshold') return children.filter((child) => !childIsDone(child));
  if (required.length > 0) return required.filter((child) => !childIsDone(child));
  return children.filter((child) => !childIsDone(child) && !childCanBeIgnored(child));
}

export async function completionBlockedByChildren(card: CardRow, targetStatus: CardStatus | string | null | undefined): Promise<ChildCompletionBlock | null> {
  const normalizedTarget = normalizeCardStatus(targetStatus);
  if (normalizedTarget !== 'done' && normalizedTarget !== 'in_review') return null;
  const children = await db.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, card.id), isNull(kanbanCards.deletedAt)));
  if (children.length === 0 || childCompletionPolicySatisfied(card, children)) return null;
  const blockingChildren = blockingChildrenForPolicy(card, children);
  const incompleteTitles = blockingChildren.slice(0, 5).map((child) => `${child.title} (${child.columnStatus ?? 'todo'})`);
  const suffix = blockingChildren.length > incompleteTitles.length ? `, +${blockingChildren.length - incompleteTitles.length} more` : '';
  return {
    blocked: true,
    targetStatus: normalizedTarget,
    childCount: children.length,
    incompleteCount: blockingChildren.length,
    incompleteTitles,
    message: `Parent cannot move to ${normalizedTarget}; waiting for ${blockingChildren.length}/${children.length} child card(s): ${incompleteTitles.join(', ')}${suffix}.`,
  };
}

type ReviewDecision = 'approved' | 'revision_requested' | 'escalate';

function explicitReviewDecision(output: string | null | undefined): ReviewDecision | null {
  const text = output ?? '';
  if (/\b(?:final\s+)?(?:review\s+)?verdict\s*[:=]\s*(?:reject(?:ed)?|revision[_ -]?requested)\b|\breject(?:ed)?\W{0,30}revision[_ -]?requested\b|\bnot\s+approved\b|\bcannot\s+approve\b/i.test(text)) {
    return 'revision_requested';
  }
  if (/\b(?:final\s+)?(?:review\s+)?verdict\s*[:=]\s*escalate\b|\bescalate\b(?:\s*[:=]|\W{1,16}(?:manager|boss|higher|review|decision)\b)/i.test(text)) {
    return 'escalate';
  }
  if (/\b(?:final\s+)?(?:review\s+)?verdict\s*[:=]\s*(?:approved?|pass|done)\b|\bapproved?\W{0,16}(?:done|complete(?:d)?|resolved)\b|["']status["']\s*:\s*["']done["']/i.test(text)) {
    return 'approved';
  }
  return null;
}

function reviewDecision(output: string, mode: 'quality' | 'help'): ReviewDecision {
  const explicit = explicitReviewDecision(output);
  if (explicit) return explicit;
  if (/\b(escalate|needs[_ -]?higher|needs[_ -]?boss|needs[_ -]?manager|cannot[_ -]?resolve|unable[_ -]?to[_ -]?resolve)\b/i.test(output)) return 'escalate';
  if (/\b(revision[_ -]?requested|request[_ -]?revision|needs[_ -]?rework|redo|retry|reject|rejected|fail|failed|blocked|not\s+approved|not\s+acceptable|cannot\s+approve)\b/i.test(output)) return 'revision_requested';
  if (/\b(pass|approve|approved|done|complete|completed|resolved)\b/i.test(output)) return 'approved';
  return mode === 'help' ? 'revision_requested' : 'approved';
}

function cardChangedOutsideCurrentRun(latest: Pick<CardRow, 'columnStatus' | 'activeHeartbeatRunId' | 'executionLockId'> | null | undefined, lockedCard: Pick<CardRow, 'columnStatus'>, runId: string): boolean {
  if (!latest) return false;
  if (latest.activeHeartbeatRunId === runId || latest.executionLockId) return false;
  return (normalizeCardStatus(latest.columnStatus) ?? 'todo') !== (normalizeCardStatus(lockedCard.columnStatus) ?? 'todo');
}

function goalScopeLabel(goal: GoalRow): string {
  if (goal.projectId) return 'Project goal';
  if (goal.departmentId) return 'Department goal';
  return 'Company goal';
}

function formatGoal(goal: GoalRow): string {
  return `- ${goalScopeLabel(goal)}: ${goal.title}${goal.body ? `\n  ${clipText(goal.body, 1200)}` : ''}`;
}

function runtimeLocalLines(runtime: RuntimeRow | null | undefined): string[] {
  if (!runtime) return ['Runtime-local workspace root: not configured', 'Runtime-local scratch root: not configured'];
  return [
    `Runtime-local workspace root: ${runtime.localWorkspaceRoot ?? 'not configured'}`,
    `Runtime-local scratch root: ${runtime.localScratchRoot ?? 'not configured'}`,
  ];
}

function projectRepoLines(project: ProjectRow | null | undefined, runtime?: RuntimeRow | null): string[] {
  if (!project) return ['Project repository: none', ...runtimeLocalLines(runtime)];
  return [
    `Project repository provider: ${project.repoProvider ?? 'github'}`,
    `Project repository URL: ${project.repoUrl ?? 'not configured'}`,
    `Project work path: ${project.workPath ?? 'project root'}`,
    ...runtimeLocalLines(runtime),
    `Default branch: ${project.defaultBranch ?? 'main'}`,
    `Protected branches: ${(project.protectedBranches ?? ['main', 'master']).join(', ') || 'none'}`,
    `Task branch pattern: ${project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}'}`,
    `Pull before run: ${project.pullBeforeRun === false ? 'no' : 'yes'}`,
    `Push after run: ${project.pushAfterRun === false ? 'no' : 'yes'}`,
    `Completion policy: ${project.completionPolicy ?? 'push_or_pr'}`,
    project.setupCommand ? `Setup command: ${project.setupCommand}` : '',
    project.testCommand ? `Test command: ${project.testCommand}` : '',
    project.workspacePathHint ? `Runtime-local workspace hint: ${project.workspacePathHint}` : '',
    `Runtime services: ${clipText(JSON.stringify(project.runtimeServices ?? {}), 1200)}`,
  ].filter(Boolean);
}

function projectGitProtocol(project: ProjectRow | null | undefined, card: CardRow, agent: AgentRow | null | undefined, runtime?: RuntimeRow | null): string {
  const localRoots = runtimeLocalLines(runtime).join('\n');
  if (!project?.repoUrl) return [
    'No repository is configured for this project. Do not invent shared local file paths; use runtime-local scratch only for temporary work and report external work products by URL when available.',
    localRoots,
  ].join('\n');
  const branchPattern = project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}';
  const branch = branchPattern
    .replaceAll('{cardId}', card.id.slice(0, 8))
    .replaceAll('{agentSlug}', agent?.slug ?? 'agent')
    .replaceAll('{projectId}', project.id.slice(0, 8));
  return [
    'Repository workflow:',
    `1. Use repo ${project.repoUrl}. Your local clone path is runtime-owned; MegaCorps does not assume a shared folder path.`,
    localRoots,
    `2. Clone/cache the repo under the runtime-local workspace root when configured; otherwise choose a safe local folder owned by your runtime.`,
    `3. Treat project work path as ${project.workPath ?? 'project root'}. Stay inside that path unless the task explicitly requires a broader change.`,
    project.pullBeforeRun === false ? '4. Pull-before-run is disabled for this project.' : `4. Before editing, fetch the latest ${project.defaultBranch ?? 'main'} and pull/rebase so your local workspace is current.`,
    `5. Work on branch ${branch}; do not push directly to protected branches (${(project.protectedBranches ?? ['main', 'master']).join(', ') || 'none'}).`,
    project.setupCommand ? `6. Run setup when needed: ${project.setupCommand}` : '6. Run project setup only when needed and report any failure.',
    project.testCommand ? `7. Validate with: ${project.testCommand}` : '7. Run the most relevant tests/checks available in the repo/work path.',
    project.pushAfterRun === false ? '8. Push-after-run is disabled; report the local result and blocker clearly.' : `8. Commit and push your branch when work is complete. Prefer a pull request when policy is ${project.completionPolicy ?? 'push_or_pr'}.`,
    '9. Include workProducts in the webhook payload: pull_request, commit, preview_url, report, screenshot, artifact, or external metadata as applicable. Never use runtime-local file paths as the final artifact reference unless the user explicitly asked for local-only work.',
    '10. If you report status=waiting_on_external, include pollIntervalSeconds when polling is appropriate. Choose the interval yourself based on the external system, minimum 30 seconds.',
  ].join('\n');
}

function applicableGoals(goalsRows: GoalRow[], input: { departmentId?: string | null; projectId?: string | null; selectedGoalId?: string | null }): GoalRow[] {
  const selected = input.selectedGoalId ? goalsRows.find((goal) => goal.id === input.selectedGoalId) : undefined;
  const rows = goalsRows.filter((goal) => {
    if (!goal.departmentId && !goal.projectId) return true;
    if (goal.departmentId && input.departmentId && goal.departmentId === input.departmentId) return true;
    if (goal.projectId && input.projectId && goal.projectId === input.projectId) return true;
    return false;
  });
  if (selected && !rows.some((goal) => goal.id === selected.id)) rows.push(selected);
  return rows;
}

async function addTaskLog(input: {
  cardId: string;
  agentId?: string | null;
  type: string;
  status: LogStatus;
  message: string;
  output?: string;
  costUsd?: number;
  durationSeconds?: number;
}) {
  const [log] = await db.insert(taskLogs).values({
    cardId: input.cardId,
    agentId: input.agentId ?? null,
    type: input.type,
    status: input.status,
    message: input.message,
    output: input.output,
    costUsd: input.costUsd?.toString(),
    durationSeconds: input.durationSeconds,
  }).returning();
  const [card] = await db.select({ companyId: kanbanCards.companyId, projectId: kanbanCards.projectId }).from(kanbanCards).where(eq(kanbanCards.id, input.cardId)).limit(1);
  if (card && log) publishLiveEvent({ type: 'task_log.created', companyId: card.companyId, entityType: 'task_log', entityId: log.id, cardId: input.cardId, projectId: card.projectId, action: input.type });
}

async function addCardMessage(input: { cardId: string; agentId?: string | null; authorType?: 'agent' | 'system'; action: string; body: string }) {
  const [comment] = await db.insert(cardComments).values({
    cardId: input.cardId,
    agentId: input.agentId ?? null,
    authorType: input.authorType ?? 'agent',
    authorId: null,
    action: input.action,
    body: clipText(input.body, MESSAGE_BOARD_COMMENT_LIMIT),
  }).returning();
  const [card] = await db.select({ companyId: kanbanCards.companyId, projectId: kanbanCards.projectId }).from(kanbanCards).where(eq(kanbanCards.id, input.cardId)).limit(1);
  if (card && comment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: comment.id, cardId: input.cardId, projectId: card.projectId, action: input.action });
}

async function addStageLog(cardId: string, agentId: string | null, from: string | null, to: string, actor = 'system') {
  const fromStatus = normalizeCardStatus(from) ?? 'todo';
  const toStatus = normalizeCardStatus(to) ?? 'todo';
  const action = inferCardTransitionAction(fromStatus, toStatus) ?? 'manual_move';
  const actorType = actor === 'review'
    ? 'agent:reviewer'
    : agentId
      ? 'agent:worker'
      : 'system';
  await recordStageAction({
    cardId,
    agentId,
    actor: { type: actorType, id: agentId ?? actor, agentId },
    fromStatus,
    toStatus,
    action,
    detail: `Stage changed from ${fromStatus} to ${toStatus} by ${actor}.`,
  });
}

async function addActivity(input: {
  companyId: string;
  actorType?: 'agent' | 'user' | 'system';
  actorId?: string;
  agentId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}) {
  const [event] = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType ?? 'system',
    actorId: input.actorId ?? input.agentId ?? 'system',
    agentId: input.agentId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details ?? {},
  }).returning();
  if (event) publishLiveEvent({ type: 'activity.created', companyId: input.companyId, entityType: input.entityType, entityId: input.entityId, action: input.action, data: { activityId: event.id } });
}

export async function ensureParentWaitingOnChildren(parentCardId: string | null | undefined, input: {
  childCount: number;
  actor: 'decomposition' | 'delegation' | 'webhook' | 'user' | 'system';
  agentId?: string | null;
  message?: string;
}): Promise<CardRow | null> {
  if (!parentCardId || input.childCount <= 0) return null;
  const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!parent || parent.columnStatus === 'cancelled') return parent ?? null;
  const fromStatus = normalizeCardStatus(parent.columnStatus) ?? 'todo';
  const shouldReopen = fromStatus === 'done' || fromStatus === 'in_review' || fromStatus === 'needs_review';
  const nextStatus: CardStatus = shouldReopen ? 'in_progress' : fromStatus;
  const message = input.message ?? `Parent is waiting on ${input.childCount} child card(s) before it can be completed.`;
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: shouldReopen ? nextStatus : undefined,
    rollupStatus: 'waiting_on_children',
    completedAt: null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, parent.id)).returning();
  if (shouldReopen) await addStageLog(parent.id, input.agentId ?? parent.assigneeId, parent.columnStatus, nextStatus, input.actor);
  await addTaskLog({ cardId: parent.id, agentId: input.agentId ?? parent.assigneeId, type: 'children', status: 'queued', message });
  await addActivity({
    companyId: parent.companyId,
    actorType: input.agentId ? 'agent' : 'system',
    actorId: input.agentId ?? input.actor,
    agentId: input.agentId ?? null,
    action: shouldReopen ? 'parent.reopened_for_children' : 'parent.waiting_on_children',
    entityType: 'card',
    entityId: parent.id,
    details: { childCount: input.childCount, actor: input.actor },
  });
  return updated ?? parent;
}

async function addTaskRunLog(run: TaskRunRow, status: LogStatus, message: string, output?: string) {
  await addTaskLog({
    cardId: run.cardId,
    agentId: run.agentId,
    type: 'queue',
    status,
    message,
    output,
  });
}

async function completeTaskRun(runId: string | null | undefined, input: {
  status: 'success' | 'failed' | 'cancelled';
  error?: string | null;
  output?: string | null;
  costUsd?: number;
  durationSeconds?: number;
}) {
  if (!runId) return;
  await db.update(taskRuns).set({
    status: input.status,
    error: input.error ?? null,
    output: input.output ?? null,
    costUsd: input.costUsd === undefined ? undefined : input.costUsd.toString(),
    durationSeconds: input.durationSeconds,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(taskRuns.id, runId), inArray(taskRuns.status, ['queued', 'running'])));
}

async function requeueBackpressuredTaskRun(run: TaskRunRow, message: string): Promise<boolean> {
  if (!['agent_busy', 'reviewer_busy', 'agent_runtime_unavailable', 'reviewer_runtime_unavailable'].includes(message)) return false;
  await db.update(taskRuns).set({
    status: 'queued',
    lockedBy: null,
    lockedAt: null,
    startedAt: null,
    error: `Backpressure requeue: ${message}`,
    updatedAt: new Date(),
  }).where(eq(taskRuns.id, run.id));
  await addTaskRunLog(run, 'warning', `${run.kind} task run requeued by backpressure.`, message);
  return true;
}

async function recordUncaughtDispatchFailure(run: TaskRunRow, message: string): Promise<void> {
  if (run.kind !== 'dispatch') return;
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, run.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card || isTerminalCardStatus(card.columnStatus)) return;
  const retryCount = (card.retryCount ?? 0) + 1;
  const maxRetries = card.maxRetries ?? 3;
  const blocked = retryCount >= maxRetries;
  const nextStatus = blocked ? 'blocked' : 'todo';
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: nextStatus,
    retryCount,
    nextRunAt: blocked ? null : nextBackoff(retryCount),
    lastError: message,
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, card.id)).returning();
  if (card.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, card.assigneeId));
  if (card.columnStatus !== nextStatus) await addStageLog(card.id, card.assigneeId, card.columnStatus, nextStatus, 'retry');
  await addTaskLog({
    cardId: card.id,
    agentId: card.assigneeId,
    type: 'retry',
    status: 'failed',
    message: blocked ? `Task-run failed after ${retryCount} attempt(s); card blocked.` : `Task-run failed; retry ${retryCount}/${maxRetries} scheduled.`,
    output: message,
  });
  await addActivity({
    companyId: card.companyId,
    actorType: 'system',
    actorId: TASK_RUN_WORKER_ID,
    agentId: card.assigneeId,
    action: blocked ? 'task_run.blocked_card' : 'task_run.retry_scheduled',
    entityType: 'card',
    entityId: card.id,
    details: { taskRunId: run.id, retryCount, maxRetries, error: message },
  });
  if (!updated) throw new Error('card_update_failed');
}

export async function enqueueTaskRun(cardId: string, kind: TaskRunKind = 'dispatch', source: TaskRunSource = 'manual', requestedByUserId?: string | null): Promise<TaskRunRow> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  // Recurring templates never execute themselves: the scheduler clones them into
  // normal cards on each occurrence.
  if (card.recurEveryMinutes) throw new Error('recurring_template_cannot_run');
  const [existing] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.cardId, cardId),
    eq(taskRuns.kind, kind),
    inArray(taskRuns.status, ['queued', 'running']),
  )).orderBy(desc(taskRuns.createdAt)).limit(1);
  if (existing) return existing;

  const previous = await db.select({ id: taskRuns.id }).from(taskRuns).where(and(eq(taskRuns.cardId, cardId), eq(taskRuns.kind, kind)));
  // The partial unique index task_runs_active_card_kind_uidx guarantees at most one
  // queued/running run per (card, kind); concurrent enqueues resolve to the winner row.
  const [run] = await db.insert(taskRuns).values({
    companyId: card.companyId,
    cardId: card.id,
    agentId: kind === 'review' ? card.reviewerId : card.assigneeId,
    kind,
    source,
    status: 'queued',
    priority: card.priority ?? 0,
    attemptNumber: previous.length + 1,
    maxAttempts: 1,
    requestedByUserId: requestedByUserId ?? null,
  }).onConflictDoNothing().returning();
  if (!run) {
    const [winner] = await db.select().from(taskRuns).where(and(
      eq(taskRuns.cardId, cardId),
      eq(taskRuns.kind, kind),
      inArray(taskRuns.status, ['queued', 'running']),
    )).orderBy(desc(taskRuns.createdAt)).limit(1);
    if (winner) return winner;
    throw new Error('task_run_create_failed');
  }
  await addTaskRunLog(run, 'queued', `${kind} task run queued via ${source}.`);
  await addActivity({
    companyId: card.companyId,
    actorType: requestedByUserId ? 'user' : 'system',
    actorId: requestedByUserId ?? 'queue',
    agentId: run.agentId,
    action: 'task_run.queued',
    entityType: 'task_run',
    entityId: run.id,
    details: { cardId: card.id, kind, source, attemptNumber: run.attemptNumber },
  });
  return run;
}

async function claimNextTaskRun(): Promise<TaskRunRow | null> {
  const candidates = await db.select().from(taskRuns).where(eq(taskRuns.status, 'queued')).orderBy(desc(taskRuns.priority), taskRuns.createdAt).limit(Math.max(25, TASK_RUN_CANDIDATE_SCAN_LIMIT));
  const now = new Date();
  const availabilityCache = createRuntimeAvailabilityCache();
  for (const queued of candidates) {
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, queued.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) continue;
    if (queued.kind === 'review') {
      if (!reviewCanRun(card?.columnStatus)) continue;
    } else {
      if (card.nextRunAt && card.nextRunAt > now) continue;
      if (!(await cardDependenciesMet(card.id))) continue;
    }
    const targetAgentId = queued.kind === 'review' ? card.reviewerId : card.assigneeId;
    if (!targetAgentId) continue;
    const [targetAgent] = await db.select().from(agents).where(and(eq(agents.id, targetAgentId), isNull(agents.deletedAt))).limit(1);
    if (!targetAgent || !targetAgent.isActive || targetAgent.isBusy) continue;
    if (!(await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: targetAgent.runtimeId, adapterType: targetAgent.adapterType ?? 'hermes-ssh' }, availabilityCache))) continue;
    const [claimed] = await db.update(taskRuns).set({
      status: 'running',
      lockedBy: TASK_RUN_WORKER_ID,
      lockedAt: now,
      startedAt: now,
      updatedAt: now,
    }).where(and(eq(taskRuns.id, queued.id), eq(taskRuns.status, 'queued'))).returning();
    if (claimed) return claimed;
  }
  return null;
}

async function recoverStaleTaskRuns(app: FastifyInstance): Promise<number> {
  const staleMs = Math.max(60_000, Number.isFinite(TASK_RUN_STALE_MS) ? TASK_RUN_STALE_MS : 10 * 60 * 1000);
  const rows = await rawSql`
    UPDATE task_runs
    SET status = 'queued',
        locked_by = NULL,
        locked_at = NULL,
        started_at = NULL,
        error = 'Recovered stale task-run claim.',
        updated_at = now()
    WHERE status = 'running'
      AND heartbeat_run_id IS NULL
      AND locked_at IS NOT NULL
      AND locked_at < now() - (${staleMs} * interval '1 millisecond')
    RETURNING id
  `;
  if (rows.length > 0) app.log.warn({ count: rows.length }, 'stale task-run claims requeued');
  return rows.length;
}

async function finishWorkerTaskRun(run: TaskRunRow, work: () => Promise<CardRow>) {
  const started = Date.now();
  await addTaskRunLog(run, 'running', `${run.kind} task run started by ${TASK_RUN_WORKER_ID}.`);
  try {
    const card = await work();
    const [latest] = await db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).limit(1);
    if (latest && latest.status === 'running') {
      await completeTaskRun(run.id, {
        status: 'success',
        output: `Card ${card.id} is now ${card.columnStatus ?? 'todo'}.`,
        costUsd: card.costUsd ? Number(card.costUsd) : undefined,
        durationSeconds: Math.round((Date.now() - started) / 1000),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'task_run_failed';
    if (await requeueBackpressuredTaskRun(run, message)) return;
    await completeTaskRun(run.id, { status: 'failed', error: message, durationSeconds: Math.round((Date.now() - started) / 1000) });
    await recordUncaughtDispatchFailure(run, message);
    await addTaskRunLog(run, 'failed', `${run.kind} task run failed.`, message);
    await addActivity({ companyId: run.companyId, actorType: 'system', actorId: TASK_RUN_WORKER_ID, agentId: run.agentId, action: 'task_run.failed', entityType: 'task_run', entityId: run.id, details: { cardId: run.cardId, kind: run.kind, error: message } });
  }
}

export async function processTaskRunQueue(app: FastifyInstance): Promise<{ claimed: number; completed: number; failed: number }> {
  if (taskRunWorkerClaiming) return { claimed: 0, completed: 0, failed: 0 };
  taskRunWorkerClaiming = true;
  const result = { claimed: 0, completed: 0, failed: 0 };
  try {
    await recoverStaleTaskRuns(app);
    const capacity = Math.max(0, Math.max(1, TASK_RUN_WORKER_BATCH_SIZE) - activeTaskRunIds.size);
    for (let index = 0; index < capacity; index += 1) {
      const run = await claimNextTaskRun();
      if (!run) break;
      result.claimed += 1;
      activeTaskRunIds.add(run.id);
      const work = run.kind === 'review'
        ? () => reviewCard(run.cardId, { taskRunId: run.id })
        : () => dispatchCard(run.cardId, run.source === 'manual' ? 'manual' : 'loop', { taskRunId: run.id });
      void finishWorkerTaskRun(run, work)
        .catch((error) => app.log.error({ error, taskRunId: run.id }, 'task run worker failed unexpectedly'))
        .finally(() => activeTaskRunIds.delete(run.id));
    }
  } catch (error) {
    app.log.error({ error }, 'task run queue processing failed');
  } finally {
    taskRunWorkerClaiming = false;
  }
  return result;
}

type BudgetPolicyRow = typeof budgetPolicies.$inferSelect;

export async function getBudgetGuard(agent: AgentRow, preloadedPolicies?: BudgetPolicyRow[]): Promise<{ monthlyLimit: number | null; perTaskLimit: number | null; warnAtPercent: number; hardStop: boolean }> {
  const rows = preloadedPolicies ?? await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, agent.companyId), eq(budgetPolicies.isActive, true)));
  const applicable = rows.filter((policy) => !policy.agentId || policy.agentId === agent.id);
  const monthlyLimits = [
    agent.budgetMonthly ? Number(agent.budgetMonthly) : null,
    ...applicable.map((policy) => policy.monthlyLimitUsd ? Number(policy.monthlyLimitUsd) : null),
  ].filter((value): value is number => typeof value === 'number' && value > 0);
  const perTaskLimits = [
    agent.budgetPerTask ? Number(agent.budgetPerTask) : null,
    ...applicable.map((policy) => policy.perTaskLimitUsd ? Number(policy.perTaskLimitUsd) : null),
  ].filter((value): value is number => typeof value === 'number' && value > 0);
  return {
    monthlyLimit: monthlyLimits.length ? Math.min(...monthlyLimits) : null,
    perTaskLimit: perTaskLimits.length ? Math.min(...perTaskLimits) : null,
    warnAtPercent: Math.min(...applicable.map((policy) => policy.warnAtPercent ?? 80), 80),
    hardStop: applicable.some((policy) => policy.hardStop !== false) || Boolean(agent.budgetMonthly || agent.budgetPerTask),
  };
}

export async function budgetOk(agent: AgentRow, preloadedPolicies?: BudgetPolicyRow[]): Promise<boolean> {
  const guard = await getBudgetGuard(agent, preloadedPolicies);
  if (!guard.monthlyLimit) return true;
  return Number(agent.spentThisMonth ?? 0) < guard.monthlyLimit;
}

function configuredAdapterOverrides(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => (
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
  )));
}

export async function buildExecutionAgent(agent: AgentRow, currentSessionId?: string | null) {
  const adapterType = agent.adapterType ?? 'hermes-ssh';
  let runtimeConfig: Record<string, unknown> = {};
  if (adapterRequiresRuntime(adapterType) && !agent.runtimeId) throw new Error('agent_runtime_required');
  if (agent.runtimeId) {
    const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1);
    if (!runtime) throw new Error('agent_runtime_not_found');
    if (runtime && runtime.isActive === false) throw new Error('agent_runtime_inactive');
    if (runtime.adapterType !== adapterType) throw new Error('agent_runtime_adapter_mismatch');
    const rawRuntimeConfig = (runtime.config as Record<string, unknown> | null) ?? {};
    runtimeConfig = configuredAdapterOverrides({
      ...rawRuntimeConfig,
      localWorkspaceRoot: runtime.localWorkspaceRoot ?? rawRuntimeConfig.localWorkspaceRoot,
      localScratchRoot: runtime.localScratchRoot ?? rawRuntimeConfig.localScratchRoot,
    });
  }
  const webhookSharedSecret = await configuredWebhookSharedSecret();
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    soul: agent.soul,
    adapterType,
    runtimeId: agent.runtimeId,
    hermesProfile: agent.hermesProfile,
    currentSessionId: currentSessionId === undefined ? agent.currentSessionId : currentSessionId,
    adapterConfig: {
      ...runtimeConfig,
      ...configuredAdapterOverrides(agent.adapterConfig as Record<string, unknown> | null),
      ...(webhookSharedSecret ? { webhookSharedSecret } : {}),
    },
  };
}

function supportsScopedKanbanAdapterSession(adapterType?: string | null): boolean {
  return adapterType === 'codex-app' || adapterType === 'hermes-ssh';
}

async function scopedAdapterSession(card: CardRow, agent: AgentRow, kind: TaskRunKind): Promise<AdapterSessionRow | null> {
  if (!supportsScopedKanbanAdapterSession(agent.adapterType)) return null;
  return findAdapterSession({
    companyId: card.companyId,
    agentId: agent.id,
    runtimeId: agent.runtimeId,
    adapterType: agent.adapterType ?? 'hermes-ssh',
    scopeType: 'card',
    scopeId: card.id,
    kind,
  });
}

async function rememberTaskAdapterSession(card: CardRow, agent: AgentRow, kind: TaskRunKind, result: { sessionId: string; turnId?: string | null }, taskRunId?: string | null): Promise<void> {
  if (!supportsScopedKanbanAdapterSession(agent.adapterType)) return;
  await rememberAdapterSession({
    companyId: card.companyId,
    agentId: agent.id,
    runtimeId: agent.runtimeId,
    adapterType: agent.adapterType ?? 'hermes-ssh',
    scopeType: 'card',
    scopeId: card.id,
    kind,
    adapterSessionId: result.sessionId,
    lastTurnId: result.turnId ?? null,
    taskRunId,
  });
}

function matchScore(card: CardRow, agent: AgentRow): number {
  let score = 0;
  if (card.departmentId && agent.departmentId === card.departmentId) score += 50;
  score += Math.max(0, 10 - Number(agent.spentThisMonth ?? 0));
  return score;
}

async function selectBestAgent(card: CardRow): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt)));
  const bossPositions = card.parentCardId
    ? []
    : await db.select({ id: positions.id }).from(positions).where(and(eq(positions.companyId, card.companyId), eq(positions.isCompanyBoss, true), eq(positions.isActive, true)));
  const bossPositionIds = new Set(bossPositions.map((position) => position.id));
  const companyPolicies = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, card.companyId), eq(budgetPolicies.isActive, true)));
  const availabilityCache = createRuntimeAvailabilityCache();
  const available = [];
  for (const agent of rows) {
    if (!agent.isActive || agent.isBusy) continue;
    if (!(await budgetOk(agent, companyPolicies))) continue;
    if (!(await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: agent.runtimeId, adapterType: agent.adapterType ?? 'hermes-ssh' }, availabilityCache))) continue;
    available.push(agent);
  }
  const bossAgents = available.filter((agent) => agent.positionId && bossPositionIds.has(agent.positionId));
  if (bossAgents.length > 0) return bossAgents.sort((a, b) => matchScore(card, b) - matchScore(card, a))[0] ?? null;
  return available.sort((a, b) => matchScore(card, b) - matchScore(card, a))[0] ?? null;
}

async function ensureAssigned(card: CardRow, source: string): Promise<CardRow | null> {
  if (card.assigneeId) return card;
  const agent = await selectBestAgent(card);
  if (!agent) {
    await addTaskLog({ cardId: card.id, type: source, status: 'queued', message: 'No available agent found for auto-assignment.' });
    return null;
  }
  const [updated] = await db.update(kanbanCards).set({
    assigneeId: agent.id,
    departmentId: card.departmentId ?? agent.departmentId,
    columnStatus: 'todo',
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, card.id)).returning();
  await addTaskLog({ cardId: card.id, agentId: agent.id, type: source, status: 'queued', message: `Auto-assigned to ${agent.name}.` });
  await addActivity({
    companyId: card.companyId,
    actorType: 'system',
    actorId: 'auto-assign',
    agentId: agent.id,
    action: 'card.auto_assigned',
    entityType: 'card',
    entityId: card.id,
    details: { fromAssigneeId: card.assigneeId ?? null, toAssigneeId: agent.id, source },
  });
  if (card.columnStatus !== 'todo') await addStageLog(card.id, agent.id, card.columnStatus, 'todo', 'auto-assignment');
  return updated ?? null;
}

async function openHeartbeatRun(card: CardRow, agent: AgentRow, source: string, taskRunId?: string | null): Promise<HeartbeatRunRow> {
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: card.companyId,
    cardId: card.id,
    agentId: agent.id,
    source,
    status: 'running',
    startedAt: new Date(),
  }).returning();
  if (!run) throw new Error('heartbeat_run_create_failed');
  if (taskRunId) await db.update(taskRuns).set({ heartbeatRunId: run.id, agentId: agent.id, updatedAt: new Date() }).where(eq(taskRuns.id, taskRunId));
  return run;
}

// Claims one execution slot on the agent. With maxConcurrent=1 (the default) this is
// the original atomic isBusy flip. With maxConcurrent>1, isBusy means "at capacity"
// and the claim counts running heartbeat runs against the configured limit.
async function claimAgentCapacity(agent: AgentRow): Promise<boolean> {
  const maxConcurrent = Math.max(1, agent.maxConcurrent ?? 1);
  if (maxConcurrent === 1) {
    const [row] = await db.update(agents).set({ isBusy: true }).where(and(eq(agents.id, agent.id), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
    return Boolean(row);
  }
  const rows = await rawSql`
    UPDATE agents SET is_busy = (
      (SELECT count(*) FROM heartbeat_runs hr WHERE hr.agent_id = agents.id AND hr.status = 'running') + 1 >= ${maxConcurrent}
    )
    WHERE id = ${agent.id} AND is_active = true AND deleted_at IS NULL AND (
      SELECT count(*) FROM heartbeat_runs hr WHERE hr.agent_id = agents.id AND hr.status = 'running'
    ) < ${maxConcurrent}
    RETURNING id
  `;
  return rows.length > 0;
}

function cardDispatchTimeoutSeconds(card: CardRow): number {
  const configured = card.timeoutSeconds ?? null;
  if (configured && Number.isFinite(configured) && configured >= 30) return Math.min(configured, 14_400);
  return 300;
}

function startExecutionLockRenewal(cardId: string, runId: string): () => void {
  // Long adapter runs must keep extending their lock, otherwise stale-lock recovery
  // would hand the card to another worker while this dispatch is still executing.
  const interval = setInterval(() => {
    void db.update(kanbanCards).set({
      executionLockExpiresAt: new Date(Date.now() + EXECUTION_LOCK_TTL_MS),
      updatedAt: new Date(),
    }).where(and(eq(kanbanCards.id, cardId), eq(kanbanCards.executionLockId, runId)))
      .catch(() => { /* best effort; stale-lock recovery remains the fallback */ });
  }, Math.max(30_000, Math.floor(EXECUTION_LOCK_TTL_MS / 3)));
  interval.unref?.();
  return () => clearInterval(interval);
}

async function acquireExecutionLock(card: CardRow, agent: AgentRow, run: HeartbeatRunRow, source: string): Promise<CardRow> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_LOCK_TTL_MS);
  const [locked] = await db.update(kanbanCards).set({
    executionLockId: run.id,
    executionLockedByAgentId: agent.id,
    executionLockedAt: now,
    executionLockExpiresAt: expiresAt,
    activeHeartbeatRunId: run.id,
    columnStatus: 'in_progress',
    startedAt: now,
    lastError: null,
    updatedAt: now,
  }).where(and(
    eq(kanbanCards.id, card.id),
    drizzleSql`(${kanbanCards.executionLockId} IS NULL OR ${kanbanCards.executionLockExpiresAt} < now())`,
  )).returning();
  if (!locked) {
    await db.update(heartbeatRuns).set({ status: 'cancelled', error: 'card_execution_locked', completedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    throw new Error('card_execution_locked');
  }
  await db.update(heartbeatRuns).set({ lockAcquiredAt: now }).where(eq(heartbeatRuns.id, run.id));
  await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'lock', status: 'running', message: `Execution lock acquired by ${agent.name} via ${source}.` });
  await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: 'execution.lock_acquired', entityType: 'card', entityId: card.id, details: { runId: run.id, source, expiresAt } });
  return locked;
}

async function releaseExecutionLock(cardId: string, runId: string | null, status: string, error?: string | null, costUsd?: number, durationSeconds?: number) {
  await db.update(kanbanCards).set({
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, cardId));
  if (runId) {
    await db.update(heartbeatRuns).set({
      status,
      completedAt: new Date(),
      durationSeconds,
      error: error ?? null,
      costUsd: costUsd === undefined ? undefined : costUsd.toString(),
    }).where(eq(heartbeatRuns.id, runId));
  }
}

export async function createPendingApproval(card: CardRow, agentId: string | null, reason: string) {
  const existing = await db.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.status, 'pending'))).limit(1);
  if (existing[0]) return existing[0];
  const [approval] = await db.insert(approvals).values({
    companyId: card.companyId,
    cardId: card.id,
    requestedByAgentId: agentId,
    type: 'task_review',
    status: 'pending',
    payload: { reason, title: card.title, stage: card.columnStatus },
  }).returning();
  await addTaskLog({ cardId: card.id, agentId, type: 'approval', status: 'queued', message: `Approval requested: ${reason}.` });
  await addActivity({ companyId: card.companyId, actorType: agentId ? 'agent' : 'system', actorId: agentId ?? 'system', agentId, action: 'approval.requested', entityType: 'card', entityId: card.id, details: { approvalId: approval?.id, reason } });
  await notify({ companyId: card.companyId, type: 'approval_pending', title: `Approval needed: ${card.title}`, body: reason, entityType: 'approval', entityId: approval?.id ?? card.id, cardId: card.id, agentId });
  return approval;
}

async function resolvePendingApproval(card: CardRow, status: 'approved' | 'rejected' | 'revision_requested' | 'cancelled', note: string, agentId?: string | null) {
  const [approval] = await db.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.status, 'pending'))).orderBy(desc(approvals.createdAt)).limit(1);
  if (!approval) return;
  await db.update(approvals).set({ status, decisionNote: note, decidedAt: new Date(), updatedAt: new Date() }).where(eq(approvals.id, approval.id));
  await addActivity({ companyId: card.companyId, actorType: agentId ? 'agent' : 'system', actorId: agentId ?? 'system', agentId, action: `approval.${status}`, entityType: 'approval', entityId: approval.id, details: { cardId: card.id, note } });
}

async function recordCostAndEnforceBudget(card: CardRow, agent: AgentRow, runId: string | null, costUsd: number, tokensUsed: number, durationSeconds?: number): Promise<boolean> {
  await db.insert(costEvents).values({
    companyId: card.companyId,
    agentId: agent.id,
    cardId: card.id,
    projectId: card.projectId,
    goalId: card.goalId,
    provider: agent.adapterType ?? 'unknown',
    model: agent.hermesProfile ?? 'unknown',
    outputTokens: tokensUsed,
    costUsd: costUsd.toString(),
  });
  const guard = await getBudgetGuard(agent);
  const newSpend = Number(agent.spentThisMonth ?? 0) + costUsd;
  const monthlyExceeded = guard.monthlyLimit !== null && newSpend >= guard.monthlyLimit;
  const taskExceeded = guard.perTaskLimit !== null && costUsd > guard.perTaskLimit;
  const warning = guard.monthlyLimit !== null && newSpend >= guard.monthlyLimit * (guard.warnAtPercent / 100);
  const shouldPause = guard.hardStop && (monthlyExceeded || taskExceeded);
  await db.update(agents).set({
    spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${costUsd}`,
    isBusy: false,
    isActive: shouldPause ? false : undefined,
  }).where(eq(agents.id, agent.id));
  if (runId) await db.update(heartbeatRuns).set({ costUsd: costUsd.toString(), outputTokens: tokensUsed, durationSeconds }).where(eq(heartbeatRuns.id, runId));
  if (warning || shouldPause) {
    const message = shouldPause
      ? `Budget hard stop reached; ${agent.name} paused.`
      : `Budget warning: ${agent.name} reached ${guard.warnAtPercent}% of monthly budget.`;
    await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'budget', status: shouldPause ? 'failed' : 'queued', message, costUsd });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'budget', agentId: agent.id, action: shouldPause ? 'budget.hard_stop' : 'budget.warning', entityType: 'agent', entityId: agent.id, details: { cardId: card.id, costUsd, newSpend, monthlyLimit: guard.monthlyLimit, perTaskLimit: guard.perTaskLimit, monthlyExceeded, taskExceeded } });
    if (shouldPause) {
      await db.insert(approvals).values({
        companyId: card.companyId,
        cardId: card.id,
        requestedByAgentId: agent.id,
        type: 'budget_override_required',
        status: 'pending',
        payload: { costUsd, newSpend, monthlyLimit: guard.monthlyLimit, perTaskLimit: guard.perTaskLimit, monthlyExceeded, taskExceeded },
      });
    }
    await notify({
      companyId: card.companyId,
      type: shouldPause ? 'budget_stop' : 'budget_warning',
      title: shouldPause ? `Budget hard stop: ${agent.name} paused` : `Budget warning: ${agent.name} at ${guard.warnAtPercent}% of monthly budget`,
      body: message,
      entityType: 'agent',
      entityId: agent.id,
      cardId: card.id,
      agentId: agent.id,
    });
  }
  return shouldPause;
}

export async function cascadeParentStatus(parentCardId: string | null): Promise<void> {
  if (!parentCardId) return;
  const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!parent) return;
  if (parent.columnStatus === 'done' || parent.columnStatus === 'cancelled') return;
  if (parent.requiredChildPolicy === 'manual') return;
  const children = await db.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, parentCardId), isNull(kanbanCards.deletedAt)));
  if (children.length === 0) return;
  const policy = parent.requiredChildPolicy ?? 'all_required_accepted';
  const ready = childCompletionPolicySatisfied(parent, children);
  if (!ready) return;
  const integrationReviewerId = parent.reviewerId && parent.reviewerId !== parent.assigneeId
    ? parent.reviewerId
    : parent.assigneeId ?? parent.reviewerId;
  const nextStatus = integrationReviewerId ? 'in_review' : 'done';
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: nextStatus,
    reviewerId: integrationReviewerId ?? parent.reviewerId,
    rollupStatus: nextStatus === 'in_review' ? 'ready_for_review' : 'done',
    completedAt: nextStatus === 'done' ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, parentCardId)).returning();
  if (parent.columnStatus !== nextStatus) await addStageLog(parentCardId, integrationReviewerId, parent.columnStatus ?? null, nextStatus, 'cascade');
  await addTaskLog({
    cardId: parentCardId,
    agentId: integrationReviewerId,
    type: 'cascade',
    status: 'success',
    message: integrationReviewerId
      ? `Child completion policy ${policy} satisfied; parent queued for integration review.`
      : `Child completion policy ${policy} satisfied; parent card marked done because no integrator is available.`,
  });
  await addActivity({
    companyId: parent.companyId,
    actorType: 'system',
    actorId: 'cascade',
    agentId: integrationReviewerId,
    action: integrationReviewerId ? 'parent.ready_for_integration_review' : 'parent.completed_without_integrator',
    entityType: 'card',
    entityId: parentCardId,
    details: { policy, childCount: children.length, reviewerId: integrationReviewerId },
  });
  if (!updated) throw new Error('parent_update_failed');
  if (integrationReviewerId) {
    await createPendingApproval(updated, parent.assigneeId, 'Child work is ready for parent integration review.');
    await enqueueTaskRun(parentCardId, 'review', 'queue');
  } else {
    await cascadeParentStatus(updated.parentCardId);
  }
}

async function handleDispatchFailure(card: CardRow, agent: AgentRow, error: unknown, runId?: string | null, taskRunId?: string | null): Promise<CardRow> {
  const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
  if (latest && cardChangedOutsideCurrentRun(latest, card, runId ?? '')) {
    const status = isTerminalCardStatus(latest.columnStatus) ? terminalRunStatus(latest.columnStatus) : 'success';
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    await releaseExecutionLock(card.id, runId ?? null, status);
    await completeTaskRun(taskRunId, {
      status,
      output: `Card moved to ${latest.columnStatus} before dispatch failed; preserving the current stage.`,
    });
    await addTaskLog({
      cardId: card.id,
      agentId: agent.id,
      type: 'dispatch',
      status: status === 'cancelled' ? 'warning' : status,
      message: `Dispatch error ignored because card moved to ${latest.columnStatus}.`,
      output: error instanceof Error ? error.message : 'dispatch_finished_after_external_status',
    });
    return latest;
  }

  const retryCount = (card.retryCount ?? 0) + 1;
  const maxRetries = card.maxRetries ?? 3;
  const message = error instanceof Error ? error.message : 'dispatch_failed';
  const blocked = retryCount >= maxRetries;
  const failedRunId = runId ?? card.activeHeartbeatRunId ?? null;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(kanbanCards).set({
      columnStatus: blocked ? 'blocked' : 'todo',
      retryCount,
      nextRunAt: blocked ? null : nextBackoff(retryCount),
      lastError: message,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await tx.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    if (failedRunId) {
      await tx.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: message }).where(eq(heartbeatRuns.id, failedRunId));
    }
    return row;
  });
  await addStageLog(card.id, agent.id, card.columnStatus, blocked ? 'blocked' : 'todo', 'retry');
  await addTaskLog({
    cardId: card.id,
    agentId: agent.id,
    type: 'retry',
    status: 'failed',
    message: blocked ? `Dispatch failed after ${retryCount} attempt(s); card blocked.` : `Dispatch failed; retry ${retryCount}/${maxRetries} scheduled.`,
    output: message,
  });
  await addCardMessage({ cardId: card.id, agentId: agent.id, action: blocked ? 'agent_blocked' : 'agent_error', body: message });
  await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: blocked ? 'dispatch.blocked' : 'dispatch.retry_scheduled', entityType: 'card', entityId: card.id, details: { retryCount, maxRetries, error: message } });
  if (blocked) {
    await notify({ companyId: card.companyId, type: 'card_blocked', title: `Card blocked: ${card.title}`, body: message, entityType: 'card', entityId: card.id, cardId: card.id, agentId: agent.id });
  }
  await completeTaskRun(taskRunId, { status: 'failed', error: message });
  if (!updated) throw new Error('card_update_failed');
  return updated;
}

async function sendAgentFeedbackAndRequeue(input: {
  card: CardRow;
  agent: AgentRow;
  kind: TaskRunKind;
  message: string;
  runId?: string | null;
  taskRunId?: string | null;
  output?: string | null;
  result?: { sessionId: string; turnId?: string | null; costUsd?: number; durationSeconds?: number };
}): Promise<CardRow> {
  const previousOutput = input.output?.trim();
  const feedback = [
    'MegaCorps could not accept your previous Kanban reply. Continue in the same task session and send a corrected response.',
    `Error: ${input.message}`,
    previousOutput && previousOutput !== input.message ? `Previous agent output:\n${clipText(previousOutput, 4000)}` : '',
    input.kind === 'dispatch'
      ? 'Follow the Completion protocol exactly. If delegation is required, return a valid DELEGATE block or send the same block through the webhook with status="in_progress".'
      : 'Follow the review protocol exactly. Return APPROVE/DONE, REVISION_REQUESTED with concrete guidance, or ESCALATE when your manager must decide.',
  ].filter(Boolean).join('\n\n');
  const nextStatus: CardStatus = input.kind === 'dispatch'
    ? 'todo'
    : normalizeCardStatus(input.card.columnStatus) ?? 'needs_review';
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(kanbanCards).set({
      columnStatus: nextStatus,
      executionLog: previousOutput ?? input.card.executionLog,
      lastError: input.message,
      nextRunAt: null,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, input.card.id)).returning();
    await tx.update(agents).set({
      currentSessionId: input.result?.sessionId,
      isBusy: false,
    }).where(eq(agents.id, input.agent.id));
    if (input.runId) {
      await tx.update(heartbeatRuns).set({
        status: 'failed',
        completedAt: new Date(),
        error: input.message,
        durationSeconds: input.result?.durationSeconds,
        costUsd: input.result?.costUsd === undefined ? undefined : input.result.costUsd.toString(),
      }).where(eq(heartbeatRuns.id, input.runId));
    }
    return row;
  });
  if (input.kind === 'dispatch' && input.card.columnStatus !== nextStatus) {
    await addStageLog(input.card.id, input.agent.id, input.card.columnStatus, nextStatus, 'feedback');
  }
  await addTaskLog({
    cardId: input.card.id,
    agentId: input.agent.id,
    type: input.kind,
    status: 'warning',
    message: 'Agent reply rejected; correction feedback was sent back to the same agent session and the card was requeued without increasing card retry count.',
    output: feedback,
    costUsd: input.result?.costUsd,
    durationSeconds: input.result?.durationSeconds,
  });
  await addCardMessage({
    cardId: input.card.id,
    agentId: input.agent.id,
    action: input.kind === 'dispatch' ? 'agent_error' : 'review_error',
    body: feedback,
  });
  await addActivity({
    companyId: input.card.companyId,
    actorType: 'system',
    actorId: 'feedback',
    agentId: input.agent.id,
    action: `${input.kind}.feedback_requeued`,
    entityType: 'card',
    entityId: input.card.id,
    details: { taskRunId: input.taskRunId, runId: input.runId, error: input.message },
  });
  await completeTaskRun(input.taskRunId, {
    status: 'failed',
    error: input.message,
    output: feedback,
    costUsd: input.result?.costUsd,
    durationSeconds: input.result?.durationSeconds,
  });
  await enqueueTaskRun(input.card.id, input.kind, 'queue');
  if (!updated) throw new Error('card_update_failed');
  return updated;
}

export async function dispatchCard(cardId: string, source: 'manual' | 'loop' = 'manual', options: { taskRunId?: string | null } = {}): Promise<CardRow> {
  let [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  if (!card.assigneeId) {
    const assigned = await ensureAssigned(card, source);
    if (!assigned) throw new Error('card_has_no_available_agent');
    card = assigned;
  }
  if (!card.assigneeId) throw new Error('card_has_no_assignee');
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, card.assigneeId), isNull(agents.deletedAt))).limit(1);
  if (!agent) throw new Error('agent_not_found');
  if (!agent.isActive) throw new Error('agent_paused');
  if (agent.isBusy) throw new Error('agent_busy');
  if (!(await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: agent.runtimeId, adapterType: agent.adapterType ?? 'hermes-ssh' }))) throw new Error('agent_runtime_unavailable');
  if (!(await budgetOk(agent))) {
    await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, agent.id));
    await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'budget', status: 'failed', message: `Agent ${agent.name} is over budget and was paused before dispatch.` });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'budget', agentId: agent.id, action: 'budget.preflight_hard_stop', entityType: 'agent', entityId: agent.id, details: { cardId: card.id } });
    throw new Error('agent_budget_exceeded');
  }
  if (!(await cardDependenciesMet(card.id))) throw new Error('card_dependencies_not_met');

  if (!(await claimAgentCapacity(agent))) throw new Error('agent_busy');
  const run = await openHeartbeatRun(card, agent, source, options.taskRunId);
  let lockedCard = card;
  try {
    lockedCard = await acquireExecutionLock(card, agent, run, source);
    if (card.columnStatus !== 'in_progress') await addStageLog(card.id, agent.id, card.columnStatus, 'in_progress', source);
    await addTaskLog({ cardId: card.id, agentId: agent.id, type: source, status: 'running', message: `Dispatch started via ${source}.` });
  } catch (error) {
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    throw error;
  }

  try {
    const adapter = getAdapter(agent.adapterType ?? 'hermes-ssh');
    const adapterSession = await scopedAdapterSession(card, agent, 'dispatch');
    const adapterSessionId = adapterSession?.adapterSessionId ?? null;
    const executionAgent = await buildExecutionAgent(agent, adapterSessionId);
    const taskPrompt = await buildTaskPrompt(card, { continuation: Boolean(adapterSessionId), since: adapterSession?.updatedAt ?? null, kind: 'dispatch' });
    const task = { id: card.id, title: card.title, body: taskPrompt, timeoutSeconds: cardDispatchTimeoutSeconds(card), taskRunId: options.taskRunId };
    await recordPromptLog({
      companyId: card.companyId,
      agentId: agent.id,
      cardId: card.id,
      projectId: card.projectId,
      goalId: card.goalId,
      heartbeatRunId: run.id,
      taskRunId: options.taskRunId ?? null,
      source: 'dispatch',
      adapterType: agent.adapterType ?? 'hermes-ssh',
      title: card.title,
      prompt: promptSnapshotForAdapter(executionAgent, task),
      metadata: { adapterSessionId, source, megacorpsPromptChars: taskPrompt.length, contextMode: adapterSessionId ? 'adapter_session_delta' : 'full_bootstrap' },
    });
    const stopLockRenewal = startExecutionLockRenewal(card.id, run.id);
    let result: Awaited<ReturnType<typeof adapter.dispatch>>;
    try {
      result = await adapter.dispatch(executionAgent, task);
    } finally {
      stopLockRenewal();
    }
    const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
    if (latest && cardChangedOutsideCurrentRun(latest, lockedCard, run.id)) {
      if (result.success) await rememberTaskAdapterSession(card, agent, 'dispatch', result, options.taskRunId);
      const status = isTerminalCardStatus(latest.columnStatus) ? terminalRunStatus(latest.columnStatus) : 'success';
      await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
      await releaseExecutionLock(card.id, run.id, status);
      await completeTaskRun(options.taskRunId, {
        status,
        output: `Card moved to ${latest.columnStatus} before dispatch returned; preserving the current stage.`,
        durationSeconds: result.durationSeconds,
      });
      await addTaskLog({
        cardId: card.id,
        agentId: agent.id,
        type: 'dispatch',
        status: status === 'cancelled' ? 'warning' : status,
        message: `Dispatch output received after card moved to ${latest.columnStatus}; keeping the current stage.`,
        output: result.output,
        durationSeconds: result.durationSeconds,
      });
      return latest;
    }
    if (!result.success) {
      await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      await rememberTaskAdapterSession(card, agent, 'dispatch', result, options.taskRunId);
      return sendAgentFeedbackAndRequeue({
        card: lockedCard,
        agent,
        kind: 'dispatch',
        message: result.output || 'adapter_reported_failure',
        runId: run.id,
        taskRunId: options.taskRunId,
        output: result.output,
        result,
      });
    }
    await rememberTaskAdapterSession(card, agent, 'dispatch', result, options.taskRunId);
    let delegatedRows: Awaited<ReturnType<typeof createDelegatedSubtasks>>;
    try {
      delegatedRows = await createDelegatedSubtasks(card, agent, delegationItems(result.output));
    } catch (error) {
      await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      return sendAgentFeedbackAndRequeue({
        card: lockedCard,
        agent,
        kind: 'dispatch',
        message: error instanceof Error ? error.message : 'delegation_failed',
        runId: run.id,
        taskRunId: options.taskRunId,
        output: result.output,
        result,
      });
    }
    if (delegatedRows.length > 0) {
      const budgetPaused = await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      const updated = await db.transaction(async (tx) => {
        await tx.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
        const [row] = await tx.update(kanbanCards).set({
          columnStatus: 'in_progress',
          rollupStatus: 'waiting_on_children',
          executionLog: result.output,
          sessionId: result.sessionId,
          costUsd: result.costUsd.toString(),
          retryCount: 0,
          nextRunAt: null,
          completedAt: null,
          lastError: null,
          executionLockId: null,
          executionLockedByAgentId: null,
          executionLockedAt: null,
          executionLockExpiresAt: null,
          activeHeartbeatRunId: null,
          updatedAt: new Date(),
        }).where(eq(kanbanCards.id, card.id)).returning();
        await tx.update(heartbeatRuns).set({
          status: 'success',
          completedAt: new Date(),
          durationSeconds: result.durationSeconds,
          error: null,
          costUsd: result.costUsd.toString(),
        }).where(eq(heartbeatRuns.id, run.id));
        return row;
      });
      await addTaskLog({
        cardId: card.id,
        agentId: agent.id,
        type: 'decomposition',
        status: 'success',
        message: `Delegation plan accepted; ${delegatedRows.length} sub-task(s) queued for direct reports.`,
        output: result.output,
        costUsd: result.costUsd,
        durationSeconds: result.durationSeconds,
      });
      await addCardMessage({ cardId: card.id, agentId: agent.id, action: 'agent_delegated', body: result.output });
      await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: 'dispatch.delegated', entityType: 'card', entityId: card.id, details: { runId: run.id, childCount: delegatedRows.length, budgetPaused } });
      await completeTaskRun(options.taskRunId, { status: 'success', output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
      for (const child of delegatedRows) await enqueueTaskRun(child.id, 'dispatch', 'queue');
      if (!updated) throw new Error('card_update_failed');
      return updated;
    }
    if (collaborationModeRequiresDelegation(card)) {
      const directReports = await activeDirectReportsForAgent(card.companyId, agent.id);
      if (directReports.length > 0) {
        await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
        return sendAgentFeedbackAndRequeue({
          card: lockedCard,
          agent,
          kind: 'dispatch',
          message: `collaboration_mode_requires_delegation\n\n${collaborationDelegationInstructions(directReports)}`,
          runId: run.id,
          taskRunId: options.taskRunId,
          output: result.output,
          result,
        });
      }
    }
    if (asksForConfirmationInsteadOfWorking(result.output)) {
      await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      return sendAgentFeedbackAndRequeue({
        card: lockedCard,
        agent,
        kind: 'dispatch',
        message: 'agent_asked_for_confirmation_instead_of_working: Kanban tasks are autonomous. Do not ask the user whether to proceed; complete the assigned work directly. If you truly cannot proceed, use status="needs_review" with attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs.',
        runId: run.id,
        taskRunId: options.taskRunId,
        output: result.output,
        result,
      });
    }
    const effectiveReviewerId = resolveEffectiveReviewerId(card, agent);
    const { needsHelpReview, nextStatus, topLevelGuidanceAccepted } = dispatchCompletionDecision(result.output, effectiveReviewerId);
    const childBlock = await completionBlockedByChildren(card, nextStatus);
    const effectiveNextStatus: CardStatus = childBlock ? 'in_progress' : nextStatus;
    const budgetPaused = await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    // Agent release + card stage move + heartbeat completion commit atomically, so a
    // crash mid-completion cannot leave the agent free while the card looks running.
    const updated = await db.transaction(async (tx) => {
      await tx.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
      const [row] = await tx.update(kanbanCards).set({
        columnStatus: effectiveNextStatus,
        rollupStatus: childBlock ? 'waiting_on_children' : effectiveNextStatus === 'done' ? 'done' : undefined,
        executionLog: result.output,
        sessionId: result.sessionId,
        costUsd: result.costUsd.toString(),
        reviewerId: effectiveReviewerId,
        retryCount: 0,
        nextRunAt: null,
        completedAt: effectiveNextStatus === 'done' ? new Date() : null,
        lastError: null,
        executionLockId: null,
        executionLockedByAgentId: null,
        executionLockedAt: null,
        executionLockExpiresAt: null,
        activeHeartbeatRunId: null,
        updatedAt: new Date(),
      }).where(eq(kanbanCards.id, card.id)).returning();
      await tx.update(heartbeatRuns).set({
        status: 'success',
        completedAt: new Date(),
        durationSeconds: result.durationSeconds,
        error: null,
        costUsd: result.costUsd.toString(),
      }).where(eq(heartbeatRuns.id, run.id));
      return row;
    });
    if (effectiveNextStatus !== 'in_progress') await addStageLog(card.id, agent.id, 'in_progress', effectiveNextStatus, 'dispatch');
    if (effectiveNextStatus === 'needs_review') {
      await notify({ companyId: card.companyId, type: 'needs_review', title: `Help review requested: ${card.title}`, body: `${agent.name} requested reviewer guidance.`, entityType: 'card', entityId: card.id, cardId: card.id, agentId: agent.id });
    }
    await addTaskLog({
      cardId: card.id,
      agentId: agent.id,
      type: childBlock ? 'children' : needsHelpReview ? 'escalation' : 'dispatch',
      status: childBlock ? 'queued' : 'success',
      message: childBlock ? childBlock.message : needsHelpReview
        ? nextStatus === 'needs_review'
          ? 'Assignee requested reviewer guidance; help review queued.'
          : 'Assignee requested guidance but has no reviewer or manager; output accepted as final and card marked done.'
        : nextStatus === 'in_review'
          ? 'Dispatch completed; card moved to quality review.'
          : 'Dispatch completed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await addCardMessage({ cardId: card.id, agentId: agent.id, action: needsHelpReview && nextStatus === 'needs_review' ? 'agent_escalated' : 'agent_update', body: result.output });
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: childBlock ? 'dispatch.waiting_on_children' : needsHelpReview && nextStatus === 'needs_review' ? 'dispatch.needs_review' : 'dispatch.completed', entityType: 'card', entityId: card.id, details: { runId: run.id, requestedStatus: nextStatus, nextStatus: effectiveNextStatus, costUsd: result.costUsd, budgetPaused, reviewerId: effectiveReviewerId, escalation: needsHelpReview, topLevelGuidanceAccepted, childBlock } });
    await completeTaskRun(options.taskRunId, { status: 'success', output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    if (!updated) throw new Error('card_update_failed');
    if (effectiveNextStatus === 'in_review') {
      await createPendingApproval(updated, agent.id, card.reviewerId === effectiveReviewerId ? 'Reviewer approval required' : 'Reports-to review required');
      await enqueueTaskRun(updated.id, 'review', 'queue');
    }
    if (effectiveNextStatus === 'needs_review') {
      await createPendingApproval(updated, agent.id, 'Assignee needs reviewer guidance');
      await enqueueTaskRun(updated.id, 'review', 'queue');
    }
    if (effectiveNextStatus === 'done') await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    return handleDispatchFailure(lockedCard, agent, error, run.id, options.taskRunId);
  }
}

export async function reviewCard(cardId: string, options: { taskRunId?: string | null } = {}): Promise<CardRow> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  if (isTerminalCardStatus(card.columnStatus)) {
    const status = terminalRunStatus(card.columnStatus);
    await addTaskLog({ cardId: card.id, agentId: card.reviewerId, type: 'review', status: status === 'cancelled' ? 'warning' : status, message: `Review skipped; card is already ${card.columnStatus}.` });
    await completeTaskRun(options.taskRunId, { status, output: `Card is already ${card.columnStatus}.` });
    return card;
  }
  if (card.columnStatus !== 'in_review' && card.columnStatus !== 'needs_review') throw new Error(`card_not_ready_for_review:${card.columnStatus ?? 'todo'}`);
  const reviewMode = card.columnStatus === 'needs_review' ? 'help' : 'quality';
  const childCards = await db.select({ id: kanbanCards.id }).from(kanbanCards).where(and(eq(kanbanCards.parentCardId, card.id), isNull(kanbanCards.deletedAt)));
  const hasChildren = childCards.length > 0;
  let reviewerId = card.reviewerId;
  if (!reviewerId && hasChildren && card.assigneeId) {
    reviewerId = card.assigneeId;
    await db.update(kanbanCards).set({ reviewerId, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
    if (options.taskRunId) await db.update(taskRuns).set({ agentId: reviewerId, updatedAt: new Date() }).where(eq(taskRuns.id, options.taskRunId));
    await addTaskLog({ cardId: card.id, agentId: reviewerId, type: 'review', status: 'queued', message: 'Parent integration review assigned to the parent assignee.' });
  }
  if (reviewerId && reviewerId === card.assigneeId && !hasChildren) {
    const [assignee] = await db.select().from(agents).where(and(eq(agents.id, reviewerId), isNull(agents.deletedAt))).limit(1);
    reviewerId = assignee?.bossId && assignee.bossId !== assignee.id && assignee.bossId !== card.assigneeId ? assignee.bossId : null;
    if (reviewerId) {
      await db.update(kanbanCards).set({ reviewerId, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
      if (options.taskRunId) await db.update(taskRuns).set({ agentId: reviewerId, updatedAt: new Date() }).where(eq(taskRuns.id, options.taskRunId));
      await addTaskLog({ cardId: card.id, agentId: reviewerId, type: 'review', status: 'warning', message: 'Self-review prevented; review reassigned to the assignee manager.' });
    }
  }
  if (!reviewerId) {
    const reason = reviewMode === 'help'
      ? 'Escalation requested but no reviewer or manager is available; output accepted as final.'
      : 'Review requested but no independent reviewer or manager is available; output accepted as final.';
    const childBlock = await completionBlockedByChildren(card, 'done');
    if (childBlock) {
      const [updated] = await db.update(kanbanCards).set({
        columnStatus: 'in_progress',
        rollupStatus: 'waiting_on_children',
        lastError: null,
        completedAt: null,
        executionLockId: null,
        executionLockedByAgentId: null,
        executionLockedAt: null,
        executionLockExpiresAt: null,
        activeHeartbeatRunId: null,
        updatedAt: new Date(),
      }).where(eq(kanbanCards.id, card.id)).returning();
      await addStageLog(card.id, null, card.columnStatus, 'in_progress', 'review');
      await addTaskLog({ cardId: card.id, type: 'children', status: 'queued', message: childBlock.message });
      await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_waiting_on_children', body: childBlock.message });
      await resolvePendingApproval(card, 'cancelled', childBlock.message);
      await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review', action: 'review.waiting_on_children', entityType: 'card', entityId: card.id, details: { reason, mode: reviewMode, childBlock } });
      await completeTaskRun(options.taskRunId, { status: 'success', output: childBlock.message });
      if (!updated) throw new Error('card_update_failed');
      return updated;
    }
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: 'done',
      rollupStatus: 'done',
      lastError: null,
      completedAt: new Date(),
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await addStageLog(card.id, null, card.columnStatus, 'done', 'review');
    await addTaskLog({ cardId: card.id, type: 'review', status: 'success', message: reason });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_auto_approved', body: reason });
    await resolvePendingApproval(card, 'approved', reason);
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review', action: 'review.auto_approved_no_reviewer', entityType: 'card', entityId: card.id, details: { reason, mode: reviewMode } });
    await completeTaskRun(options.taskRunId, { status: 'success', output: reason });
    if (!updated) throw new Error('card_update_failed');
    await cascadeParentStatus(updated.parentCardId);
    return updated;
  }

  const [reviewer] = await db.select().from(agents).where(and(eq(agents.id, reviewerId), isNull(agents.deletedAt))).limit(1);
  if (!reviewer) throw new Error('reviewer_not_found');
  if (reviewer.isBusy) throw new Error('reviewer_busy');
  if (!(await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: reviewer.runtimeId, adapterType: reviewer.adapterType ?? 'hermes-ssh' }))) throw new Error('reviewer_runtime_unavailable');

  if (!(await claimAgentCapacity(reviewer))) throw new Error('reviewer_busy');
  const run = await openHeartbeatRun(card, reviewer, 'review', options.taskRunId);
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'running', message: 'Review started.' });
  try {
    const adapter = getAdapter(reviewer.adapterType ?? 'hermes-ssh');
    const promptCard = reviewerId === card.reviewerId ? card : { ...card, reviewerId };
    const adapterSession = await scopedAdapterSession(card, reviewer, 'review');
    const adapterSessionId = adapterSession?.adapterSessionId ?? null;
    const executionAgent = await buildExecutionAgent(reviewer, adapterSessionId);
    const reviewPrompt = await buildReviewPrompt(promptCard, { continuation: Boolean(adapterSessionId), since: adapterSession?.updatedAt ?? null, kind: 'review' });
    const reviewTask = { id: card.id, title: `Review: ${card.title}`, body: reviewPrompt, timeoutSeconds: 180, taskRunId: options.taskRunId };
    await recordPromptLog({
      companyId: card.companyId,
      agentId: reviewer.id,
      cardId: card.id,
      projectId: card.projectId,
      goalId: card.goalId,
      heartbeatRunId: run.id,
      taskRunId: options.taskRunId ?? null,
      source: 'review',
      adapterType: reviewer.adapterType ?? 'hermes-ssh',
      title: reviewTask.title,
      prompt: promptSnapshotForAdapter(executionAgent, reviewTask),
      metadata: { adapterSessionId, reviewMode, megacorpsPromptChars: reviewPrompt.length, contextMode: adapterSessionId ? 'adapter_session_delta' : 'full_bootstrap' },
    });
    const result = await adapter.dispatch(executionAgent, reviewTask);
    const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
    if (latest && isTerminalCardStatus(latest.columnStatus) && latest.columnStatus !== card.columnStatus && latest.activeHeartbeatRunId !== run.id) {
      if (result.success) await rememberTaskAdapterSession(card, reviewer, 'review', result, options.taskRunId);
      const status = terminalRunStatus(latest.columnStatus);
      await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, reviewer.id));
      await db.update(heartbeatRuns).set({ status, completedAt: new Date(), durationSeconds: result.durationSeconds }).where(eq(heartbeatRuns.id, run.id));
      await completeTaskRun(options.taskRunId, {
        status,
        output: `Card was already ${latest.columnStatus} before review returned.`,
        durationSeconds: result.durationSeconds,
      });
      await addTaskLog({
        cardId: card.id,
        agentId: reviewer.id,
        type: 'review',
        status: status === 'cancelled' ? 'warning' : status,
        message: `Review output received after card was already ${latest.columnStatus}; keeping the current stage.`,
        output: result.output,
        durationSeconds: result.durationSeconds,
      });
      return latest;
    }
    await recordCostAndEnforceBudget(card, reviewer, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    const explicitDecision = explicitReviewDecision(result.output);
    if (!result.success && !explicitDecision) {
      await rememberTaskAdapterSession(card, reviewer, 'review', result, options.taskRunId);
      return sendAgentFeedbackAndRequeue({
        card,
        agent: reviewer,
        kind: 'review',
        message: result.output || 'review_adapter_reported_failure',
        runId: run.id,
        taskRunId: options.taskRunId,
        output: result.output,
        result,
      });
    }
    await rememberTaskAdapterSession(card, reviewer, 'review', result, options.taskRunId);
    if (asksForConfirmationInsteadOfWorking(result.output)) {
      return sendAgentFeedbackAndRequeue({
        card,
        agent: reviewer,
        kind: 'review',
        message: 'reviewer_asked_for_confirmation_instead_of_deciding: Kanban review tasks require a decision. Do not ask the user whether to proceed; return APPROVE/DONE, REVISION_REQUESTED with concrete guidance, or ESCALATE if your manager must decide.',
        runId: run.id,
        taskRunId: options.taskRunId,
        output: result.output,
        result,
      });
    }
    const decision = explicitDecision ?? reviewDecision(result.output, reviewMode);
    const acceptedReviewOutput = result.success || Boolean(explicitDecision);
    await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, reviewer.id));

    if (decision === 'escalate') {
      const nextReviewerId = reviewer.bossId && reviewer.bossId !== reviewer.id && reviewer.bossId !== card.assigneeId ? reviewer.bossId : null;
      if (nextReviewerId) {
        const [updated] = await db.update(kanbanCards).set({
          columnStatus: 'needs_review',
          reviewerId: nextReviewerId,
          reviewFeedback: result.output,
          completedAt: null,
          updatedAt: new Date(),
        }).where(eq(kanbanCards.id, card.id)).returning();
        await addTaskLog({
          cardId: card.id,
          agentId: reviewer.id,
          type: 'review',
          status: 'warning',
          message: 'Reviewer escalated the help review to their manager.',
          output: result.output,
          costUsd: result.costUsd,
          durationSeconds: result.durationSeconds,
        });
        await addCardMessage({ cardId: card.id, agentId: reviewer.id, action: 'review_escalated', body: result.output });
        await db.update(heartbeatRuns).set({ status: 'success', completedAt: new Date(), durationSeconds: result.durationSeconds }).where(eq(heartbeatRuns.id, run.id));
        await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: 'review.escalated', entityType: 'card', entityId: card.id, details: { runId: run.id, costUsd: result.costUsd, nextReviewerId } });
        await completeTaskRun(options.taskRunId, { status: 'success', output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
        if (!updated) throw new Error('card_update_failed');
        await enqueueTaskRun(updated.id, 'review', 'queue');
        return updated;
      }
      const reason = 'Reviewer could not resolve the task and has no manager to escalate to; card blocked.';
      const [updated] = await db.update(kanbanCards).set({
        columnStatus: 'blocked',
        reviewFeedback: result.output,
        lastError: reason,
        completedAt: null,
        updatedAt: new Date(),
      }).where(eq(kanbanCards.id, card.id)).returning();
      await addStageLog(card.id, reviewer.id, card.columnStatus, 'blocked', 'review');
      await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'failed', message: reason, output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
      await addCardMessage({ cardId: card.id, agentId: reviewer.id, action: 'review_blocked', body: result.output });
      await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), durationSeconds: result.durationSeconds, error: reason }).where(eq(heartbeatRuns.id, run.id));
      await resolvePendingApproval(card, 'cancelled', reason, reviewer.id);
      await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: 'review.blocked', entityType: 'card', entityId: card.id, details: { runId: run.id, costUsd: result.costUsd, reason } });
      await completeTaskRun(options.taskRunId, { status: 'failed', error: reason, output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
      if (!updated) throw new Error('card_update_failed');
      return updated;
    }

    const rejected = decision === 'revision_requested';
    const targetStatus: CardStatus = rejected ? 'todo' : 'done';
    const childBlock = rejected ? null : await completionBlockedByChildren(card, targetStatus);
    const effectiveNextStatus: CardStatus = childBlock ? 'in_progress' : targetStatus;
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: effectiveNextStatus,
      rollupStatus: childBlock ? 'waiting_on_children' : effectiveNextStatus === 'done' ? 'done' : undefined,
      reviewFeedback: result.output,
      completedAt: effectiveNextStatus === 'done' ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await addStageLog(card.id, reviewer.id, card.columnStatus, effectiveNextStatus, 'review');
    await addTaskLog({
      cardId: card.id,
      agentId: reviewer.id,
      type: childBlock ? 'children' : 'review',
      status: childBlock ? 'queued' : acceptedReviewOutput ? 'success' : 'failed',
      message: childBlock ? childBlock.message : rejected
        ? reviewMode === 'help' ? 'Reviewer provided guidance; card returned to todo for rework.' : 'Review rejected; card returned to todo.'
        : reviewMode === 'help' ? 'Reviewer resolved the escalated task; card marked done.' : 'Review passed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await addCardMessage({ cardId: card.id, agentId: reviewer.id, action: childBlock ? 'review_waiting_on_children' : rejected ? (reviewMode === 'help' ? 'review_guidance' : 'review_rejected') : 'review_note', body: childBlock ? `${childBlock.message}\n\n${result.output}` : result.output });
    await db.update(heartbeatRuns).set({ status: acceptedReviewOutput ? 'success' : 'failed', completedAt: new Date(), durationSeconds: result.durationSeconds, error: acceptedReviewOutput ? null : result.output }).where(eq(heartbeatRuns.id, run.id));
    await resolvePendingApproval(card, childBlock ? 'cancelled' : rejected ? (reviewMode === 'help' ? 'revision_requested' : 'rejected') : 'approved', childBlock ? childBlock.message : rejected ? result.output : 'Reviewer approved task.', reviewer.id);
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: childBlock ? 'review.waiting_on_children' : rejected ? (reviewMode === 'help' ? 'review.revision_requested' : 'review.rejected') : 'review.approved', entityType: 'card', entityId: card.id, details: { runId: run.id, costUsd: result.costUsd, mode: reviewMode, childBlock } });
    await completeTaskRun(options.taskRunId, { status: rejected ? 'failed' : 'success', error: rejected ? result.output : null, output: childBlock ? childBlock.message : result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    if (!updated) throw new Error('card_update_failed');
    if (!rejected && !childBlock) await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, reviewer.id));
    await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: error instanceof Error ? error.message : 'review_failed' }).where(eq(heartbeatRuns.id, run.id));
    await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'failed', message: error instanceof Error ? error.message : 'review_failed' });
    await addCardMessage({ cardId: card.id, agentId: reviewer.id, action: 'review_error', body: error instanceof Error ? error.message : 'review_failed' });
    await completeTaskRun(options.taskRunId, { status: 'failed', error: error instanceof Error ? error.message : 'review_failed' });
    throw error;
  }
}

export async function decomposeCard(cardId: string): Promise<CardRow[]> {
  const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!parent) throw new Error('card_not_found');
  const directReports = parent.assigneeId
    ? await activeDirectReportsForAgent(parent.companyId, parent.assigneeId)
    : [];
  const items = parent.body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  const titles = items.length > 1 ? items : [`Plan ${parent.title}`, `Execute ${parent.title}`, `Review ${parent.title}`];
  const rows = await db.insert(kanbanCards).values(titles.map((title, index) => {
    const delegate = directReports.length ? directReports[index % directReports.length] : null;
    return {
      companyId: parent.companyId,
      departmentId: delegate?.departmentId ?? parent.departmentId,
      projectId: parent.projectId,
      goalId: parent.goalId,
      parentCardId: parent.id,
      title,
      body: `Sub-task for ${parent.title}\n\n${title}`,
      columnStatus: 'todo',
      priority: parent.priority,
      tags: [...(parent.tags ?? []), 'subtask'],
      assigneeId: delegate?.id ?? parent.assigneeId,
      reviewerId: delegate ? parent.assigneeId : parent.reviewerId,
      requiresApproval: parent.requiresApproval || Boolean(delegate),
      decisionMode: parent.decisionMode,
      requiredChildPolicy: parent.requiredChildPolicy,
      childRequirementLevel: parent.childRequirementLevel,
      createdBy: parent.createdBy,
    };
  })).returning();
  await ensureParentWaitingOnChildren(parent.id, {
    childCount: rows.length,
    actor: 'decomposition',
    agentId: parent.assigneeId,
    message: directReports.length
      ? `Parent is waiting on ${rows.length} delegated sub-task(s) before integration.`
      : `Parent is waiting on ${rows.length} sub-task(s) before completion.`,
  });
  await addTaskLog({ cardId: parent.id, type: 'decomposition', status: 'success', message: directReports.length ? `Created ${rows.length} sub-task(s) and delegated them to direct reports.` : `Created ${rows.length} sub-task(s).` });
  await addActivity({ companyId: parent.companyId, actorType: 'system', actorId: 'decomposition', agentId: parent.assigneeId, action: 'card.decomposed', entityType: 'card', entityId: parent.id, details: { childCount: rows.length, delegatedToReports: directReports.length > 0 } });
  return rows;
}

export async function createDelegatedSubtasks(parent: CardRow, leader: AgentRow, titles: string[]): Promise<CardRow[]> {
  if (titles.length === 0) return [];
  const allDirectReports = await db.select().from(agents).where(and(eq(agents.companyId, parent.companyId), eq(agents.bossId, leader.id), eq(agents.isActive, true), isNull(agents.deletedAt)));
  const directReports = await activeDirectReportsForAgent(parent.companyId, leader.id);
  if (directReports.length === 0) return [];
  const availableIds = new Set(directReports.map((report) => report.id));
  const unavailableDirectReports = allDirectReports.filter((report) => !availableIds.has(report.id));
  const rows = await db.insert(kanbanCards).values(titles.map((rawTitle, index) => {
    const unavailableTarget = unavailableDirectReports.find((report) => {
      const lower = rawTitle.toLowerCase();
      return lower.startsWith(`${report.name}:`.toLowerCase()) || lower.startsWith(`${report.slug}:`.toLowerCase());
    });
    if (unavailableTarget) {
      throw new Error(`delegation_target_unavailable: ${unavailableTarget.name} (${unavailableTarget.slug}) is not currently available. Delegate only to available direct reports: ${directReportList(directReports)}.`);
    }
    const explicitReport = directReports.find((report) => {
      const prefix = `${report.name}:`.toLowerCase();
      const slugPrefix = `${report.slug}:`.toLowerCase();
      const lower = rawTitle.toLowerCase();
      return lower.startsWith(prefix) || lower.startsWith(slugPrefix);
    });
    const delegate = explicitReport ?? directReports[index % directReports.length]!;
    const reportPrefixes = directReports.flatMap((report) => [report.name, report.slug]).map(escapeRegex).join('|');
    const title = rawTitle.replace(new RegExp(`^(${reportPrefixes}):\\s*`, 'i'), '').trim() || rawTitle;
    return {
      companyId: parent.companyId,
      departmentId: delegate?.departmentId ?? parent.departmentId,
      projectId: parent.projectId,
      goalId: parent.goalId,
      parentCardId: parent.id,
      title,
      body: `Delegated by ${leader.name} from ${parent.title}\n\n${title}`,
      columnStatus: 'todo',
      priority: parent.priority,
      tags: [...(parent.tags ?? []), 'delegated'],
      assigneeId: delegate.id,
      reviewerId: leader.id,
      requiresApproval: true,
      decisionMode: parent.decisionMode,
      requiredChildPolicy: parent.requiredChildPolicy,
      childRequirementLevel: parent.childRequirementLevel,
      createdBy: parent.createdBy,
      maxRetries: parent.maxRetries,
    };
  })).returning();
  await ensureParentWaitingOnChildren(parent.id, {
    childCount: rows.length,
    actor: 'delegation',
    agentId: leader.id,
    message: `Parent is waiting on ${rows.length} delegated sub-task(s) before integration.`,
  });
  await addTaskLog({ cardId: parent.id, agentId: leader.id, type: 'decomposition', status: 'success', message: `Created ${rows.length} delegated sub-task(s) for direct reports.` });
  await addActivity({ companyId: parent.companyId, actorType: 'agent', actorId: leader.id, agentId: leader.id, action: 'card.delegated_to_reports', entityType: 'card', entityId: parent.id, details: { childCount: rows.length, delegatedToReports: true } });
  return rows;
}

export async function getTaskLogs(cardId: string, options: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  return db.select().from(taskLogs).where(eq(taskLogs.cardId, cardId)).orderBy(desc(taskLogs.createdAt)).limit(limit).offset(offset);
}

// Recurring templates: when recur_next_at is due, clone the template into a normal
// dispatchable card and schedule the next occurrence. The conditional update on
// recur_next_at makes each occurrence claimable exactly once even with concurrent ticks.
async function spawnDueScheduledCards(app: FastifyInstance, companyIds: string[]): Promise<number> {
  if (companyIds.length === 0) return 0;
  const now = new Date();
  const due = await db.select().from(kanbanCards).where(and(
    inArray(kanbanCards.companyId, companyIds),
    isNull(kanbanCards.deletedAt),
    drizzleSql`${kanbanCards.recurEveryMinutes} IS NOT NULL`,
    drizzleSql`${kanbanCards.recurNextAt} IS NOT NULL AND ${kanbanCards.recurNextAt} <= now()`,
  )).limit(20);
  let spawned = 0;
  for (const template of due) {
    if (!template.recurNextAt) continue;
    const interval = Math.max(5, template.recurEveryMinutes ?? 5);
    // Schedule from now (not from the missed slot) so downtime does not cause a burst
    // of catch-up occurrences.
    const [claimed] = await db.update(kanbanCards).set({
      recurNextAt: new Date(now.getTime() + interval * 60_000),
      updatedAt: new Date(),
    }).where(and(eq(kanbanCards.id, template.id), eq(kanbanCards.recurNextAt, template.recurNextAt))).returning();
    if (!claimed) continue;
    const occurrenceLabel = now.toISOString().slice(0, 16).replace('T', ' ');
    const [clone] = await db.insert(kanbanCards).values({
      companyId: template.companyId,
      departmentId: template.departmentId,
      projectId: template.projectId,
      goalId: template.goalId,
      title: `${template.title} (${occurrenceLabel})`,
      body: template.body,
      columnStatus: 'todo',
      priority: template.priority,
      tags: template.tags ?? [],
      assigneeId: template.assigneeId,
      reviewerId: template.reviewerId,
      requiresApproval: template.requiresApproval,
      decisionMode: template.decisionMode,
      maxRetries: template.maxRetries,
      maxRevisions: template.maxRevisions,
      timeoutSeconds: template.timeoutSeconds,
      taskBudgetLimit: template.taskBudgetLimit,
      scheduledFromCardId: template.id,
      createdBy: template.createdBy,
    }).returning();
    if (!clone) continue;
    spawned += 1;
    await addTaskLog({ cardId: clone.id, type: 'schedule', status: 'queued', message: `Scheduled occurrence created from recurring template "${template.title}".` });
    await addActivity({
      companyId: template.companyId,
      actorType: 'system',
      actorId: 'scheduler',
      action: 'card.scheduled_occurrence_created',
      entityType: 'card',
      entityId: clone.id,
      details: { templateCardId: template.id, recurEveryMinutes: interval, nextOccurrenceAt: claimed.recurNextAt },
    });
    publishLiveEvent({ type: 'card.created', companyId: template.companyId, entityType: 'card', entityId: clone.id, cardId: clone.id, projectId: clone.projectId });
    app.log.info({ templateCardId: template.id, cloneCardId: clone.id }, 'scheduled occurrence spawned');
  }
  return spawned;
}

async function recoverStaleExecutionLocks(app: FastifyInstance) {
  const stale = await db.select().from(kanbanCards).where(drizzleSql`${kanbanCards.executionLockExpiresAt} IS NOT NULL AND ${kanbanCards.executionLockExpiresAt} < now()`);
  for (const card of stale) {
    const agentId = card.executionLockedByAgentId;
    const shouldRetry = card.columnStatus === 'in_progress';
    const retryCount = shouldRetry ? (card.retryCount ?? 0) + 1 : card.retryCount ?? 0;
    const maxRetries = card.maxRetries ?? 3;
    const blocked = shouldRetry && retryCount >= maxRetries;
    const nextStatus = shouldRetry ? (blocked ? 'blocked' : 'todo') : card.columnStatus ?? 'todo';
    const message = blocked
      ? `Execution lock expired; retry limit ${retryCount}/${maxRetries} reached and card was blocked.`
      : shouldRetry
        ? `Execution lock expired; retry ${retryCount}/${maxRetries} scheduled.`
        : 'Stale execution lock recovered.';
    await db.update(kanbanCards).set({
      columnStatus: nextStatus,
      retryCount,
      nextRunAt: shouldRetry && !blocked ? nextBackoff(retryCount) : card.nextRunAt,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      lastError: message,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id));
    if (agentId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agentId));
    if (card.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'failed', error: 'stale_execution_lock_recovered', completedAt: new Date() }).where(eq(heartbeatRuns.id, card.activeHeartbeatRunId));
    if (card.activeHeartbeatRunId) await db.update(taskRuns).set({ status: 'failed', error: 'stale_execution_lock_recovered', completedAt: new Date(), updatedAt: new Date() }).where(eq(taskRuns.heartbeatRunId, card.activeHeartbeatRunId));
    await addTaskLog({ cardId: card.id, agentId, type: 'lock_expired', status: 'warning', message });
    if (nextStatus !== (card.columnStatus ?? 'todo')) await addStageLog(card.id, agentId ?? null, card.columnStatus, nextStatus, 'stale-lock-recovery');
    if (blocked) await addTaskLog({ cardId: card.id, agentId, type: 'retry', status: 'failed', message: `Max retries exceeded after ${retryCount} attempt(s).` });
    if (blocked) await notify({ companyId: card.companyId, type: 'card_blocked', title: `Card blocked: ${card.title}`, body: message, entityType: 'card', entityId: card.id, cardId: card.id, agentId });
    if (shouldRetry) await addCardMessage({ cardId: card.id, agentId, action: blocked ? 'agent_blocked' : 'agent_error', body: message });
    await addActivity({
      companyId: card.companyId,
      actorType: 'system',
      actorId: 'recovery',
      agentId,
      action: shouldRetry ? (blocked ? 'dispatch.blocked' : 'dispatch.retry_scheduled') : 'execution.stale_lock_recovered',
      entityType: 'card',
      entityId: card.id,
      details: { runId: card.activeHeartbeatRunId, retryCount, maxRetries },
    });
    app.log.warn({ cardId: card.id, agentId }, 'stale execution lock recovered');
  }
}

export type DispatchCronStatus = typeof cronState & { companyTicks: Array<{ companyId: string; lastTickMs: number }> };
export type DispatchCronResult = {
  name: string;
  source: 'loop' | 'manual' | 'startup';
  status: 'success' | 'failed' | 'skipped';
  companyId?: string | null;
  runnerAgentId?: string | null;
  activeCompanies: number;
  cardsScanned: number;
  dispatched: number;
  reviewed: number;
  skipped: number;
  errors: number;
  budgetResetAgents: number;
  durationSeconds: number;
  error?: string | null;
};
export type DispatchCronOptions = { companyId?: string | null; runnerAgentId?: string | null; jobName?: string };

export function getDispatchCronStatus(): DispatchCronStatus {
  return {
    ...cronState,
    companyTicks: [...companyLastTick.entries()].map(([companyId, lastTickMs]) => ({ companyId, lastTickMs })),
  };
}

async function resetMonthlyBudgetsIfDue(app: FastifyInstance, now: Date): Promise<number> {
  if (process.env.BUDGET_RESET_ENABLED === 'false') return 0;
  if (now.getUTCDate() !== BUDGET_RESET_DAY) return 0;

  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const [existing] = await db.select().from(cronRuns).where(and(
    eq(cronRuns.name, 'budget-monthly-reset'),
    drizzleSql`${cronRuns.details}->>'monthKey' = ${monthKey}`,
  )).limit(1);
  if (existing) return 0;

  const agentRows = await db.select().from(agents);
  const resetRows = agentRows.filter((agent) => Number(agent.spentThisMonth ?? 0) !== 0);
  await db.update(agents).set({ spentThisMonth: '0', isBusy: false });

  const [run] = await db.insert(cronRuns).values({
    name: 'budget-monthly-reset',
    source: 'loop',
    status: 'success',
    startedAt: now,
    completedAt: new Date(),
    durationSeconds: 0,
    details: { monthKey, resetAgents: resetRows.length },
  }).returning();

  const companyIds = Array.from(new Set(agentRows.map((agent) => agent.companyId)));
  for (const companyId of companyIds) {
    await addActivity({
      companyId,
      actorType: 'system',
      actorId: 'budget-reset',
      action: 'budget.monthly_reset',
      entityType: 'company',
      entityId: companyId,
      details: { monthKey, resetAgents: resetRows.filter((agent) => agent.companyId === companyId).length, cronRunId: run?.id },
    });
  }
  app.log.info({ monthKey, resetAgents: resetRows.length }, 'monthly agent budgets reset');
  return resetRows.length;
}

export async function runDispatchCronTick(app: FastifyInstance, source: 'loop' | 'manual' | 'startup' = 'manual', options: DispatchCronOptions = {}): Promise<DispatchCronResult> {
  const started = Date.now();
  const startedAt = new Date(started);
  const jobName = options.jobName ?? 'dispatch-heartbeat';
  if (loopRunning) {
    return {
      name: jobName,
      source,
      status: 'skipped',
      companyId: options.companyId ?? null,
      runnerAgentId: options.runnerAgentId ?? null,
      activeCompanies: 0,
      cardsScanned: 0,
      dispatched: 0,
      reviewed: 0,
      skipped: 1,
      errors: 0,
      budgetResetAgents: 0,
      durationSeconds: 0,
      error: 'dispatch_cron_already_running',
    };
  }

  loopRunning = true;
  cronState.running = true;
  cronState.lastStartedAt = startedAt.toISOString();
  cronState.lastStatus = 'running';
  cronState.lastError = null;

  const [run] = await db.insert(cronRuns).values({
    name: jobName,
    source,
    status: 'running',
    startedAt,
    details: { companyId: options.companyId ?? null, runnerAgentId: options.runnerAgentId ?? null },
  }).returning();
  if (!run) {
    loopRunning = false;
    cronState.running = false;
    cronState.lastStatus = 'failed';
    cronState.lastError = 'cron_run_create_failed';
    throw new Error('cron_run_create_failed');
  }

  const result: DispatchCronResult = {
    name: jobName,
    source,
    status: 'success',
    companyId: options.companyId ?? null,
    runnerAgentId: options.runnerAgentId ?? null,
    activeCompanies: 0,
    cardsScanned: 0,
    dispatched: 0,
    reviewed: 0,
    skipped: 0,
    errors: 0,
    budgetResetAgents: 0,
    durationSeconds: 0,
    error: null,
  };

  try {
    const now = new Date();
    result.budgetResetAgents = await resetMonthlyBudgetsIfDue(app, now);
    await recoverStaleExecutionLocks(app);
    const companyRows = await db.select().from(companies);
    const scopedCompanyRows = options.companyId ? companyRows.filter((company) => company.id === options.companyId) : companyRows;
    const nowMs = Date.now();
    const activeCompanyIds = scopedCompanyRows.filter((company) => {
      if (company.autoDispatchEnabled === false) return false;
      const intervalMs = Math.max(5, company.dispatchIntervalSeconds ?? 10) * 1000;
      const last = companyLastTick.get(company.id) ?? 0;
      if (source === 'loop' && nowMs - last < intervalMs) return false;
      companyLastTick.set(company.id, nowMs);
      return true;
    }).map((company) => company.id);
    result.activeCompanies = activeCompanyIds.length;

    if (activeCompanyIds.length > 0) {
      await spawnDueScheduledCards(app, activeCompanyIds);
      // Only statuses the loop can act on; done/blocked/cancelled/in_progress cards
      // used to be loaded and skipped one by one, which scales badly with board size.
      const cards = await db.select().from(kanbanCards).where(and(
        inArray(kanbanCards.companyId, activeCompanyIds),
        isNull(kanbanCards.deletedAt),
        inArray(kanbanCards.columnStatus, ['backlog', 'todo', 'in_review', 'needs_review']),
      ));
      result.cardsScanned = cards.length;
      for (const card of cards) {
        if (card.recurEveryMinutes) { result.skipped += 1; continue; }
        if (card.scheduleAt && card.scheduleAt > now) { result.skipped += 1; continue; }
        if (card.columnStatus === 'backlog' || card.columnStatus === 'todo') {
          if (card.nextRunAt && card.nextRunAt > now) { result.skipped += 1; continue; }
          if (!(await cardDependenciesMet(card.id))) { result.skipped += 1; continue; }
          try {
            const assigned = await ensureAssigned(card, source === 'manual' ? 'manual' : 'loop');
            if (assigned || card.assigneeId) {
              await enqueueTaskRun(card.id, 'dispatch', source === 'manual' ? 'manual' : 'loop');
              result.dispatched += 1;
            } else {
              result.skipped += 1;
            }
          } catch (error) {
            result.errors += 1;
            app.log.warn({ error, cardId: card.id }, 'dispatch cron skipped card');
          }
        } else if (card.columnStatus === 'in_review' || card.columnStatus === 'needs_review') {
          try {
            await enqueueTaskRun(card.id, 'review', source === 'manual' ? 'manual' : 'loop');
            result.reviewed += 1;
          } catch (error) {
            result.errors += 1;
            app.log.warn({ error, cardId: card.id }, 'review cron skipped card');
          }
        } else {
          result.skipped += 1;
        }
      }
    }
  } catch (error) {
    result.status = 'failed';
    result.errors += 1;
    result.error = error instanceof Error ? error.message : 'dispatch_cron_failed';
    app.log.error({ error }, 'dispatch cron failed');
  } finally {
    result.durationSeconds = Math.round((Date.now() - started) / 1000);
    const completedAt = new Date();
    await db.update(cronRuns).set({
      status: result.status,
      completedAt,
      durationSeconds: result.durationSeconds,
      error: result.error ?? null,
      details: {
        companyId: result.companyId ?? null,
        runnerAgentId: result.runnerAgentId ?? null,
        activeCompanies: result.activeCompanies,
        cardsScanned: result.cardsScanned,
        dispatched: result.dispatched,
        reviewed: result.reviewed,
        skipped: result.skipped,
        errors: result.errors,
        budgetResetAgents: result.budgetResetAgents,
      },
    }).where(eq(cronRuns.id, run.id));
    loopRunning = false;
    cronState.running = false;
    cronState.lastCompletedAt = completedAt.toISOString();
    cronState.lastStatus = result.status;
    cronState.lastError = result.error ?? null;
  }

  return result;
}

export function startDispatchLoop(app: FastifyInstance): void {
  if (process.env.TASK_RUN_WORKER_ENABLED !== 'false') {
    const workerTimer = setInterval(() => { void processTaskRunQueue(app); }, TASK_RUN_WORKER_INTERVAL_MS);
    app.addHook('onClose', async () => clearInterval(workerTimer));
    void processTaskRunQueue(app);
  }
  if (!cronState.enabled) return;
  const timer = setInterval(() => { void runDispatchCronTick(app, 'loop'); }, LOOP_INTERVAL_MS);
  app.addHook('onClose', async () => clearInterval(timer));
  void runDispatchCronTick(app, 'startup');
}

export const dispatchInternals = {
  asksForConfirmationInsteadOfWorking,
  cardChangedOutsideCurrentRun,
  childCompletionPolicySatisfied,
  collaborationDelegationInstructions,
  collaborationModeRequiresDelegation,
  companyStructureLines,
  completionStatusForQualityGate,
  delegationItems,
  dispatchCompletionDecision,
  explicitReviewDecision,
  optionalDelegationInstructions,
  reviewDecision,
};

function clipText(value: string | null | undefined, maxChars: number): string {
  const text = value?.trim() ?? '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 48)).trimEnd()}\n[truncated ${text.length - maxChars} chars]`;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'n/a';
  return new Date(value).toISOString();
}

function compactCardLine(card: CardRow, agentById: Map<string, Pick<AgentRow, 'name'>>): string {
  return [
    `- [${card.columnStatus ?? 'todo'}] ${clipText(card.title, 96)}`,
    `id=${card.id}`,
    `priority=${card.priority ?? 0}`,
    `assignee=${card.assigneeId ? agentById.get(card.assigneeId)?.name ?? 'unavailable' : 'unassigned'}`,
    `reviewer=${card.reviewerId ? agentById.get(card.reviewerId)?.name ?? 'unavailable' : 'none'}`,
    `parent=${card.parentCardId ?? 'none'}`,
    `deps=${(card.dependencyCardIds ?? []).join(',') || 'none'}`,
    `tags=${(card.tags ?? []).join(',') || 'none'}`,
    `updated=${formatDate(card.updatedAt)}`,
  ].join(' | ');
}

function ancestorChain(card: CardRow, companyCards: CardRow[]): CardRow[] {
  const byId = new Map(companyCards.map((row) => [row.id, row]));
  const ancestors: CardRow[] = [];
  const seen = new Set<string>();
  let current: CardRow | undefined = card;
  while (current?.parentCardId && !seen.has(current.parentCardId)) {
    seen.add(current.parentCardId);
    const parent = byId.get(current.parentCardId);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

export function collaborationModeRequiresDelegation(card: CardRow): boolean {
  return card.decisionMode === 'delegate';
}

function hasProjectScope(options: KanbanContextOptions): boolean {
  return Object.prototype.hasOwnProperty.call(options, 'projectId');
}

function addContextSection(state: { remaining: number; sections: string[]; truncated: boolean }, title: string, body: string, maxSectionChars = 8000): void {
  const trimmed = body.trim();
  if (!trimmed || state.remaining <= 0) return;
  const allowance = Math.min(maxSectionChars, state.remaining - title.length - 8);
  if (allowance <= 0) { state.truncated = true; return; }
  const clipped = clipText(trimmed, allowance);
  state.sections.push(`## ${title}\n${clipped}`);
  state.remaining -= title.length + clipped.length + 8;
  if (trimmed.length > clipped.length) state.truncated = true;
}

export async function buildCompanyKanbanContext(companyId: string, options: KanbanContextOptions = {}): Promise<string> {
  const budget = Math.max(8000, options.budgetChars ?? CONTEXT_CHAR_BUDGET);
  const state = { remaining: budget, sections: [] as string[], truncated: false };
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [companyAgents, companyDepartments, companyPositions, companyProjects, companyGoals, companyCards, companyRuntimes, recentActivity, recentRuns] = await Promise.all([
    db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    db.select().from(departments).where(eq(departments.companyId, companyId)),
    db.select().from(positions).where(eq(positions.companyId, companyId)),
    db.select().from(projects).where(eq(projects.companyId, companyId)),
    db.select().from(goals).where(eq(goals.companyId, companyId)),
    db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId, companyId), isNull(kanbanCards.deletedAt))).orderBy(desc(kanbanCards.updatedAt)),
    db.select().from(agentRuntimes).where(eq(agentRuntimes.companyId, companyId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(desc(activityLog.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(desc(heartbeatRuns.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
  ]);
  const availabilityCache = createRuntimeAvailabilityCache();
  for (const runtime of companyRuntimes) availabilityCache.runtimes.set(runtime.id, runtime);
  const visibleAgents = await promptVisibleAgents(companyId, companyAgents, availabilityCache);
  const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const runtimeById = new Map(companyRuntimes.map((runtime) => [runtime.id, runtime]));
  const departmentById = new Map(companyDepartments.map((department) => [department.id, department]));
  const positionById = new Map(companyPositions.map((position) => [position.id, position]));
  const projectById = new Map(companyProjects.map((project) => [project.id, project]));
  const goalById = new Map(companyGoals.map((goal) => [goal.id, goal]));
  const scopedToProject = hasProjectScope(options);
  const scopedProjects = scopedToProject ? (options.projectId ? companyProjects.filter((project) => project.id === options.projectId) : []) : companyProjects;
  const scopedGoals = scopedToProject ? companyGoals.filter((goal) => !goal.projectId || goal.projectId === options.projectId) : companyGoals;
  const scopedCards = scopedToProject ? companyCards.filter((card) => options.projectId ? card.projectId === options.projectId : !card.projectId) : companyCards;
  const focusCard = options.focusCardId ? companyCards.find((card) => card.id === options.focusCardId) : undefined;
  const focusAgent = options.focusAgentId ? agentById.get(options.focusAgentId) : undefined;
  const includeGoals = options.includeGoals !== false;
  const includeInvocationPositionPrompt = options.includeInvocationPositionPrompt !== false;
  const includeFocusProjectRepo = options.includeFocusProjectRepo !== false;

  addContextSection(state, 'Company', [
    `Name: ${company?.name ?? 'unknown'}`,
    `Mission: ${company?.mission ?? 'No mission configured.'}`,
    `Auto dispatch: ${company?.autoDispatchEnabled === false ? 'off' : 'on'}`,
    `Dispatch interval seconds: ${company?.dispatchIntervalSeconds ?? 10}`,
    `Projects: ${scopedToProject ? scopedProjects.map((project) => project.name).join(', ') || 'not included for no-project chat' : companyProjects.map((project) => project.name).join(', ') || 'none'}`,
    includeGoals ? `Goals:\n${scopedGoals.map((goal) => formatGoal(goal)).join('\n') || 'none'}` : '',
  ].filter(Boolean).join('\n'), includeGoals ? 2600 : 1600);

  addContextSection(state, 'Company Structure', [
    'Company structure:',
    ...companyStructureLines({ agents: visibleAgents, departmentById, positionById }),
  ].join('\n') || 'Company structure:\nnone', 12000);

  const statusCounts = scopedCards.reduce<Record<string, number>>((acc, card) => {
    const key = card.columnStatus ?? 'todo';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const boardLines = scopedCards.slice(0, KANBAN_CONTEXT_CARD_LIMIT).map((card) => compactCardLine(card, agentById));
  addContextSection(state, 'Kanban Board Snapshot', [
    `Scope: ${scopedToProject ? options.projectId ? `project ${scopedProjects[0]?.name ?? options.projectId}` : 'no-project cards only' : 'all company cards'}`,
    `Total cards: ${scopedCards.length}`,
    `Stage counts: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`,
    ...boardLines,
    scopedCards.length > boardLines.length ? `[omitted ${scopedCards.length - boardLines.length} older cards due context limit]` : '',
  ].filter(Boolean).join('\n'), 14000);

  if (focusAgent) {
    const manager = focusAgent.bossId ? agentById.get(focusAgent.bossId) : undefined;
    const runtime = focusAgent.runtimeId ? runtimeById.get(focusAgent.runtimeId) : undefined;
    const department = focusAgent.departmentId ? departmentById.get(focusAgent.departmentId) : undefined;
    const position = focusAgent.positionId ? positionById.get(focusAgent.positionId) : undefined;
    const positionPrompt = formatAgentPositionPrompt({ positionName: position?.name, departmentName: department?.name, companyName: company?.name, customPrompt: position?.prompt });
    const reports = visibleAgents
      .filter((agent) => agent.bossId === focusAgent.id && agent.isActive !== false)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        positionName: agent.positionId ? positionById.get(agent.positionId)?.name ?? null : null,
        departmentName: agent.departmentId ? departmentById.get(agent.departmentId)?.name ?? null : null,
      }));
    const reportIds = new Set(reports.map((report) => report.id).filter(Boolean));
    const assigned = scopedCards.filter((card) => card.assigneeId === focusAgent.id && !['done', 'blocked', 'cancelled'].includes(card.columnStatus ?? 'todo')).slice(0, KANBAN_CONTEXT_RECORD_LIMIT);
    const reviews = scopedCards.filter((card) => card.reviewerId === focusAgent.id || (card.assigneeId ? reportIds.has(card.assigneeId) : false) && ['in_review', 'needs_review'].includes(card.columnStatus ?? 'todo')).slice(0, KANBAN_CONTEXT_RECORD_LIMIT);
    addContextSection(state, 'Invocation Agent Work Context', [
      `Agent: ${focusAgent.name}`,
      `Position: ${position?.name ?? 'none'}`,
      includeInvocationPositionPrompt && positionPrompt ? `Position prompt:\n${positionPrompt}` : '',
      `Runtime: ${runtime?.name ?? focusAgent.runtimeId ?? 'none'}`,
      ...runtimeLocalLines(runtime),
      `Reports to: ${manager?.name ?? 'top-level'}`,
      `Assigned open work:\n${assigned.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Review queue:\n${reviews.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
    ].join('\n'), 6000);
  }

  if (focusCard) {
    const parent = focusCard.parentCardId ? companyCards.find((card) => card.id === focusCard.parentCardId) : undefined;
    const ancestors = ancestorChain(focusCard, companyCards);
    const children = companyCards.filter((card) => card.parentCardId === focusCard.id);
    const deps = (focusCard.dependencyCardIds ?? []).map((id) => companyCards.find((card) => card.id === id)).filter((card): card is CardRow => Boolean(card));
    const focusAssignee = focusCard.assigneeId ? agentById.get(focusCard.assigneeId) : undefined;
    const focusReviewer = focusCard.reviewerId ? agentById.get(focusCard.reviewerId) : undefined;
    const focusAssigneeRuntime = focusAssignee?.runtimeId ? runtimeById.get(focusAssignee.runtimeId) : undefined;
    const requiredTools = await db.select({ cardTool: cardRequiredTools, tool: toolRegistry })
      .from(cardRequiredTools)
      .innerJoin(toolRegistry, eq(cardRequiredTools.toolId, toolRegistry.id))
      .where(eq(cardRequiredTools.cardId, focusCard.id));
    addContextSection(state, 'Focus Task Full Context', [
      `ID: ${focusCard.id}`,
      `Title: ${focusCard.title}`,
      `Stage: ${focusCard.columnStatus ?? 'todo'}`,
      `Priority: ${focusCard.priority ?? 0}`,
      `Decision mode: ${focusCard.decisionMode ?? 'not set'}`,
      `Rollup status: ${focusCard.rollupStatus ?? 'not set'}`,
      `Required child policy: ${focusCard.requiredChildPolicy ?? 'all_required_accepted'}`,
      `Child requirement level: ${focusCard.childRequirementLevel ?? 'required'}`,
      `Estimated weight: ${focusCard.estimatedWeight ?? 'not set'}`,
      `Estimated duration minutes: ${focusCard.estimatedDurationMinutes ?? 'not set'}`,
      `Task budget limit: ${focusCard.taskBudgetLimit ?? 'not set'}`,
      `Department: ${focusCard.departmentId ? departmentById.get(focusCard.departmentId)?.name ?? focusCard.departmentId : 'none'}`,
      `Project: ${focusCard.projectId ? projectById.get(focusCard.projectId)?.name ?? focusCard.projectId : 'none'}`,
      includeFocusProjectRepo ? `Project repo:\n${projectRepoLines(focusCard.projectId ? projectById.get(focusCard.projectId) : null, focusAssigneeRuntime).join('\n')}` : '',
      `Goal: ${focusCard.goalId ? goalById.get(focusCard.goalId)?.title ?? focusCard.goalId : 'none'}`,
      `Applicable goals:\n${applicableGoals(companyGoals, { departmentId: focusCard.departmentId, projectId: focusCard.projectId, selectedGoalId: focusCard.goalId }).map((goal) => formatGoal(goal)).join('\n') || 'none'}`,
      `Assignee: ${focusAssignee?.name ?? (focusCard.assigneeId ? 'unavailable' : 'unassigned')}`,
      `Reviewer: ${focusReviewer?.name ?? (focusCard.reviewerId ? 'unavailable' : 'none')}`,
      `Parent: ${parent ? compactCardLine(parent, agentById) : 'none'}`,
      `Children:\n${children.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Dependencies:\n${deps.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Requires approval: ${focusCard.requiresApproval ? 'yes' : 'no'}`,
      `Retry: ${focusCard.retryCount ?? 0}/${focusCard.maxRetries ?? 3}`,
      `Review revisions: ${focusCard.revisionCount ?? 0}/${focusCard.maxRevisions ?? 3}`,
      `Required deterministic tools:\n${requiredTools.map(({ cardTool, tool }) => `- ${tool.name}@${tool.version}: ${tool.description ?? 'no description'}${cardTool.reason ? ` (reason: ${cardTool.reason})` : ''}`).join('\n') || 'none'}`,
      `Session: ${focusCard.sessionId ?? 'none'}`,
      `Cost USD: ${focusCard.costUsd ?? '0'}`,
      'Body:',
      clipText(focusCard.body, 8000),
      focusCard.reviewFeedback ? `Review feedback:\n${clipText(focusCard.reviewFeedback, 4000)}` : '',
      focusCard.executionLog ? `Latest execution output:\n${clipText(focusCard.executionLog, 6000)}` : '',
    ].filter(Boolean).join('\n'), 14000);

    if (ancestors.length > 0) {
      addContextSection(state, 'Upstream Task Chain Full Context', [
        `Path: ${[...ancestors, focusCard].map((card) => card.title).join(' > ')}`,
        ...ancestors.map((ancestor, index) => [
          `## Ancestor ${index + 1}: ${ancestor.title}`,
          `ID: ${ancestor.id}`,
          `Stage: ${ancestor.columnStatus ?? 'todo'}`,
          `Decision mode: ${ancestor.decisionMode ?? 'not set'}`,
          `Assignee: ${ancestor.assigneeId ? agentById.get(ancestor.assigneeId)?.name ?? 'unavailable' : 'unassigned'}`,
          `Reviewer: ${ancestor.reviewerId ? agentById.get(ancestor.reviewerId)?.name ?? 'unavailable' : 'none'}`,
          `Body:\n${clipText(ancestor.body, 5000)}`,
          ancestor.executionLog ? `Latest execution output:\n${clipText(ancestor.executionLog, 4000)}` : '',
          ancestor.reviewFeedback ? `Review feedback:\n${clipText(ancestor.reviewFeedback, 2500)}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n\n'), 16000);
    }

    const [messages, actions, logs] = await Promise.all([
      db.select().from(cardComments).where(eq(cardComments.cardId, focusCard.id)).orderBy(desc(cardComments.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
      db.select().from(cardActions).where(eq(cardActions.cardId, focusCard.id)).orderBy(desc(cardActions.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
      db.select().from(taskLogs).where(eq(taskLogs.cardId, focusCard.id)).orderBy(desc(taskLogs.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    ]);
    addContextSection(state, 'Focus Task Message Board Latest', messages.reverse().map((message) => {
      const author = message.agentId ? agentById.get(message.agentId)?.name ?? message.agentId : message.authorType;
      return `- ${formatDate(message.createdAt)} | ${author} | ${message.action}: ${clipText(message.body, 900)}`;
    }).join('\n') || 'none', 7000);
    addContextSection(state, 'Focus Task Action Timeline Latest', actions.reverse().map((action) => [
      `- ${formatDate(action.createdAt)} | ${action.actorType}:${action.actorId} | ${action.action} | ${action.fromStatus ?? 'none'} -> ${action.toStatus ?? 'none'}`,
      action.detail ? `  detail: ${clipText(action.detail, 700)}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'none', 6000);
    addContextSection(state, 'Focus Task Lifecycle Latest', logs.reverse().map((log) => [
      `- ${formatDate(log.createdAt)} | ${log.type}/${log.status}: ${clipText(log.message, 700)}`,
      log.output ? `  output: ${clipText(log.output, 900)}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'none', 7000);
  }

  const scopedRuns = scopedToProject ? recentRuns.filter((run) => {
    if (!run.cardId) return true;
    const card = companyCards.find((item) => item.id === run.cardId);
    return options.projectId ? card?.projectId === options.projectId : !card?.projectId;
  }) : recentRuns;
  addContextSection(state, 'Recent Company Activity', scopedToProject && !options.projectId ? 'omitted for no-project chat' : recentActivity.map((event) => [
    `- ${formatDate(event.createdAt)} | ${event.actorType}:${event.actorId} | ${event.action} | ${event.entityType}:${event.entityId}`,
    `  details=${clipText(JSON.stringify(event.details ?? {}), 800)}`,
  ].join('\n')).join('\n') || 'none', 5000);
  addContextSection(state, 'Recent Heartbeat Runs', scopedRuns.map((run) => [
    `- ${formatDate(run.createdAt)} | ${run.source}/${run.status} | card=${run.cardId ?? 'none'} | agent=${run.agentId ? agentById.get(run.agentId)?.name ?? run.agentId : 'none'} | duration=${run.durationSeconds ?? 0}s | cost=${run.costUsd ?? '0'}`,
    run.error ? `  error=${clipText(run.error, 500)}` : '',
  ].filter(Boolean).join('\n')).join('\n') || 'none', 5000);

  if (state.truncated || state.remaining <= 0) state.sections.push('[Kanban context was truncated to fit the configured context budget.]');
  return state.sections.join('\n\n');
}

function afterPromptSince(value: Date | string | null | undefined, since?: Date | null): boolean {
  if (!since || !value) return true;
  return new Date(value).getTime() > since.getTime();
}

function completionProtocol(card: CardRow, reports: DelegationReport[] = []): string {
  return [
    card.decisionMode === 'delegate'
      ? collaborationDelegationInstructions(reports)
      : optionalDelegationInstructions(reports),
    `Do not ask the user whether to proceed, whether they want a draft first, or whether you should submit/POST. Kanban tasks are assigned work; complete them autonomously unless you truly cannot proceed, then use status="needs_review".`,
    `Do not call POST /api/cards yourself for delegation. MegaCorps creates child cards from the DELEGATE block. If your runtime reports through the webhook, send status="in_progress" and include the same DELEGATE block in summary/output instead of marking the current card done.`,
    `When the task produces repo changes or reviewable artifacts, include workProducts in the webhook. Use PR URL, commit SHA, branch, preview URL, report URL, screenshot URL, or artifact URL instead of local-only file paths.`,
    `If you need ordinary QA on completed work, use status="in_review" and include the completed output.`,
    `If you are waiting on CI/CD, deploy, external approval, or another external system, use status="waiting_on_external" and include pollIntervalSeconds based on how often that system should be checked.`,
    `If you cannot solve it, do not mark it complete. Use status="needs_review" and include: attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs.`,
    `If no reviewer/manager exists above you, provide the best final answer instead of escalating; MegaCorps will accept top-level guidance requests as done.`,
  ].join('\n');
}

async function buildKanbanDeltaContext(card: CardRow, options: PromptBuildOptions = {}): Promise<string> {
  const since = options.since ?? null;
  const [companyAgents, companyRuntimes, companyCards, messages, actions, logs, products] = await Promise.all([
    db.select().from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt))),
    db.select().from(agentRuntimes).where(eq(agentRuntimes.companyId, card.companyId)),
    db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId, card.companyId), isNull(kanbanCards.deletedAt))),
    db.select().from(cardComments).where(eq(cardComments.cardId, card.id)).orderBy(desc(cardComments.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    db.select().from(cardActions).where(eq(cardActions.cardId, card.id)).orderBy(desc(cardActions.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    db.select().from(taskLogs).where(eq(taskLogs.cardId, card.id)).orderBy(desc(taskLogs.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
  ]);
  const availabilityCache = createRuntimeAvailabilityCache();
  for (const runtime of companyRuntimes) availabilityCache.runtimes.set(runtime.id, runtime);
  const visibleAgents = await promptVisibleAgents(card.companyId, companyAgents, availabilityCache);
  const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const ancestors = ancestorChain(card, companyCards);
  const children = companyCards.filter((item) => item.parentCardId === card.id);
  const deps = (card.dependencyCardIds ?? []).map((id) => companyCards.find((item) => item.id === id)).filter((item): item is CardRow => Boolean(item));
  const recentMessages = messages.filter((message) => afterPromptSince(message.createdAt, since)).reverse();
  const recentActions = actions.filter((action) => afterPromptSince(action.createdAt, since)).reverse();
  const recentLogs = logs.filter((log) => afterPromptSince(log.createdAt, since)).reverse();
  const recentProducts = products.filter((product) => afterPromptSince(product.createdAt, since)).reverse();
  return [
    `Delta since: ${since ? since.toISOString() : 'last adapter turn unknown'}`,
    `Current task: ${compactCardLine(card, agentById)}`,
    `Updated at: ${card.updatedAt ? formatDate(card.updatedAt) : 'unknown'}`,
    `Decision mode: ${card.decisionMode ?? 'not set'}`,
    `Required child policy: ${card.requiredChildPolicy ?? 'all_required_accepted'}`,
    `Last error: ${promptDiagnostic(card.lastError)}`,
    card.reviewFeedback ? `Current review feedback:\n${clipText(card.reviewFeedback, 2500)}` : 'Current review feedback: none',
    `Parent chain:\n${ancestors.map((item) => compactCardLine(item, agentById)).join('\n') || 'none'}`,
    `Children now:\n${children.map((item) => compactCardLine(item, agentById)).join('\n') || 'none'}`,
    `Dependencies now:\n${deps.map((item) => compactCardLine(item, agentById)).join('\n') || 'none'}`,
    `New message board entries:\n${recentMessages.map((message) => {
      const author = message.agentId ? agentById.get(message.agentId)?.name ?? 'unavailable' : message.authorType;
      return `- ${formatDate(message.createdAt)} | ${author} | ${message.action}: ${clipText(promptDiagnostic(message.body), 900)}`;
    }).join('\n') || 'none'}`,
    `New action timeline entries:\n${recentActions.map((action) => [
      `- ${formatDate(action.createdAt)} | ${action.actorType}:${action.actorId} | ${action.action} | ${action.fromStatus ?? 'none'} -> ${action.toStatus ?? 'none'}`,
      action.detail ? `  detail: ${clipText(action.detail, 700)}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'none'}`,
    `New lifecycle log entries:\n${recentLogs.map((log) => [
      `- ${formatDate(log.createdAt)} | ${log.type}/${log.status}: ${clipText(promptDiagnostic(log.message), 700)}`,
      log.output ? `  output: ${clipText(promptDiagnostic(log.output), 900)}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'none'}`,
    `New work products:\n${recentProducts.map((product) => `- ${product.type}: ${product.title}${product.url ? ` (${product.url})` : product.pullRequestUrl ? ` (${product.pullRequestUrl})` : ''}${product.summary ? ` -- ${clipText(product.summary, 500)}` : ''}`).join('\n') || 'none'}`,
    'If your adapter session has lost the original task context, do not guess. Use status="needs_review" and say that the session context was lost so a full context retry is needed.',
  ].join('\n');
}

async function buildTaskPrompt(card: CardRow, options: PromptBuildOptions = {}): Promise<string> {
  if (options.continuation) {
    const [deltaContext, reports] = await Promise.all([
      buildKanbanDeltaContext(card, options),
      activeDirectReportsForCard(card),
    ]);
    return [
      'Continue this existing Kanban adapter session.',
      'Do not rely on stale stage, child, dependency, or review state from memory. Treat the fresh DB delta below as the source of truth for anything that changed since your last turn.',
      'Fresh Kanban delta:',
      deltaContext,
      'Completion protocol:',
      completionProtocol(card, reports),
    ].join('\n\n');
  }
  const [project] = card.projectId ? await db.select().from(projects).where(eq(projects.id, card.projectId)).limit(1) : [];
  const [assignee] = card.assigneeId ? await db.select().from(agents).where(and(eq(agents.id, card.assigneeId), isNull(agents.deletedAt))).limit(1) : [];
  const [runtime] = assignee?.runtimeId ? await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, assignee.runtimeId)).limit(1) : [];
  const reports = await activeDirectReportsForCard(card);
  const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.companyId, card.companyId)).orderBy(desc(knowledgeDocs.updatedAt)).limit(10);
  const kanbanContext = await buildCompanyKanbanContext(card.companyId, { focusCardId: card.id, focusAgentId: card.assigneeId, includeFocusProjectRepo: false });
  const matchingDocs = docs.filter((doc) => {
    const tags = doc.tags ?? [];
    return tags.length === 0 || tags.some((tag) => (card.tags ?? []).includes(tag));
  }).slice(0, 5);
  return [
    [
      'Current assignment:',
      `Card ID: ${card.id}`,
      `Title: ${card.title}`,
      `Stage: ${card.columnStatus ?? 'todo'}`,
      'Use the Kanban context snapshot below as the source of truth for assignee, department, project, goals, company structure, parent chain, dependencies, message board, lifecycle logs, and prior output.',
    ].join('\n'),
    kanbanContext ? `Kanban context snapshot:\n${kanbanContext}` : '',
    matchingDocs.length ? `Company knowledge:\n${matchingDocs.map((doc) => `## ${doc.title}\nTags: ${(doc.tags ?? []).join(', ') || 'general'}\n${clipText(doc.body, KNOWLEDGE_DOC_CHAR_LIMIT)}`).join('\n\n---\n\n')}` : '',
    `Repository protocol:\n${projectGitProtocol(project, card, assignee, runtime)}`,
    'Completion protocol:',
    completionProtocol(card, reports),
  ].filter(Boolean).join('\n\n');
}

async function buildReviewPrompt(card: CardRow, options: PromptBuildOptions = {}): Promise<string> {
  if (options.continuation) {
    const helpReview = card.columnStatus === 'needs_review';
    return [
      'Continue this existing Kanban review adapter session.',
      helpReview
        ? `Help-review the escalated card ${card.id}: ${card.title}.`
        : `Quality-review or integrate the current card ${card.id}: ${card.title}.`,
      'Use your existing adapter session memory for the original full context. Treat the fresh DB delta below as source of truth for current stage, messages, child/dependency states, and new work products.',
      'Fresh Kanban delta:',
      await buildKanbanDeltaContext(card, options),
      helpReview
        ? 'Decision options: APPROVE/DONE if you can finish it directly, REVISION_REQUESTED with concrete guidance if the assignee should retry, or ESCALATE if your manager must decide.'
        : 'Decision options: PASS/APPROVED if acceptable, REJECT/REVISION_REQUESTED with concrete feedback if it needs more work, or ESCALATE only if your manager must decide.',
    ].join('\n\n');
  }
  const kanbanContext = await buildCompanyKanbanContext(card.companyId, { focusCardId: card.id, focusAgentId: card.reviewerId });
  const helpReview = card.columnStatus === 'needs_review';
  const childRows = await db.select().from(kanbanCards).where(and(eq(kanbanCards.parentCardId, card.id), isNull(kanbanCards.deletedAt))).orderBy(kanbanCards.createdAt);
  const childIds = childRows.map((child) => child.id);
  const childProducts = childIds.length > 0
    ? await db.select().from(workProducts).where(inArray(workProducts.cardId, childIds)).orderBy(desc(workProducts.createdAt)).limit(80)
    : [];
  const productsByCard = new Map<string, typeof childProducts>();
  for (const product of childProducts) {
    if (!product.cardId) continue;
    const rows = productsByCard.get(product.cardId) ?? [];
    rows.push(product);
    productsByCard.set(product.cardId, rows);
  }
  const childResultSummary = childRows.map((child) => [
    `## ${child.title}`,
    `ID: ${child.id}`,
    `Status: ${child.columnStatus ?? 'todo'}`,
    `Assignee: ${child.assigneeId ?? 'none'}`,
    child.executionLog ? `Execution output:\n${clipText(child.executionLog, 3000)}` : 'Execution output: none',
    child.reviewFeedback ? `Review feedback:\n${clipText(child.reviewFeedback, 1800)}` : '',
    `Work products:\n${(productsByCard.get(child.id) ?? []).map((product) => `- ${product.type}: ${product.title}${product.url ? ` (${product.url})` : product.pullRequestUrl ? ` (${product.pullRequestUrl})` : ''}${product.summary ? ` -- ${clipText(product.summary, 500)}` : ''}`).join('\n') || 'none'}`,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
  return [
    helpReview
      ? `Help-review an escalated card ${card.id}: ${card.title}.`
      : childRows.length > 0
        ? `Integrate and quality-review completed child work for parent card ${card.id}: ${card.title}.`
        : `Quality-review the completed work for card ${card.id}: ${card.title}.`,
    helpReview
      ? 'The assignee says they cannot complete the task. Decide one of: APPROVE/DONE if you can finish it directly, REVISION_REQUESTED with concrete guidance if the assignee should retry, or ESCALATE if your manager must decide.'
      : childRows.length > 0
        ? 'Read every child result and work product, synthesize the final parent answer, and return PASS/APPROVED only when the combined result is ready. Return REJECT/REVISION_REQUESTED with concrete child-specific feedback if any required child needs rework. Use ESCALATE only if your manager must decide.'
        : 'Return PASS/APPROVED if it is acceptable, or REJECT/REVISION_REQUESTED with feedback if it needs more work. Use ESCALATE only if your manager must decide.',
    'Use the Kanban context, message board, lifecycle logs, dependencies, and company state when deciding.',
    'Kanban context snapshot:',
    kanbanContext,
    childRows.length > 0 ? 'Child results and work products:' : '',
    childRows.length > 0 ? childResultSummary || 'No child result details captured.' : '',
  ].join('\n\n');
}
