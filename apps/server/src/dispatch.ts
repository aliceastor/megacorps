import { and, desc, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from './db/client.ts';
import { activityLog, agentRuntimes, agents, approvals, budgetPolicies, cardComments, companies, costEvents, goals, heartbeatRuns, kanbanCards, knowledgeDocs, projects, taskLogs } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type LogStatus = 'queued' | 'running' | 'success' | 'failed';

const LOOP_INTERVAL_MS = Number(process.env.DISPATCH_LOOP_INTERVAL_MS ?? 10_000);
let loopRunning = false;
const companyLastTick = new Map<string, number>();

function nextBackoff(retryCount: number): Date {
  const seconds = Math.min(300, 10 * 2 ** Math.max(0, retryCount));
  return new Date(Date.now() + seconds * 1000);
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
  await db.insert(taskLogs).values({
    cardId: input.cardId,
    agentId: input.agentId ?? null,
    type: input.type,
    status: input.status,
    message: input.message,
    output: input.output,
    costUsd: input.costUsd?.toString(),
    durationSeconds: input.durationSeconds,
  });
}

async function addStageLog(cardId: string, agentId: string | null, from: string | null, to: string, actor = 'system') {
  await addTaskLog({
    cardId,
    agentId,
    type: 'stage',
    status: 'success',
    message: `Stage changed from ${from ?? 'backlog'} to ${to} by ${actor}.`,
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
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType ?? 'system',
    actorId: input.actorId ?? input.agentId ?? 'system',
    agentId: input.agentId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details ?? {},
  });
}

async function dependenciesMet(card: CardRow): Promise<boolean> {
  const ids = card.dependencyCardIds ?? [];
  if (ids.length === 0) return true;
  const rows = await db.select({ id: kanbanCards.id, columnStatus: kanbanCards.columnStatus }).from(kanbanCards).where(inArray(kanbanCards.id, ids));
  return rows.length === ids.length && rows.every((row) => row.columnStatus === 'done');
}

async function getBudgetGuard(agent: AgentRow): Promise<{ monthlyLimit: number | null; perTaskLimit: number | null; warnAtPercent: number; hardStop: boolean }> {
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

async function budgetOk(agent: AgentRow): Promise<boolean> {
  const guard = await getBudgetGuard(agent);
  if (!guard.monthlyLimit) return true;
  return Number(agent.spentThisMonth ?? 0) < guard.monthlyLimit;
}

async function buildExecutionAgent(agent: AgentRow) {
  let runtimeConfig: Record<string, unknown> = {};
  if (agent.runtimeId) {
    const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1);
    if (runtime && runtime.isActive === false) throw new Error('agent_runtime_inactive');
    runtimeConfig = (runtime?.config as Record<string, unknown> | null) ?? {};
  }
  return {
    hermesProfile: agent.hermesProfile,
    currentSessionId: agent.currentSessionId,
    adapterConfig: {
      ...runtimeConfig,
      ...((agent.adapterConfig as Record<string, unknown> | null) ?? {}),
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
  const rows = await db.select().from(agents).where(eq(agents.companyId, card.companyId));
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

async function openHeartbeatRun(card: CardRow, agent: AgentRow, source: string): Promise<HeartbeatRunRow> {
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: card.companyId,
    cardId: card.id,
    agentId: agent.id,
    source,
    status: 'running',
    startedAt: new Date(),
  }).returning();
  if (!run) throw new Error('heartbeat_run_create_failed');
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
  const [parent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, parentCardId)).limit(1);
  await db.update(kanbanCards).set({ columnStatus: 'done', completedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, parentCardId));
  if (parent?.columnStatus !== 'done') await addStageLog(parentCardId, null, parent?.columnStatus ?? null, 'done', 'cascade');
  await addTaskLog({ cardId: parentCardId, type: 'cascade', status: 'success', message: 'All sub-tasks completed; parent card marked done.' });
}

async function handleDispatchFailure(card: CardRow, agent: AgentRow, error: unknown, runId?: string | null): Promise<CardRow> {
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
  await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: blocked ? 'dispatch.blocked' : 'dispatch.retry_scheduled', entityType: 'card', entityId: card.id, details: { retryCount, maxRetries, error: message } });
  if (!updated) throw new Error('card_update_failed');
  return updated;
}

