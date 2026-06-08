import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, sql as rawSql } from './db/client.ts';
import { activityLog, agentRuntimes, agents, approvals, budgetPolicies, cardComments, companies, costEvents, cronRuns, departments, goals, heartbeatRuns, kanbanCards, knowledgeDocs, projects, taskLogs, taskRuns } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import { configuredWebhookSharedSecret } from './webhook-secret.ts';
import { publishLiveEvent } from './live.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type GoalRow = typeof goals.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
type LogStatus = 'queued' | 'running' | 'success' | 'warning' | 'failed';
type TaskRunKind = 'dispatch' | 'review';
type TaskRunSource = 'manual' | 'loop' | 'startup' | 'queue';

const LOOP_INTERVAL_MS = Number(process.env.DISPATCH_LOOP_INTERVAL_MS ?? 10_000);
const CONTEXT_CHAR_BUDGET = Number(process.env.DISPATCH_CONTEXT_CHAR_BUDGET ?? 32_000);
const KANBAN_CONTEXT_CARD_LIMIT = Number(process.env.DISPATCH_CONTEXT_CARD_LIMIT ?? 160);
const KANBAN_CONTEXT_RECORD_LIMIT = Number(process.env.DISPATCH_CONTEXT_RECORD_LIMIT ?? 30);
const MESSAGE_BOARD_COMMENT_LIMIT = Number(process.env.MESSAGE_BOARD_COMMENT_LIMIT ?? 20_000);
const TASK_BODY_CHAR_LIMIT = Number(process.env.DISPATCH_TASK_BODY_CHAR_LIMIT ?? 12_000);
const KNOWLEDGE_DOC_CHAR_LIMIT = Number(process.env.DISPATCH_KNOWLEDGE_DOC_CHAR_LIMIT ?? 4_000);
const BUDGET_RESET_DAY = Number(process.env.BUDGET_RESET_DAY ?? 1);
const TASK_RUN_WORKER_INTERVAL_MS = Number(process.env.TASK_RUN_WORKER_INTERVAL_MS ?? 2_000);
const TASK_RUN_WORKER_BATCH_SIZE = Number(process.env.TASK_RUN_WORKER_BATCH_SIZE ?? 2);
const TASK_RUN_WORKER_ID = process.env.TASK_RUN_WORKER_ID ?? `server-${Math.random().toString(36).slice(2, 10)}`;
const TASK_RUN_STALE_MS = Number(process.env.TASK_RUN_STALE_MS ?? 10 * 60 * 1000);
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
  return status === 'in_review' || status === 'needs_review' || status === 'done';
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

type ReviewDecision = 'approved' | 'revision_requested' | 'escalate';

function reviewDecision(output: string, mode: 'quality' | 'help'): ReviewDecision {
  if (/\b(escalate|needs[_ -]?higher|needs[_ -]?boss|needs[_ -]?manager|cannot[_ -]?resolve|unable[_ -]?to[_ -]?resolve)\b/i.test(output)) return 'escalate';
  if (/\b(revision[_ -]?requested|request[_ -]?revision|needs[_ -]?rework|redo|retry|reject|rejected|fail|failed|blocked|not\s+approved|not\s+acceptable|cannot\s+approve)\b/i.test(output)) return 'revision_requested';
  if (/\b(pass|approve|approved|done|complete|completed|resolved)\b/i.test(output)) return 'approved';
  return mode === 'help' ? 'revision_requested' : 'approved';
}

function goalScopeLabel(goal: GoalRow): string {
  if (goal.projectId) return 'Project goal';
  if (goal.departmentId) return 'Department goal';
  return 'Company goal';
}

function formatGoal(goal: GoalRow): string {
  return `- ${goalScopeLabel(goal)}: ${goal.title}${goal.body ? `\n  ${clipText(goal.body, 1200)}` : ''}`;
}

function projectRepoLines(project: ProjectRow | null | undefined): string[] {
  if (!project) return ['Project repository: none'];
  return [
    `Project repository provider: ${project.repoProvider ?? 'github'}`,
    `Project repository URL: ${project.repoUrl ?? 'not configured'}`,
    `Default branch: ${project.defaultBranch ?? 'main'}`,
    `Protected branches: ${(project.protectedBranches ?? ['main', 'master']).join(', ') || 'none'}`,
    `Task branch pattern: ${project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}'}`,
    `Pull before run: ${project.pullBeforeRun === false ? 'no' : 'yes'}`,
    `Push after run: ${project.pushAfterRun === false ? 'no' : 'yes'}`,
    `Completion policy: ${project.completionPolicy ?? 'push_or_pr'}`,
    project.setupCommand ? `Setup command: ${project.setupCommand}` : '',
    project.testCommand ? `Test command: ${project.testCommand}` : '',
    project.workspacePathHint ? `MegaCorps workspace path hint: ${project.workspacePathHint}` : '',
    `Runtime services: ${clipText(JSON.stringify(project.runtimeServices ?? {}), 1200)}`,
  ].filter(Boolean);
}

