import { and, desc, eq, gt, inArray, isNotNull, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getAdapter } from './adapters/registry.ts';
import { db } from './db/client.ts';
import { activityLog, agents, cardComments, costEvents, heartbeatRuns, kanbanCards, taskRuns, workProducts } from './db/schema.ts';
import { budgetOk, buildExecutionAgent, getBudgetGuard } from './dispatch.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';
import { readKanbanTaskTimeoutSeconds } from './runtime-settings.ts';

type AgentRow = typeof agents.$inferSelect;

export const MAINTENANCE_SOURCE = 'maintenance';
export const DEFAULT_MEMORY_IDLE_MINUTES = 15;
export const DEFAULT_MEMORY_DAILY_LIMIT = 3;
const MAINTENANCE_SWEEP_INTERVAL_MS = Number(process.env.MAINTENANCE_SWEEP_INTERVAL_MS ?? 60_000);
const SHIFT_SUMMARY_RUN_LIMIT = 30;
const SHIFT_SUMMARY_FEEDBACK_LIMIT = 20;
const SHIFT_SUMMARY_WORK_PRODUCT_LIMIT = 20;
// Only adapters whose prompt builder understands kind: 'maintenance' may run
// shift-end consolidation; other adapters would wrap it in the Kanban protocol.
const MAINTENANCE_ADAPTER_TYPES = ['hermes-ssh'];

export type AgentMemoryConfig = { enabled: boolean; idleMinutes: number; dailyLimit: number };

export function normalizeMemoryConfig(raw: unknown): AgentMemoryConfig {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const idle = Number(record.idleMinutes);
  const daily = Number(record.dailyLimit);
  return {
    enabled: record.enabled === true,
    idleMinutes: Number.isFinite(idle) && idle >= 1 ? Math.min(1440, Math.trunc(idle)) : DEFAULT_MEMORY_IDLE_MINUTES,
    dailyLimit: Number.isFinite(daily) && daily >= 1 ? Math.min(24, Math.trunc(daily)) : DEFAULT_MEMORY_DAILY_LIMIT,
  };
}

export type MaintenanceCandidateInput = {
  now: Date;
  config: AgentMemoryConfig;
  hasActiveTaskRuns: boolean;
  lastWorkCompletedAt: Date | null;
  lastMaintenanceAttemptAt: Date | null;
  lastMaintenanceSuccessAt: Date | null;
  maintenanceRunsToday: number;
};

// Returns null when shift-end consolidation should run now, otherwise a skip reason.
export function maintenanceSkipReason(input: MaintenanceCandidateInput): string | null {
  const { now, config } = input;
  const idleMs = config.idleMinutes * 60_000;
  if (!config.enabled) return 'memory_disabled';
  if (input.hasActiveTaskRuns) return 'agent_has_active_task_runs';
  if (!input.lastWorkCompletedAt) return 'no_completed_work';
  if (input.lastMaintenanceSuccessAt && input.lastWorkCompletedAt <= input.lastMaintenanceSuccessAt) return 'no_new_work_since_last_consolidation';
  if (now.getTime() - input.lastWorkCompletedAt.getTime() < idleMs) return 'not_idle_yet';
  if (input.lastMaintenanceAttemptAt && now.getTime() - input.lastMaintenanceAttemptAt.getTime() < idleMs) return 'maintenance_recently_attempted';
  if (input.maintenanceRunsToday >= config.dailyLimit) return 'daily_limit_reached';
  return null;
}

export type ShiftWorkItem = { kind: string; cardTitle: string; status: string; completedAt: Date | null; error?: string | null };
export type ShiftFeedbackItem = { cardTitle: string; action: string; detail: string | null };
export type ShiftWorkProductItem = { title: string; url?: string | null; pullRequestUrl?: string | null };

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function formatShiftSummary(items: ShiftWorkItem[], feedback: ShiftFeedbackItem[], products: ShiftWorkProductItem[], since: Date | null): string {
  const lines: string[] = [`=== Shift Summary (since ${since ? since.toISOString() : 'the beginning'}) ===`];
  lines.push('Completed work:');
  if (items.length === 0) lines.push('- none recorded');
  for (const item of items) {
    const failure = item.status === 'success' ? '' : `: ${clip(item.error ?? 'no error detail', 200)}`;
    lines.push(`- [${item.kind}] Card "${clip(item.cardTitle, 120)}" — ${item.status}${failure}`);
  }
  lines.push('Review feedback and corrections received:');
  if (feedback.length === 0) lines.push('- none recorded');
  for (const item of feedback) {
    lines.push(`- Card "${clip(item.cardTitle, 120)}": ${item.action}${item.detail ? ` — ${clip(item.detail, 300)}` : ''}`);
  }
  lines.push('Work products:');
  if (products.length === 0) lines.push('- none recorded');
  for (const item of products) {
    const link = item.pullRequestUrl ?? item.url;
    lines.push(`- "${clip(item.title, 120)}"${link ? ` ${link}` : ''}`);
  }
  return lines.join('\n');
}

