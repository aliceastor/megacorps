import { and, desc, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from './db/client.ts';
import { agentRuntimes, agents, cardComments, companies, goals, kanbanCards, knowledgeDocs, projects, taskLogs } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
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

async function dependenciesMet(card: CardRow): Promise<boolean> {
  const ids = card.dependencyCardIds ?? [];
  if (ids.length === 0) return true;
  const rows = await db.select({ id: kanbanCards.id, columnStatus: kanbanCards.columnStatus }).from(kanbanCards).where(inArray(kanbanCards.id, ids));
  return rows.length === ids.length && rows.every((row) => row.columnStatus === 'done');
}

async function budgetOk(agent: AgentRow): Promise<boolean> {
  if (!agent.budgetMonthly) return true;
  return Number(agent.spentThisMonth ?? 0) < Number(agent.budgetMonthly);
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

export async function cascadeParentStatus(parentCardId: string | null): Promise<void> {
  if (!parentCardId) return;
  const children = await db.select().from(kanbanCards).where(eq(kanbanCards.parentCardId, parentCardId));
  if (children.length === 0 || !children.every((child) => child.columnStatus === 'done')) return;
  const [parent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, parentCardId)).limit(1);
  await db.update(kanbanCards).set({ columnStatus: 'done', completedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, parentCardId));
  if (parent?.columnStatus !== 'done') await addStageLog(parentCardId, null, parent?.columnStatus ?? null, 'done', 'cascade');
  await addTaskLog({ cardId: parentCardId, type: 'cascade', status: 'success', message: 'All sub-tasks completed; parent card marked done.' });
}

async function handleDispatchFailure(card: CardRow, agent: AgentRow, error: unknown): Promise<CardRow> {
  const retryCount = (card.retryCount ?? 0) + 1;
  const maxRetries = card.maxRetries ?? 3;
  const message = error instanceof Error ? error.message : 'dispatch_failed';
  const blocked = retryCount >= maxRetries;
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: blocked ? 'blocked' : 'todo',
    retryCount,
    nextRunAt: blocked ? null : nextBackoff(retryCount),
    lastError: message,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, card.id)).returning();
  await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
  await addStageLog(card.id, agent.id, card.columnStatus, blocked ? 'blocked' : 'todo', 'retry');
  await addTaskLog({
    cardId: card.id,
    agentId: agent.id,
    type: 'retry',
    status: 'failed',
    message: blocked ? `Dispatch failed after ${retryCount} attempt(s); card blocked.` : `Dispatch failed; retry ${retryCount}/${maxRetries} scheduled.`,
    output: message,
  });
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
  if (!(await budgetOk(agent))) throw new Error('agent_budget_exceeded');
  if (!(await dependenciesMet(card))) throw new Error('card_dependencies_not_met');

  await db.update(agents).set({ isBusy: true }).where(eq(agents.id, agent.id));
  await db.update(kanbanCards).set({ columnStatus: 'in_progress', startedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
  if (card.columnStatus !== 'in_progress') await addStageLog(card.id, agent.id, card.columnStatus, 'in_progress', source);
  await addTaskLog({ cardId: card.id, agentId: agent.id, type: source, status: 'running', message: `Dispatch started via ${source}.` });

  try {
    const adapter = getAdapter(agent.adapterType ?? 'hermes');
    const result = await adapter.dispatch(
      await buildExecutionAgent(agent),
      { id: card.id, title: card.title, body: await buildTaskPrompt(card), timeoutSeconds: 300 },
    );
    const nextStatus = card.requiresApproval || card.reviewerId ? 'in_review' : 'done';
    await db.update(agents).set({
      currentSessionId: result.sessionId,
      spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${result.costUsd}`,
      isBusy: false,
    }).where(eq(agents.id, agent.id));
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: nextStatus,
      executionLog: result.output,
      sessionId: result.sessionId,
      costUsd: result.costUsd.toString(),
      retryCount: 0,
      nextRunAt: null,
      completedAt: nextStatus === 'done' ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, card.id)).returning();
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
    if (!updated) throw new Error('card_update_failed');
    if (nextStatus === 'done') await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    return handleDispatchFailure(card, agent, error);
  }
}

export async function reviewCard(cardId: string): Promise<CardRow> {
  const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
  if (!card) throw new Error('card_not_found');
  if (!card.reviewerId) {
    const [updated] = await db.update(kanbanCards).set({ columnStatus: 'done', completedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, card.id)).returning();
    if (card.columnStatus !== 'done') await addStageLog(card.id, null, card.columnStatus, 'done', 'review');
    await addTaskLog({ cardId: card.id, type: 'review', status: 'success', message: 'No reviewer configured; card approved automatically.' });
    if (!updated) throw new Error('card_update_failed');
    await cascadeParentStatus(updated.parentCardId);
    return updated;
  }

  const [reviewer] = await db.select().from(agents).where(eq(agents.id, card.reviewerId)).limit(1);
  if (!reviewer) throw new Error('reviewer_not_found');
  if (reviewer.isBusy) throw new Error('reviewer_busy');

  await db.update(agents).set({ isBusy: true }).where(eq(agents.id, reviewer.id));
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'running', message: 'Review started.' });
  try {
    const adapter = getAdapter(reviewer.adapterType ?? 'hermes');
    const result = await adapter.dispatch(
      await buildExecutionAgent(reviewer),
      { id: card.id, title: `Review: ${card.title}`, body: buildReviewPrompt(card), timeoutSeconds: 180 },
    );
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
    if (!updated) throw new Error('card_update_failed');
    if (!rejected) await cascadeParentStatus(updated.parentCardId);
    return updated;
  } catch (error) {
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, reviewer.id));
    await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'failed', message: error instanceof Error ? error.message : 'review_failed' });
    throw error;
  }
}

export async function decomposeCard(cardId: string): Promise<CardRow[]> {
  const [parent] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).limit(1);
  if (!parent) throw new Error('card_not_found');
  const items = parent.body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  const titles = items.length > 1 ? items : [`Plan ${parent.title}`, `Execute ${parent.title}`, `Review ${parent.title}`];
  const rows = await db.insert(kanbanCards).values(titles.map((title) => ({
    companyId: parent.companyId,
    departmentId: parent.departmentId,
    projectId: parent.projectId,
    goalId: parent.goalId,
    parentCardId: parent.id,
    title,
    body: `Sub-task for ${parent.title}\n\n${title}`,
    columnStatus: 'todo',
    priority: parent.priority,
    tags: [...(parent.tags ?? []), 'subtask'],
    assigneeId: parent.assigneeId,
    reviewerId: parent.reviewerId,
    requiresApproval: parent.requiresApproval,
    createdBy: parent.createdBy,
  }))).returning();
  await addTaskLog({ cardId: parent.id, type: 'decomposition', status: 'success', message: `Created ${rows.length} sub-task(s).` });
  return rows;
}

export async function getTaskLogs(cardId: string) {
  return db.select().from(taskLogs).where(eq(taskLogs.cardId, cardId)).orderBy(desc(taskLogs.createdAt));
}

export function startDispatchLoop(app: FastifyInstance): void {
  if (process.env.DISPATCH_LOOP_ENABLED === 'false') return;
  const tick = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      const now = new Date();
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
  const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.companyId, card.companyId)).orderBy(desc(knowledgeDocs.updatedAt)).limit(10);
  const matchingDocs = docs.filter((doc) => {
    const tags = doc.tags ?? [];
    return tags.length === 0 || tags.some((tag) => (card.tags ?? []).includes(tag));
  }).slice(0, 5);
  return [
    company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    project ? `Project: ${project.name}\n${project.description ?? ''}` : '',
    goal ? `Goal: ${goal.title}\n${goal.body ?? ''}` : '',
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