export async function dispatchCard(cardId: string, source: 'manual' | 'loop' = 'manual'): Promise<CardRow> {
  let [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
  if (!card) throw new Error('card_not_found');
  if (!card.assigneeId) {
    const assigned = await ensureAssigned(card, source);
    if (!assigned) throw new Error('card_has_no_available_agent');
    card = assigned;
  }
  if (!card.assigneeId) throw new Error('card_has_no_assignee');
  const [agent] = await db.select().from(agents).where(eq(agents.id, card.assigneeId)).limit(1);
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
  const run = await openHeartbeatRun(card, agent, source);
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
      { id: card.id, title: card.title, body: await buildTaskPrompt(card), timeoutSeconds: 300 },
    );
    if (!result.success) {
      await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
      throw new Error(result.output || 'adapter_reported_failure');
    }
    const effectiveReviewerId = card.reviewerId ?? agent.bossId ?? null;
    const nextStatus = card.requiresApproval || effectiveReviewerId ? 'in_review' : 'done';
    const budgetPaused = await recordCostAndEnforceBudget(card, agent, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, agent.id));
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: nextStatus,
      executionLog: result.output,
      sessionId: result.sessionId,
      costUsd: result.costUsd.toString(),
      reviewerId: effectiveReviewerId ?? card.reviewerId,
      retryCount: 0,
      nextRunAt: null,
      completedAt: nextStatus === 'done' ? new Date() : null,
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
      type: 'dispatch',
      status: result.success ? 'success' : 'failed',
      message: nextStatus === 'in_review' ? 'Dispatch completed; card moved to review.' : 'Dispatch completed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: agent.id, agentId: agent.id, action: 'dispatch.completed', entityType: 'card', entityId: card.id, details: { runId: run.id, nextStatus, costUsd: result.costUsd, budgetPaused } });
    if (!updated) throw new Error('card_update_failed');
    if (nextStatus === 'in_review') await createPendingApproval(updated, agent.id, effectiveReviewerId ? 'Reports-to review required' : 'Task requires approval');
    if (nextStatus === 'done') await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    return handleDispatchFailure(lockedCard, agent, error, run.id);
  }
}

export async function reviewCard(cardId: string): Promise<CardRow> {
  const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
  if (!card) throw new Error('card_not_found');
  if (!card.reviewerId) {
    const [updated] = await db.update(kanbanCards).set({ columnStatus: 'done', completedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, card.id)).returning();
    if (card.columnStatus !== 'done') await addStageLog(card.id, null, card.columnStatus, 'done', 'review');
    await addTaskLog({ cardId: card.id, type: 'review', status: 'success', message: 'No reviewer configured; card approved automatically.' });
    await resolvePendingApproval(card, 'approved', 'No reviewer configured; approved automatically.');
    if (!updated) throw new Error('card_update_failed');
    await cascadeParentStatus(updated.parentCardId);
    return updated;
  }

  const [reviewer] = await db.select().from(agents).where(eq(agents.id, card.reviewerId)).limit(1);
  if (!reviewer) throw new Error('reviewer_not_found');
  if (reviewer.isBusy) throw new Error('reviewer_busy');

  const [busyReviewer] = await db.update(agents).set({ isBusy: true }).where(and(eq(agents.id, reviewer.id), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
  if (!busyReviewer) throw new Error('reviewer_busy');
  const run = await openHeartbeatRun(card, reviewer, 'review');
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'running', message: 'Review started.' });
  try {
    const adapter = getAdapter(reviewer.adapterType ?? 'hermes');
    const result = await adapter.dispatch(
      await buildExecutionAgent(reviewer),
      { id: card.id, title: `Review: ${card.title}`, body: buildReviewPrompt(card), timeoutSeconds: 180 },
    );
    await recordCostAndEnforceBudget(card, reviewer, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    if (!result.success) throw new Error(result.output || 'review_adapter_reported_failure');
    const rejected = /\b(reject|rejected|fail|failed|blocked)\b/i.test(result.output);
    await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, reviewer.id));
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
      message: rejected ? 'Review rejected; card returned to todo.' : 'Review passed; card marked done.',
      output: result.output,
      costUsd: result.costUsd,
      durationSeconds: result.durationSeconds,
    });
    await db.update(heartbeatRuns).set({ status: result.success ? 'success' : 'failed', completedAt: new Date(), durationSeconds: result.durationSeconds, error: result.success ? null : result.output }).where(eq(heartbeatRuns.id, run.id));
    await resolvePendingApproval(card, rejected ? 'rejected' : 'approved', rejected ? result.output : 'Reviewer approved task.', reviewer.id);
    await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: rejected ? 'review.rejected' : 'review.approved', entityType: 'card', entityId: card.id, details: { runId: run.id, costUsd: result.costUsd } });
    if (!updated) throw new Error('card_update_failed');
    if (!rejected) await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, reviewer.id));
    await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: error instanceof Error ? error.message : 'review_failed' }).where(eq(heartbeatRuns.id, run.id));
    await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'failed', message: error instanceof Error ? error.message : 'review_failed' });
    throw error;
  }
}

export async function decomposeCard(cardId: string): Promise<CardRow[]> {
  const [parent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
  if (!parent) throw new Error('card_not_found');
  const directReports = parent.assigneeId
    ? await db.select().from(agents).where(and(eq(agents.bossId, parent.assigneeId), eq(agents.isActive, true)))
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
    await db.update(kanbanCards).set({
      columnStatus: card.columnStatus === 'in_progress' ? 'todo' : card.columnStatus,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      lastError: 'Recovered stale execution lock.',
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id));
    if (agentId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agentId));
    if (card.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'failed', error: 'stale_execution_lock_recovered', completedAt: new Date() }).where(eq(heartbeatRuns.id, card.activeHeartbeatRunId));
    await addTaskLog({ cardId: card.id, agentId, type: 'recovery', status: 'failed', message: 'Stale execution lock recovered; task returned to todo.' });
    await addStageLog(card.id, agentId ?? null, card.columnStatus, card.columnStatus === 'in_progress' ? 'todo' : card.columnStatus ?? 'todo', 'stale-lock-recovery');
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'recovery', agentId, action: 'execution.stale_lock_recovered', entityType: 'card', entityId: card.id, details: { runId: card.activeHeartbeatRunId } });
    app.log.warn({ cardId: card.id, agentId }, 'stale execution lock recovered');
  }
}