export function buildMaintenancePrompt(agent: Pick<AgentRow, 'name' | 'role'>, shiftSummary: string): string {
  return `${shiftSummary}

=== Maintenance Instructions ===
You are ${agent.name} (${agent.role}). Your shift is over. Consolidate what you learned into your own long-term memory and skills, following your own memory workflow and configuration.

1. Keep two layers of memory strictly separate:
   - Professional know-how (methods, debugging patterns, report-writing techniques) that is portable across projects.
   - Project- or company-specific facts (repo structure, client preferences); label each of these with the company or project it belongs to.
2. Give the review feedback and corrections above top priority: update or delete any memory they prove wrong.
3. Only record what the shift summary above supports; do not invent memories.
4. Promote a practice into a reusable skill only if it has worked more than once.
5. Do not start new project work, and do not call the MegaCorps webhook or API.

When you are done, reply with a short plain-text summary of what you consolidated.`;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function collectCandidateInput(agent: AgentRow, now: Date): Promise<MaintenanceCandidateInput> {
  const config = normalizeMemoryConfig(agent.memoryConfig);
  const [activeRun] = await db.select({ id: taskRuns.id }).from(taskRuns)
    .where(and(eq(taskRuns.agentId, agent.id), inArray(taskRuns.status, ['queued', 'running']))).limit(1);
  const [lastWork] = await db.select({ completedAt: taskRuns.completedAt }).from(taskRuns)
    .where(and(eq(taskRuns.agentId, agent.id), inArray(taskRuns.status, ['success', 'failed']), isNotNull(taskRuns.completedAt)))
    .orderBy(desc(taskRuns.completedAt)).limit(1);
  const [lastAttempt] = await db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.source, MAINTENANCE_SOURCE)))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const [lastSuccess] = await db.select({ completedAt: heartbeatRuns.completedAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.source, MAINTENANCE_SOURCE), eq(heartbeatRuns.status, 'success')))
    .orderBy(desc(heartbeatRuns.completedAt)).limit(1);
  const [todayCount] = await db.select({ count: drizzleSql<number>`count(*)::int` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.source, MAINTENANCE_SOURCE), gt(heartbeatRuns.createdAt, startOfUtcDay(now))));
  return {
    now,
    config,
    hasActiveTaskRuns: Boolean(activeRun),
    lastWorkCompletedAt: lastWork?.completedAt ?? null,
    lastMaintenanceAttemptAt: lastAttempt?.createdAt ?? null,
    lastMaintenanceSuccessAt: lastSuccess?.completedAt ?? null,
    maintenanceRunsToday: todayCount?.count ?? 0,
  };
}