function projectGitProtocol(project: ProjectRow | null | undefined, card: CardRow, agent: AgentRow | null | undefined): string {
  if (!project?.repoUrl) return 'No repository is configured for this project. Do not invent local file paths; report external work products by URL when available.';
  const branchPattern = project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}';
  const branch = branchPattern
    .replaceAll('{cardId}', card.id.slice(0, 8))
    .replaceAll('{agentSlug}', agent?.slug ?? 'agent')
    .replaceAll('{projectId}', project.id.slice(0, 8));
  return [
    'Repository workflow:',
    `1. Use repo ${project.repoUrl}. Your local clone path is runtime-owned; MegaCorps does not assume a shared folder path.`,
    project.pullBeforeRun === false ? '2. Pull-before-run is disabled for this project.' : `2. Before editing, fetch the latest ${project.defaultBranch ?? 'main'} and pull/rebase so your local workspace is current.`,
    `3. Work on branch ${branch}; do not push directly to protected branches (${(project.protectedBranches ?? ['main', 'master']).join(', ') || 'none'}).`,
    project.setupCommand ? `4. Run setup when needed: ${project.setupCommand}` : '4. Run project setup only when needed and report any failure.',
    project.testCommand ? `5. Validate with: ${project.testCommand}` : '5. Run the most relevant tests/checks available in the repo.',
    project.pushAfterRun === false ? '6. Push-after-run is disabled; report the local result and blocker clearly.' : `6. Commit and push your branch when work is complete. Prefer a pull request when policy is ${project.completionPolicy ?? 'push_or_pr'}.`,
    '7. Include workProducts in the webhook payload: pull_request, commit, preview_url, report, screenshot, artifact, or external metadata as applicable.',
  ].join('\n');
}

function scopedGoals(goalsRows: GoalRow[], input: { departmentId?: string | null; projectId?: string | null; selectedGoalId?: string | null }): GoalRow[] {
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
  await addTaskLog({
    cardId,
    agentId,
    type: 'stage',
    status: 'success',
    message: `Stage changed from ${from ?? 'todo'} to ${to} by ${actor}.`,
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

export async function enqueueTaskRun(cardId: string, kind: TaskRunKind = 'dispatch', source: TaskRunSource = 'manual', requestedByUserId?: string | null): Promise<TaskRunRow> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  const [existing] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.cardId, cardId),
    eq(taskRuns.kind, kind),
    inArray(taskRuns.status, ['queued', 'running']),
  )).orderBy(desc(taskRuns.createdAt)).limit(1);
  if (existing) return existing;

  const previous = await db.select({ id: taskRuns.id }).from(taskRuns).where(and(eq(taskRuns.cardId, cardId), eq(taskRuns.kind, kind)));
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
  }).returning();
  if (!run) throw new Error('task_run_create_failed');
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
  const candidates = await db.select().from(taskRuns).where(eq(taskRuns.status, 'queued')).orderBy(desc(taskRuns.priority), taskRuns.createdAt).limit(25);
  const now = new Date();
  for (const queued of candidates) {
    if (queued.kind === 'review') {
      const [card] = await db.select({ columnStatus: kanbanCards.columnStatus }).from(kanbanCards).where(and(eq(kanbanCards.id, queued.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (!reviewCanRun(card?.columnStatus)) continue;
    }
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
    await completeTaskRun(run.id, { status: 'failed', error: message, durationSeconds: Math.round((Date.now() - started) / 1000) });
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

async function dependenciesMet(card: CardRow): Promise<boolean> {
  const ids = card.dependencyCardIds ?? [];
  if (ids.length === 0) return true;
  const rows = await db.select({ id: kanbanCards.id, columnStatus: kanbanCards.columnStatus }).from(kanbanCards).where(inArray(kanbanCards.id, ids));
  return rows.length === ids.length && rows.every((row) => row.columnStatus === 'done');
}

export async function getBudgetGuard(agent: AgentRow): Promise<{ monthlyLimit: number | null; perTaskLimit: number | null; warnAtPercent: number; hardStop: boolean }> {
  const rows = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, agent.companyId), eq(budgetPolicies.isActive, true)));
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

export async function budgetOk(agent: AgentRow): Promise<boolean> {
  const guard = await getBudgetGuard(agent);
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
  const adapterType = agent.adapterType ?? 'hermes';
  let runtimeConfig: Record<string, unknown> = {};
  if (adapterRequiresRuntime(adapterType) && !agent.runtimeId) throw new Error('agent_runtime_required');
  if (agent.runtimeId) {
    const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1);
    if (!runtime) throw new Error('agent_runtime_not_found');
    if (runtime && runtime.isActive === false) throw new Error('agent_runtime_inactive');
    if (runtime.adapterType !== adapterType) throw new Error('agent_runtime_adapter_mismatch');
    runtimeConfig = (runtime?.config as Record<string, unknown> | null) ?? {};
  }
  const webhookSharedSecret = await configuredWebhookSharedSecret();
  return {
    hermesProfile: agent.hermesProfile,
    currentSessionId: currentSessionId === undefined ? agent.currentSessionId : currentSessionId,
    adapterConfig: {
      ...runtimeConfig,
      ...configuredAdapterOverrides(agent.adapterConfig as Record<string, unknown> | null),
      ...(webhookSharedSecret ? { webhookSharedSecret } : {}),
    },
  };
}

function matchScore(card: CardRow, agent: AgentRow): number {
  let score = 0;
  if (card.departmentId && agent.departmentId === card.departmentId) score += 50;
  const haystack = `${agent.role} ${agent.title ?? ''} ${(agent.capabilities ?? []).join(' ')}`.toLowerCase();
  for (const tag of card.tags ?? []) if (haystack.includes(tag.toLowerCase())) score += 10;
  if (/review|qa|audit/i.test(card.title + card.body) && /review|qa|audit/i.test(agent.role + agent.title)) score += 8;
  if (/design|ui|ux/i.test(card.title + card.body) && /design|ui|ux/i.test(agent.role + agent.title)) score += 8;
  if (/code|api|backend|frontend|bug|build/i.test(card.title + card.body) && /engineer|developer|coder/i.test(agent.role + agent.title)) score += 8;
  score += Math.max(0, 10 - Number(agent.spentThisMonth ?? 0));
  return score;
}

async function selectBestAgent(card: CardRow): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt)));
  const available = [];
  for (const agent of rows) {
    if (!agent.isActive || agent.isBusy) continue;
    if (!(await budgetOk(agent))) continue;
    available.push(agent);
  }
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