export function startDispatchLoop(app: FastifyInstance): void {
  if (process.env.DISPATCH_LOOP_ENABLED === 'false') return;
  const tick = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      const now = new Date();
      await recoverStaleExecutionLocks(app);
      const companyRows = await db.select().from(companies);
      const nowMs = Date.now();
      const activeCompanyIds = companyRows.filter((company) => {
        if (company.autoDispatchEnabled === false) return false;
        const intervalMs = Math.max(5, company.dispatchIntervalSeconds ?? 10) * 1000;
        const last = companyLastTick.get(company.id) ?? 0;
        if (nowMs - last < intervalMs) return false;
        companyLastTick.set(company.id, nowMs);
        return true;
      }).map((company) => company.id);
      if (activeCompanyIds.length === 0) return;
      const cards = await db.select().from(kanbanCards).where(inArray(kanbanCards.companyId, activeCompanyIds));
      for (const card of cards) {
        if (card.columnStatus === 'backlog' || card.columnStatus === 'todo') {
          if (card.nextRunAt && card.nextRunAt > now) continue;
          if (!(await dependenciesMet(card))) continue;
          try {
            const assigned = await ensureAssigned(card, 'loop');
            if (assigned || card.assigneeId) await dispatchCard(card.id, 'loop');
          } catch (error) { app.log.warn({ error, cardId: card.id }, 'dispatch loop skipped card'); }
        } else if (card.columnStatus === 'in_review') {
          try { await reviewCard(card.id); } catch (error) { app.log.warn({ error, cardId: card.id }, 'review loop skipped card'); }
        }
      }
    } finally {
      loopRunning = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, LOOP_INTERVAL_MS);
  app.addHook('onClose', async () => clearInterval(timer));
  void tick();
}

async function buildTaskPrompt(card: CardRow): Promise<string> {
  const comments = await db.select().from(cardComments).where(eq(cardComments.cardId, card.id)).orderBy(desc(cardComments.createdAt)).limit(20);
  const [company] = await db.select().from(companies).where(eq(companies.id, card.companyId)).limit(1);
  const [project] = card.projectId ? await db.select().from(projects).where(eq(projects.id, card.projectId)).limit(1) : [];
  const [goal] = card.goalId ? await db.select().from(goals).where(eq(goals.id, card.goalId)).limit(1) : [];
  const [assignee] = card.assigneeId ? await db.select().from(agents).where(eq(agents.id, card.assigneeId)).limit(1) : [];
  const [manager] = assignee?.bossId ? await db.select().from(agents).where(eq(agents.id, assignee.bossId)).limit(1) : [];
  const reports = assignee ? await db.select().from(agents).where(eq(agents.bossId, assignee.id)) : [];
  const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.companyId, card.companyId)).orderBy(desc(knowledgeDocs.updatedAt)).limit(10);
  const matchingDocs = docs.filter((doc) => {
    const tags = doc.tags ?? [];
    return tags.length === 0 || tags.some((tag) => (card.tags ?? []).includes(tag));
  }).slice(0, 5);
  return [
    company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    project ? `Project: ${project.name}\n${project.description ?? ''}` : '',
    goal ? `Goal: ${goal.title}\n${goal.body ?? ''}` : '',
    assignee ? [
      `Assigned member: ${assignee.name}`,
      `Identity label: ${assignee.role}`,
      `Reports to: ${manager?.name ?? 'top-level'}`,
      `Direct reports: ${reports.length ? reports.map((report) => `${report.name} (${report.role})`).join(', ') : 'none'}`,
    ].join('\n') : '',
    `Card: ${card.title}`,
    `Status: ${card.columnStatus}`,
    `Priority: ${card.priority ?? 0}`,
    card.reviewFeedback ? `Previous review feedback:\n${card.reviewFeedback}` : '',
    comments.length ? `User comments and instructions:\n${comments.reverse().map((comment) => `- [${comment.action}] ${comment.body}`).join('\n')}` : '',
    matchingDocs.length ? `Company knowledge:\n${matchingDocs.map((doc) => `## ${doc.title}\nTags: ${(doc.tags ?? []).join(', ') || 'general'}\n${doc.body}`).join('\n\n---\n\n')}` : '',
    'Task body:',
    card.body,
  ].filter(Boolean).join('\n\n');
}

function buildReviewPrompt(card: CardRow): string {
  return [
    `Review the completed work for card ${card.id}: ${card.title}.`,
    'Return PASS if it is acceptable, or REJECT with feedback if it needs more work.',
    'Original task:',
    card.body,
    'Execution output:',
    card.executionLog ?? 'No execution log was captured.',
  ].join('\n\n');
}