async function buildShiftSummary(agent: AgentRow, since: Date | null): Promise<string> {
  const runFilters = [eq(taskRuns.agentId, agent.id), inArray(taskRuns.status, ['success', 'failed']), isNotNull(taskRuns.completedAt)];
  if (since) runFilters.push(gt(taskRuns.completedAt, since));
  const runs = await db.select({
    kind: taskRuns.kind,
    status: taskRuns.status,
    completedAt: taskRuns.completedAt,
    error: taskRuns.error,
    cardId: taskRuns.cardId,
    cardTitle: kanbanCards.title,
  }).from(taskRuns).innerJoin(kanbanCards, eq(kanbanCards.id, taskRuns.cardId))
    .where(and(...runFilters)).orderBy(desc(taskRuns.completedAt)).limit(SHIFT_SUMMARY_RUN_LIMIT);

  const cardIds = [...new Set(runs.map((run) => run.cardId))];
  const cardTitles = new Map(runs.map((run) => [run.cardId, run.cardTitle]));
  const feedbackFilters = [inArray(cardComments.cardId, cardIds), inArray(cardComments.action, ['review_rejected', 'review_guidance', 'review_escalated', 'review_blocked'])];
  if (since) feedbackFilters.push(gt(cardComments.createdAt, since));
  const feedback = cardIds.length > 0
    ? await db.select({ cardId: cardComments.cardId, action: cardComments.action, detail: cardComments.body })
      .from(cardComments).where(and(...feedbackFilters)).orderBy(desc(cardComments.createdAt)).limit(SHIFT_SUMMARY_FEEDBACK_LIMIT)
    : [];

  const productFilters = [eq(workProducts.agentId, agent.id)];
  if (since) productFilters.push(gt(workProducts.createdAt, since));
  const products = await db.select({ title: workProducts.title, url: workProducts.url, pullRequestUrl: workProducts.pullRequestUrl })
    .from(workProducts).where(and(...productFilters)).orderBy(desc(workProducts.createdAt)).limit(SHIFT_SUMMARY_WORK_PRODUCT_LIMIT);

  return formatShiftSummary(
    runs.reverse().map((run) => ({ kind: run.kind, cardTitle: run.cardTitle, status: run.status, completedAt: run.completedAt, error: run.error })),
    feedback.map((item) => ({ cardTitle: cardTitles.get(item.cardId) ?? 'unknown card', action: item.action, detail: item.detail })),
    products,
    since,
  );
}

export type MaintenanceRunResult = { status: 'success' | 'failed' | 'skipped'; reason?: string; heartbeatRunId?: string };