async function acquireExecutionLock(card: CardRow, agent: AgentRow, run: HeartbeatRunRow, source: string): Promise<CardRow> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
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

async function createPendingApproval(card: CardRow, agentId: string | null, reason: string) {
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
  }
  return shouldPause;
}

export async function cascadeParentStatus(parentCardId: string | null): Promise<void> {
  if (!parentCardId) return;
  const children = await db.select().from(kanbanCards).where(eq(kanbanCards.parentCardId, parentCardId));
  if (children.length === 0 || !children.every((child) => child.columnStatus === 'done')) return;
  const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
  await db.update(kanbanCards).set({ columnStatus: 'done', completedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, parentCardId));
  if (parent?.columnStatus !== 'done') await addStageLog(parentCardId, null, parent?.columnStatus ?? null, 'done', 'cascade');
  await addTaskLog({ cardId: parentCardId, type: 'cascade', status: 'success', message: 'All sub-tasks completed; parent card marked done.' });
}

async function handleDispatchFailure(card: CardRow, agent: AgentRow, error: unknown, runId?: string | null, taskRunId?: string | null): Promise<CardRow> {
  const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
  if (latest && isTerminalCardStatus(latest.columnStatus) && !latest.executionLockId && latest.activeHeartbeatRunId !== runId) {
    const status = terminalRunStatus(latest.columnStatus);
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    await releaseExecutionLock(card.id, runId ?? null, status);
    await completeTaskRun(taskRunId, {
      status,
      output: `Card was already ${latest.columnStatus} before dispatch returned.`,
    });
    await addTaskLog({
      cardId: card.id,
      agentId: agent.id,
      type: 'dispatch',
      status: status === 'cancelled' ? 'warning' : status,
      message: `Dispatch result ignored because card was already ${latest.columnStatus}.`,
      output: error instanceof Error ? error.message : 'dispatch_finished_after_external_status',
    });
    return latest;
  }

  const retryCount = (card.retryCount ?? 0) + 1;
  const maxRetries = card.maxRetries ?? 3;
  const message = error instanceof Error ? error.message : 'dispatch_failed';
  const blocked = retryCount >= maxRetries;
  const [updated] = await db.update(kanbanCards).set({
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
  await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
  await releaseExecutionLock(card.id, runId ?? card.activeHeartbeatRunId ?? null, 'failed', message);
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
  await completeTaskRun(taskRunId, { status: 'failed', error: message });
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
  if (!(await budgetOk(agent))) {
    await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, agent.id));
    await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'budget', status: 'failed', message: `Agent ${agent.name} is over budget and was paused before dispatch.` });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'budget', agentId: agent.id, action: 'budget.preflight_hard_stop', entityType: 'agent', entityId: agent.id, details: { cardId: card.id } });
    throw new Error('agent_budget_exceeded');
  }
  if (!(await dependenciesMet(card))) throw new Error('card_dependencies_not_met');

  const [busyAgent] = await db.update(agents).set({ isBusy: true }).where(and(eq(agents.id, agent.id), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
  if (!busyAgent) throw new Error('agent_busy');
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
    const adapter = getAdapter(agent.adapterType ?? 'hermes');
    const result = await adapter.dispatch(
      await buildExecutionAgent(agent),
      { id: card.id, title: card.title, body: await buildTaskPrompt(card), timeoutSeconds: 300, taskRunId: options.taskRunId },
    );
    const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
    if (latest && isTerminalCardStatus(latest.columnStatus) && !latest.executionLockId && latest.activeHeartbeatRunId !== run.id) {
      const status = terminalRunStatus(latest.columnStatus);
      await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
      await releaseExecutionLock(card.id, run.id, status);
      await completeTaskRun(options.taskRunId, {
        status,
        output: `Card was already ${latest.columnStatus} before dispatch returned.`,
        durationSeconds: result.durationSeconds,
      });
      await addTaskLog({
        cardId: card.id,
        agentId: agent.id,
        type: 'dispatch',
        status: status === 'cancelled' ? 'warning' : status,
        message: `Dispatch output received after card was already ${latest.columnStatus}; keeping the current stage.`,
        output: result.output,
        durationSeconds: result.durationSeconds,
      });
      return latest;
    }
    if (!result.success) {
      await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      throw new Error(result.output || 'adapter_reported_failure');
    }
    const effectiveReviewerId = resolveEffectiveReviewerId(card, agent);
    const needsHelpReview = assigneeNeedsReview(result.output);
    const nextStatus = needsHelpReview
      ? effectiveReviewerId ? 'needs_review' : 'blocked'
      : effectiveReviewerId ? 'in_review' : 'done';
    const budgetPaused = await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: nextStatus,
      executionLog: result.output,
      sessionId: result.sessionId,
      costUsd: result.costUsd.toString(),
      reviewerId: effectiveReviewerId,
      retryCount: nextStatus === 'blocked' ? card.retryCount : 0,
      nextRunAt: null,
      completedAt: nextStatus === 'done' ? new Date() : null,
      lastError: nextStatus === 'blocked' ? 'Assignee requested reviewer guidance, but no reviewer or manager is available.' : null,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await releaseExecutionLock(card.id, run.id, result.success ? 'success' : 'failed', result.success ? null : result.output, result.costUsd, result.durationSeconds);
    await addStageLog(card.id, agent.id, 'in_progress', nextStatus, 'dispatch');
    await addTaskLog({
      cardId: card.id,
      agentId: agent.id,
      type: needsHelpReview ? 'escalation' : 'dispatch',
      status: nextStatus === 'blocked' ? 'failed' : 'success',
      message: needsHelpReview
        ? nextStatus === 'needs_review'
          ? 'Assignee requested reviewer guidance; help review queued.'
          : 'Assignee requested guidance but no reviewer or manager is available; card blocked.'
        : nextStatus === 'in_review'
          ? 'Dispatch completed; card moved to quality review.'
          : 'Dispatch completed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await addCardMessage({ cardId: card.id, agentId: agent.id, action: needsHelpReview ? (nextStatus === 'blocked' ? 'agent_blocked' : 'agent_escalated') : 'agent_update', body: result.output });
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: needsHelpReview ? (nextStatus === 'blocked' ? 'dispatch.blocked' : 'dispatch.needs_review') : 'dispatch.completed', entityType: 'card', entityId: card.id, details: { runId: run.id, nextStatus, costUsd: result.costUsd, budgetPaused, reviewerId: effectiveReviewerId, escalation: needsHelpReview } });
    await completeTaskRun(options.taskRunId, { status: nextStatus === 'blocked' ? 'failed' : 'success', error: nextStatus === 'blocked' ? 'no_reviewer_available' : null, output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    if (!updated) throw new Error('card_update_failed');
    if (nextStatus === 'in_review') await createPendingApproval(updated, agent.id, card.reviewerId === effectiveReviewerId ? 'Reviewer approval required' : 'Reports-to review required');
    if (nextStatus === 'needs_review') {
      await createPendingApproval(updated, agent.id, 'Assignee needs reviewer guidance');
      await enqueueTaskRun(updated.id, 'review', 'queue');
    }
    if (nextStatus === 'done') await cascadeParentStatus(updated.parentCardId);
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
  let reviewerId = card.reviewerId;
  if (reviewerId && reviewerId === card.assigneeId) {
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
      ? 'Escalation requested but no reviewer or manager is available; card blocked.'
      : 'Review requested but no independent reviewer or manager is available; card blocked.';
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: 'blocked',
      lastError: reason,
      completedAt: null,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await addStageLog(card.id, null, card.columnStatus, 'blocked', 'review');
    await addTaskLog({ cardId: card.id, type: 'review', status: 'failed', message: reason });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_blocked', body: reason });
    await resolvePendingApproval(card, 'cancelled', reason);
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review', action: 'review.blocked', entityType: 'card', entityId: card.id, details: { reason, mode: reviewMode } });
    await completeTaskRun(options.taskRunId, { status: 'failed', error: reason, output: reason });
    if (!updated) throw new Error('card_update_failed');
    return updated;
  }

  const [reviewer] = await db.select().from(agents).where(and(eq(agents.id, reviewerId), isNull(agents.deletedAt))).limit(1);
  if (!reviewer) throw new Error('reviewer_not_found');
  if (reviewer.isBusy) throw new Error('reviewer_busy');

  const [busyReviewer] = await db.update(agents).set({ isBusy: true }).where(and(eq(agents.id, reviewer.id), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
  if (!busyReviewer) throw new Error('reviewer_busy');
  const run = await openHeartbeatRun(card, reviewer, 'review', options.taskRunId);
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'running', message: 'Review started.' });
  try {
    const adapter = getAdapter(reviewer.adapterType ?? 'hermes');
    const promptCard = reviewerId === card.reviewerId ? card : { ...card, reviewerId };
    const result = await adapter.dispatch(
      await buildExecutionAgent(reviewer),
      { id: card.id, title: `Review: ${card.title}`, body: await buildReviewPrompt(promptCard), timeoutSeconds: 180, taskRunId: options.taskRunId },
    );
    const [latest] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
    if (latest && isTerminalCardStatus(latest.columnStatus) && latest.columnStatus !== card.columnStatus && latest.activeHeartbeatRunId !== run.id) {
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
    if (!result.success) throw new Error(result.output || 'review_adapter_reported_failure');
    const decision = reviewDecision(result.output, reviewMode);
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
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: rejected ? 'todo' : 'done',
      reviewFeedback: result.output,
      completedAt: rejected ? null : new Date(),
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
    await addStageLog(card.id, reviewer.id, card.columnStatus, rejected ? 'todo' : 'done', 'review');
    await addTaskLog({
      cardId: card.id,
      agentId: reviewer.id,
      type: 'review',
      status: result.success ? 'success' : 'failed',
      message: rejected
        ? reviewMode === 'help' ? 'Reviewer provided guidance; card returned to todo for rework.' : 'Review rejected; card returned to todo.'
        : reviewMode === 'help' ? 'Reviewer resolved the escalated task; card marked done.' : 'Review passed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await addCardMessage({ cardId: card.id, agentId: reviewer.id, action: rejected ? (reviewMode === 'help' ? 'review_guidance' : 'review_rejected') : 'review_note', body: result.output });
    await db.update(heartbeatRuns).set({ status: result.success ? 'success' : 'failed', completedAt: new Date(), durationSeconds: result.durationSeconds, error: result.success ? null : result.output }).where(eq(heartbeatRuns.id, run.id));
    await resolvePendingApproval(card, rejected ? (reviewMode === 'help' ? 'revision_requested' : 'rejected') : 'approved', rejected ? result.output : 'Reviewer approved task.', reviewer.id);
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: rejected ? (reviewMode === 'help' ? 'review.revision_requested' : 'review.rejected') : 'review.approved', entityType: 'card', entityId: card.id, details: { runId: run.id, costUsd: result.costUsd, mode: reviewMode } });
    await completeTaskRun(options.taskRunId, { status: rejected ? 'failed' : 'success', error: rejected ? result.output : null, output: result.output, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    if (!updated) throw new Error('card_update_failed');
    if (!rejected) await cascadeParentStatus(updated.parentCardId);
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
    ? await db.select().from(agents).where(and(eq(agents.bossId, parent.assigneeId), eq(agents.isActive, true), isNull(agents.deletedAt)))
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
      createdBy: parent.createdBy,
    };
  })).returning();
  await addTaskLog({ cardId: parent.id, type: 'decomposition', status: 'success', message: directReports.length ? `Created ${rows.length} sub-task(s) and delegated them to direct reports.` : `Created ${rows.length} sub-task(s).` });
  await addActivity({ companyId: parent.companyId, actorType: 'system', actorId: 'decomposition', agentId: parent.assigneeId, action: 'card.decomposed', entityType: 'card', entityId: parent.id, details: { childCount: rows.length, delegatedToReports: directReports.length > 0 } });
  return rows;
}

export async function getTaskLogs(cardId: string) {
  return db.select().from(taskLogs).where(eq(taskLogs.cardId, cardId)).orderBy(desc(taskLogs.createdAt));
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

export async function runDispatchCronTick(app: FastifyInstance, source: 'loop' | 'manual' | 'startup' = 'manual'): Promise<DispatchCronResult> {
  const started = Date.now();
  const startedAt = new Date(started);
  if (loopRunning) {
    return {
      name: 'dispatch-heartbeat',
      source,
      status: 'skipped',
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
    name: 'dispatch-heartbeat',
    source,
    status: 'running',
    startedAt,
    details: {},
  }).returning();
  if (!run) {
    loopRunning = false;
    cronState.running = false;
    cronState.lastStatus = 'failed';
    cronState.lastError = 'cron_run_create_failed';
    throw new Error('cron_run_create_failed');
  }

  const result: DispatchCronResult = {
    name: 'dispatch-heartbeat',
    source,
    status: 'success',
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
    const nowMs = Date.now();
    const activeCompanyIds = companyRows.filter((company) => {
      if (company.autoDispatchEnabled === false) return false;
      const intervalMs = Math.max(5, company.dispatchIntervalSeconds ?? 10) * 1000;
      const last = companyLastTick.get(company.id) ?? 0;
      if (source === 'loop' && nowMs - last < intervalMs) return false;
      companyLastTick.set(company.id, nowMs);
      return true;
    }).map((company) => company.id);
    result.activeCompanies = activeCompanyIds.length;

    if (activeCompanyIds.length > 0) {
      const cards = await db.select().from(kanbanCards).where(and(inArray(kanbanCards.companyId, activeCompanyIds), isNull(kanbanCards.deletedAt)));
      result.cardsScanned = cards.length;
      for (const card of cards) {
        if (card.columnStatus === 'backlog' || card.columnStatus === 'todo') {
          if (card.nextRunAt && card.nextRunAt > now) { result.skipped += 1; continue; }
          if (!(await dependenciesMet(card))) { result.skipped += 1; continue; }
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

function clipText(value: string | null | undefined, maxChars: number): string {
  const text = value?.trim() ?? '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 48)).trimEnd()}\n[truncated ${text.length - maxChars} chars]`;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'n/a';
  return new Date(value).toISOString();
}

function compactCardLine(card: CardRow, agentById: Map<string, AgentRow>): string {
  return [
    `- [${card.columnStatus ?? 'todo'}] ${clipText(card.title, 96)}`,
    `id=${card.id}`,
    `priority=${card.priority ?? 0}`,
    `assignee=${card.assigneeId ? agentById.get(card.assigneeId)?.name ?? card.assigneeId : 'unassigned'}`,
    `reviewer=${card.reviewerId ? agentById.get(card.reviewerId)?.name ?? card.reviewerId : 'none'}`,
    `parent=${card.parentCardId ?? 'none'}`,
    `deps=${(card.dependencyCardIds ?? []).join(',') || 'none'}`,
    `tags=${(card.tags ?? []).join(',') || 'none'}`,
    `updated=${formatDate(card.updatedAt)}`,
  ].join(' | ');
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

export async function buildCompanyKanbanContext(companyId: string, options: { focusCardId?: string; focusAgentId?: string | null; budgetChars?: number } = {}): Promise<string> {
  const budget = Math.max(8000, options.budgetChars ?? CONTEXT_CHAR_BUDGET);
  const state = { remaining: budget, sections: [] as string[], truncated: false };
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [companyAgents, companyDepartments, companyProjects, companyGoals, companyCards, recentActivity, recentRuns] = await Promise.all([
    db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    db.select().from(departments).where(eq(departments.companyId, companyId)),
    db.select().from(projects).where(eq(projects.companyId, companyId)),
    db.select().from(goals).where(eq(goals.companyId, companyId)),
    db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId, companyId), isNull(kanbanCards.deletedAt))).orderBy(desc(kanbanCards.updatedAt)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(desc(activityLog.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(desc(heartbeatRuns.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
  ]);
  const agentById = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const departmentById = new Map(companyDepartments.map((department) => [department.id, department]));
  const projectById = new Map(companyProjects.map((project) => [project.id, project]));
  const goalById = new Map(companyGoals.map((goal) => [goal.id, goal]));
  const focusCard = options.focusCardId ? companyCards.find((card) => card.id === options.focusCardId) : undefined;
  const focusAgent = options.focusAgentId ? agentById.get(options.focusAgentId) : undefined;

  addContextSection(state, 'Company', [
    `Name: ${company?.name ?? 'unknown'}`,
    `Mission: ${company?.mission ?? 'No mission configured.'}`,
    `Auto dispatch: ${company?.autoDispatchEnabled === false ? 'off' : 'on'}`,
    `Dispatch interval seconds: ${company?.dispatchIntervalSeconds ?? 10}`,
    `Departments: ${companyDepartments.map((department) => `${department.name} (${department.slug})`).join(', ') || 'none'}`,
    `Projects: ${companyProjects.map((project) => project.name).join(', ') || 'none'}`,
    `Goals:\n${companyGoals.map((goal) => formatGoal(goal)).join('\n') || 'none'}`,
  ].join('\n'), 2600);

  const statusCounts = companyCards.reduce<Record<string, number>>((acc, card) => {
    const key = card.columnStatus ?? 'todo';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const boardLines = companyCards.slice(0, KANBAN_CONTEXT_CARD_LIMIT).map((card) => compactCardLine(card, agentById));
  addContextSection(state, 'Kanban Board Snapshot', [
    `Total cards: ${companyCards.length}`,
    `Stage counts: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`,
    ...boardLines,
    companyCards.length > boardLines.length ? `[omitted ${companyCards.length - boardLines.length} older cards due context limit]` : '',
  ].filter(Boolean).join('\n'), 14000);

  if (focusAgent) {
    const manager = focusAgent.bossId ? agentById.get(focusAgent.bossId) : undefined;
    const reports = companyAgents.filter((agent) => agent.bossId === focusAgent.id);
    const assigned = companyCards.filter((card) => card.assigneeId === focusAgent.id && !['done', 'blocked', 'cancelled'].includes(card.columnStatus ?? 'todo')).slice(0, KANBAN_CONTEXT_RECORD_LIMIT);
    const reviews = companyCards.filter((card) => card.reviewerId === focusAgent.id || reports.some((report) => report.id === card.assigneeId && ['in_review', 'needs_review'].includes(card.columnStatus ?? 'todo'))).slice(0, KANBAN_CONTEXT_RECORD_LIMIT);
    addContextSection(state, 'Invocation Agent Work Context', [
      `Agent: ${focusAgent.name}`,
      `Identity label: ${focusAgent.role}`,
      `Reports to: ${manager?.name ?? 'top-level'}`,
      `Direct reports: ${reports.map((report) => `${report.name} (${report.role})`).join(', ') || 'none'}`,
      `Assigned open work:\n${assigned.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Review queue:\n${reviews.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
    ].join('\n'), 6000);
  }

  if (focusCard) {
    const parent = focusCard.parentCardId ? companyCards.find((card) => card.id === focusCard.parentCardId) : undefined;
    const children = companyCards.filter((card) => card.parentCardId === focusCard.id);
    const deps = (focusCard.dependencyCardIds ?? []).map((id) => companyCards.find((card) => card.id === id)).filter((card): card is CardRow => Boolean(card));
    const focusAssignee = focusCard.assigneeId ? agentById.get(focusCard.assigneeId) : undefined;
    const focusReviewer = focusCard.reviewerId ? agentById.get(focusCard.reviewerId) : undefined;
    addContextSection(state, 'Focus Task Full Context', [
      `ID: ${focusCard.id}`,
      `Title: ${focusCard.title}`,
      `Stage: ${focusCard.columnStatus ?? 'todo'}`,
      `Priority: ${focusCard.priority ?? 0}`,
      `Department: ${focusCard.departmentId ? departmentById.get(focusCard.departmentId)?.name ?? focusCard.departmentId : 'none'}`,
      `Project: ${focusCard.projectId ? projectById.get(focusCard.projectId)?.name ?? focusCard.projectId : 'none'}`,
      `Project repo:\n${projectRepoLines(focusCard.projectId ? projectById.get(focusCard.projectId) : null).join('\n')}`,
      `Goal: ${focusCard.goalId ? goalById.get(focusCard.goalId)?.title ?? focusCard.goalId : 'none'}`,
      `Scoped goals:\n${scopedGoals(companyGoals, { departmentId: focusCard.departmentId, projectId: focusCard.projectId, selectedGoalId: focusCard.goalId }).map((goal) => formatGoal(goal)).join('\n') || 'none'}`,
      `Assignee: ${focusAssignee?.name ?? focusCard.assigneeId ?? 'unassigned'}`,
      `Reviewer: ${focusReviewer?.name ?? focusCard.reviewerId ?? 'none'}`,
      `Parent: ${parent ? compactCardLine(parent, agentById) : 'none'}`,
      `Children:\n${children.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Dependencies:\n${deps.map((card) => compactCardLine(card, agentById)).join('\n') || 'none'}`,
      `Requires approval: ${focusCard.requiresApproval ? 'yes' : 'no'}`,
      `Retry: ${focusCard.retryCount ?? 0}/${focusCard.maxRetries ?? 3}`,
      `Session: ${focusCard.sessionId ?? 'none'}`,
      `Cost USD: ${focusCard.costUsd ?? '0'}`,
      'Body:',
      clipText(focusCard.body, 8000),
      focusCard.reviewFeedback ? `Review feedback:\n${clipText(focusCard.reviewFeedback, 4000)}` : '',
      focusCard.executionLog ? `Latest execution output:\n${clipText(focusCard.executionLog, 6000)}` : '',
    ].filter(Boolean).join('\n'), 14000);

    const [messages, logs] = await Promise.all([
      db.select().from(cardComments).where(eq(cardComments.cardId, focusCard.id)).orderBy(desc(cardComments.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
      db.select().from(taskLogs).where(eq(taskLogs.cardId, focusCard.id)).orderBy(desc(taskLogs.createdAt)).limit(KANBAN_CONTEXT_RECORD_LIMIT),
    ]);
    addContextSection(state, 'Focus Task Message Board Latest', messages.reverse().map((message) => {
      const author = message.agentId ? agentById.get(message.agentId)?.name ?? message.agentId : message.authorType;
      return `- ${formatDate(message.createdAt)} | ${author} | ${message.action}: ${clipText(message.body, 900)}`;
    }).join('\n') || 'none', 7000);
    addContextSection(state, 'Focus Task Lifecycle Latest', logs.reverse().map((log) => [
      `- ${formatDate(log.createdAt)} | ${log.type}/${log.status}: ${clipText(log.message, 700)}`,
      log.output ? `  output: ${clipText(log.output, 900)}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'none', 7000);
  }

  addContextSection(state, 'Recent Company Activity', recentActivity.map((event) => [
    `- ${formatDate(event.createdAt)} | ${event.actorType}:${event.actorId} | ${event.action} | ${event.entityType}:${event.entityId}`,
    `  details=${clipText(JSON.stringify(event.details ?? {}), 800)}`,
  ].join('\n')).join('\n') || 'none', 5000);
  addContextSection(state, 'Recent Heartbeat Runs', recentRuns.map((run) => [
    `- ${formatDate(run.createdAt)} | ${run.source}/${run.status} | card=${run.cardId ?? 'none'} | agent=${run.agentId ? agentById.get(run.agentId)?.name ?? run.agentId : 'none'} | duration=${run.durationSeconds ?? 0}s | cost=${run.costUsd ?? '0'}`,
    run.error ? `  error=${clipText(run.error, 500)}` : '',
  ].filter(Boolean).join('\n')).join('\n') || 'none', 5000);

  if (state.truncated || state.remaining <= 0) state.sections.push('[Kanban context was truncated to fit the configured context budget.]');
  return state.sections.join('\n\n');
}

async function buildTaskPrompt(card: CardRow): Promise<string> {
  const [company] = await db.select().from(companies).where(eq(companies.id, card.companyId)).limit(1);
  const [department] = card.departmentId ? await db.select().from(departments).where(eq(departments.id, card.departmentId)).limit(1) : [];
  const [project] = card.projectId ? await db.select().from(projects).where(eq(projects.id, card.projectId)).limit(1) : [];
  const [goal] = card.goalId ? await db.select().from(goals).where(eq(goals.id, card.goalId)).limit(1) : [];
  const [assignee] = card.assigneeId ? await db.select().from(agents).where(and(eq(agents.id, card.assigneeId), isNull(agents.deletedAt))).limit(1) : [];
  const [manager] = assignee?.bossId ? await db.select().from(agents).where(and(eq(agents.id, assignee.bossId), isNull(agents.deletedAt))).limit(1) : [];
  const reports = assignee ? await db.select().from(agents).where(eq(agents.bossId, assignee.id)) : [];
  const companyGoals = await db.select().from(goals).where(eq(goals.companyId, card.companyId)).orderBy(desc(goals.createdAt));
  const relevantGoals = scopedGoals(companyGoals, { departmentId: card.departmentId, projectId: card.projectId, selectedGoalId: card.goalId });
  const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.companyId, card.companyId)).orderBy(desc(knowledgeDocs.updatedAt)).limit(10);
  const kanbanContext = await buildCompanyKanbanContext(card.companyId, { focusCardId: card.id, focusAgentId: card.assigneeId });
  const matchingDocs = docs.filter((doc) => {
    const tags = doc.tags ?? [];
    return tags.length === 0 || tags.some((tag) => (card.tags ?? []).includes(tag));
  }).slice(0, 5);
  return [
    company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    project ? `Project: ${project.name}\n${project.description ?? ''}\n${projectRepoLines(project).join('\n')}` : '',
    goal ? `Goal: ${goal.title}\n${goal.body ?? ''}` : '',
    assignee ? [
      `Assigned member: ${assignee.name}`,
      `Identity label: ${assignee.role}`,
      `Reports to: ${manager?.name ?? 'top-level'}`,
      `Direct reports: ${reports.length ? reports.map((report) => `${report.name} (${report.role})`).join(', ') : 'none'}`,
    ].join('\n') : '',
    [
      'Goal context:',
      `Company goals:\n${companyGoals.filter((row) => !row.departmentId && !row.projectId).map((row) => formatGoal(row)).join('\n') || 'none'}`,
      `Department: ${department?.name ?? 'none'}`,
      `Department goals:\n${card.departmentId ? companyGoals.filter((row) => row.departmentId === card.departmentId).map((row) => formatGoal(row)).join('\n') || 'none' : 'none'}`,
      `Project: ${project?.name ?? 'none'}`,
      `Project goals:\n${card.projectId ? companyGoals.filter((row) => row.projectId === card.projectId).map((row) => formatGoal(row)).join('\n') || 'none' : 'none'}`,
      `Selected card goal:\n${goal ? formatGoal(goal) : 'none'}`,
      `Effective goal stack:\n${relevantGoals.map((row) => formatGoal(row)).join('\n') || 'none'}`,
    ].join('\n'),
    `Card: ${card.title}`,
    `Status: ${card.columnStatus}`,
    `Priority: ${card.priority ?? 0}`,
    card.reviewFeedback ? `Previous review feedback:\n${card.reviewFeedback}` : '',
    kanbanContext ? `Kanban context snapshot:\n${kanbanContext}` : '',
    matchingDocs.length ? `Company knowledge:\n${matchingDocs.map((doc) => `## ${doc.title}\nTags: ${(doc.tags ?? []).join(', ') || 'general'}\n${clipText(doc.body, KNOWLEDGE_DOC_CHAR_LIMIT)}`).join('\n\n---\n\n')}` : '',
    `Repository protocol:\n${projectGitProtocol(project, card, assignee)}`,
    'Task body:',
    clipText(card.body, TASK_BODY_CHAR_LIMIT),
    'Completion protocol:',
    [
      `If you can complete the task, post the final answer back through the MegaCorps webhook with status="done".`,
      `When the task produces repo changes or reviewable artifacts, include workProducts in the webhook. Use PR URL, commit SHA, branch, preview URL, report URL, screenshot URL, or artifact URL instead of local-only file paths.`,
      `If you need ordinary QA on completed work, use status="in_review" and include the completed output.`,
      `If you cannot solve it, do not mark it complete. Use status="needs_review" and include: attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs.`,
      `If no reviewer/manager exists, the server will move top-level escalations to blocked for human intervention.`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

async function buildReviewPrompt(card: CardRow): Promise<string> {
  const kanbanContext = await buildCompanyKanbanContext(card.companyId, { focusCardId: card.id, focusAgentId: card.reviewerId });
  const helpReview = card.columnStatus === 'needs_review';
  return [
    helpReview
      ? `Help-review an escalated card ${card.id}: ${card.title}.`
      : `Quality-review the completed work for card ${card.id}: ${card.title}.`,
    helpReview
      ? 'The assignee says they cannot complete the task. Decide one of: APPROVE/DONE if you can finish it directly, REVISION_REQUESTED with concrete guidance if the assignee should retry, or ESCALATE if your manager must decide.'
      : 'Return PASS/APPROVED if it is acceptable, or REJECT/REVISION_REQUESTED with feedback if it needs more work. Use ESCALATE only if your manager must decide.',
    'Use the Kanban context, message board, lifecycle logs, dependencies, and company state when deciding.',
    'Kanban context snapshot:',
    kanbanContext,
    'Original task:',
    clipText(card.body, TASK_BODY_CHAR_LIMIT),
    'Execution output:',
    clipText(card.executionLog ?? 'No execution log was captured.', 12_000),
  ].join('\n\n');
}