export async function runAgentMaintenance(app: FastifyInstance, agent: AgentRow, options: { source: 'loop' | 'manual'; requestedByUserId?: string | null } = { source: 'manual' }): Promise<MaintenanceRunResult> {
  if (agent.isActive === false) return { status: 'skipped', reason: 'agent_paused' };
  if (!MAINTENANCE_ADAPTER_TYPES.includes(agent.adapterType ?? 'hermes-ssh')) return { status: 'skipped', reason: 'adapter_not_supported' };
  if (!(await budgetOk(agent))) return { status: 'skipped', reason: 'agent_budget_exceeded' };

  const [busyAgent] = await db.update(agents)
    .set({ isBusy: true })
    .where(and(eq(agents.id, agent.id), eq(agents.isBusy, false), eq(agents.isActive, true)))
    .returning();
  if (!busyAgent) return { status: 'skipped', reason: 'agent_busy' };

  const [lastSuccess] = await db.select({ completedAt: heartbeatRuns.completedAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.source, MAINTENANCE_SOURCE), eq(heartbeatRuns.status, 'success')))
    .orderBy(desc(heartbeatRuns.completedAt)).limit(1);
  const since = lastSuccess?.completedAt ?? null;

  const [run] = await db.insert(heartbeatRuns).values({
    companyId: agent.companyId,
    agentId: agent.id,
    source: MAINTENANCE_SOURCE,
    status: 'running',
    startedAt: new Date(),
  }).returning();
  if (!run) {
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    return { status: 'failed', reason: 'heartbeat_run_create_failed' };
  }

  try {
    const shiftSummary = await buildShiftSummary(agent, since);
    const prompt = buildMaintenancePrompt(agent, shiftSummary);
    const timeoutSeconds = await readKanbanTaskTimeoutSeconds();
    // Fresh adapter session on purpose: cross-task continuity lives in the
    // agent's own memory files, not in a resumed session.
    const executionAgent = await buildExecutionAgent(agent, null);
    const task = { id: `maintenance-${agent.id}`, title: 'Shift-end memory consolidation', body: prompt, timeoutSeconds, kind: 'maintenance' as const };
    await recordPromptLog({
      companyId: agent.companyId,
      agentId: agent.id,
      heartbeatRunId: run.id,
      source: MAINTENANCE_SOURCE,
      adapterType: agent.adapterType ?? 'hermes-ssh',
      title: task.title,
      prompt: promptSnapshotForAdapter(executionAgent, task),
      metadata: { trigger: options.source, since: since?.toISOString() ?? null },
    });
    const adapter = getAdapter(agent.adapterType ?? 'hermes-ssh');
    const result = await adapter.dispatch(executionAgent, task);
    if (!result.success) throw new Error(result.output || 'maintenance_run_failed');

    const guard = await getBudgetGuard(agent);
    const nextSpend = Number(agent.spentThisMonth ?? 0) + result.costUsd;
    const overBudget = guard.hardStop && ((guard.monthlyLimit !== null && nextSpend >= guard.monthlyLimit) || (guard.perTaskLimit !== null && result.costUsd > guard.perTaskLimit));
    await db.update(agents).set({
      isBusy: false,
      isActive: overBudget ? false : undefined,
      spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${result.costUsd}`,
    }).where(eq(agents.id, agent.id));
    await db.update(heartbeatRuns).set({
      status: 'success',
      completedAt: new Date(),
      durationSeconds: result.durationSeconds,
      outputTokens: result.tokensUsed,
      costUsd: result.costUsd.toString(),
    }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(costEvents).values({
      companyId: agent.companyId,
      agentId: agent.id,
      provider: agent.adapterType ?? 'unknown',
      model: agent.hermesProfile ?? 'maintenance',
      outputTokens: result.tokensUsed,
      costUsd: result.costUsd.toString(),
    });
    await db.insert(activityLog).values({
      companyId: agent.companyId,
      actorType: 'agent',
      actorId: agent.id,
      agentId: agent.id,
      userId: options.requestedByUserId ?? null,
      action: 'agent.maintenance_completed',
      entityType: 'agent',
      entityId: agent.id,
      details: { heartbeatRunId: run.id, trigger: options.source, costUsd: result.costUsd, overBudget, output: clip(result.output ?? '', 2000) },
    });
    return { status: 'success', heartbeatRunId: run.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'maintenance_run_failed';
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
    await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: message }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(activityLog).values({
      companyId: agent.companyId,
      actorType: 'agent',
      actorId: agent.id,
      agentId: agent.id,
      userId: options.requestedByUserId ?? null,
      action: 'agent.maintenance_failed',
      entityType: 'agent',
      entityId: agent.id,
      details: { heartbeatRunId: run.id, trigger: options.source, error: clip(message, 1000) },
    });
    app.log.warn({ error, agentId: agent.id }, 'agent maintenance run failed');
    return { status: 'failed', reason: message, heartbeatRunId: run.id };
  }
}

let sweepRunning = false;

export async function runMaintenanceSweep(app: FastifyInstance): Promise<{ scanned: number; triggered: number; skipped: number; errors: number }> {
  const result = { scanned: 0, triggered: 0, skipped: 0, errors: 0 };
  if (sweepRunning) return result;
  sweepRunning = true;
  try {
    const now = new Date();
    const candidates = await db.select().from(agents).where(and(
      isNull(agents.deletedAt),
      eq(agents.isActive, true),
      eq(agents.isBusy, false),
      inArray(agents.adapterType, MAINTENANCE_ADAPTER_TYPES),
      drizzleSql`${agents.memoryConfig} ->> 'enabled' = 'true'`,
    ));
    result.scanned = candidates.length;
    for (const agent of candidates) {
      try {
        const input = await collectCandidateInput(agent, now);
        const skip = maintenanceSkipReason(input);
        if (skip) { result.skipped += 1; continue; }
        const run = await runAgentMaintenance(app, agent, { source: 'loop' });
        if (run.status === 'success') result.triggered += 1;
        else if (run.status === 'failed') result.errors += 1;
        else result.skipped += 1;
      } catch (error) {
        result.errors += 1;
        app.log.warn({ error, agentId: agent.id }, 'maintenance sweep skipped agent');
      }
    }
  } catch (error) {
    result.errors += 1;
    app.log.error({ error }, 'maintenance sweep failed');
  } finally {
    sweepRunning = false;
  }
  return result;
}

export function startMaintenanceLoop(app: FastifyInstance): void {
  if (process.env.MAINTENANCE_SWEEP_ENABLED === 'false') return;
  const timer = setInterval(() => { void runMaintenanceSweep(app); }, Math.max(10_000, MAINTENANCE_SWEEP_INTERVAL_MS));
  app.addHook('onClose', async () => clearInterval(timer));
}
