import { createChatMessageSchema, createChatSessionSchema } from '@megacorps/shared';
import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.ts';
import { requireAnyVisibleCompany, requireCompanyRole } from './access.ts';
import { getAdapter } from './adapters/registry.ts';
import { db } from './db/client.ts';
import { activityLog, agentRuntimes, agents, chatMessages, chatSessions, companies, costEvents, departments, goals, heartbeatRuns, positions, projects } from './db/schema.ts';
import { budgetOk, buildCompanyKanbanContext, buildExecutionAgent, getBudgetGuard } from './dispatch.ts';
import { publishLiveEvent } from './live.ts';
import { findAdapterSession, rememberAdapterSession } from './adapter-sessions.ts';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';

type ChatMessageRow = typeof chatMessages.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type GoalRow = typeof goals.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type RuntimeRow = typeof agentRuntimes.$inferSelect;

function titleFromMessage(body: string, agentName: string): string {
  const firstLine = body.replace(/\s+/g, ' ').trim().slice(0, 72);
  return firstLine || `Chat with ${agentName}`;
}

function formatGoal(goal: GoalRow): string {
  const scope = goal.projectId ? 'Project goal' : goal.departmentId ? 'Department goal' : 'Company goal';
  return `- ${scope}: ${goal.title}${goal.body ? `\n  ${goal.body.slice(0, 1200)}` : ''}`;
}

function runtimeLocalContext(runtime: RuntimeRow | null | undefined): string {
  return [
    `Runtime-local workspace root: ${runtime?.localWorkspaceRoot ?? 'not configured'}`,
    `Runtime-local scratch root: ${runtime?.localScratchRoot ?? 'not configured'}`,
  ].join('\n');
}

function projectRepoContext(project: ProjectRow | null | undefined, runtime?: RuntimeRow | null): string {
  if (!project) return [
    'Project repository: none',
    runtimeLocalContext(runtime),
    'Repository rule: no repo is configured, so do not invent shared local workspace paths. Runtime-local scratch is only for temporary work.',
  ].join('\n');
  return [
    `Project repository provider: ${project.repoProvider ?? 'github'}`,
    `Project repository URL: ${project.repoUrl ?? 'not configured'}`,
    `Project work path: ${project.workPath ?? 'project root'}`,
    runtimeLocalContext(runtime),
    `Default branch: ${project.defaultBranch ?? 'main'}`,
    `Task branch pattern: ${project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}'}`,
    `Pull before run: ${project.pullBeforeRun === false ? 'no' : 'yes'}`,
    `Push after run: ${project.pushAfterRun === false ? 'no' : 'yes'}`,
    `Completion policy: ${project.completionPolicy ?? 'push_or_pr'}`,
    project.setupCommand ? `Setup command: ${project.setupCommand}` : '',
    project.testCommand ? `Test command: ${project.testCommand}` : '',
    project.repoUrl
      ? 'Repository rule: use your runtime-owned local clone under the runtime-local workspace root when configured, stay inside the project work path unless explicitly required, pull/rebase before code changes, commit and push/PR completed work, and report PR/commit/preview links rather than local-only paths.'
      : 'Repository rule: no repo is configured, so do not invent shared local workspace paths. Runtime-local scratch is only for temporary work.',
  ].filter(Boolean).join('\n');
}

async function buildDirectChatGoalContext(companyId: string, agent: AgentRow, projectId: string | null): Promise<string> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [project] = projectId ? await db.select().from(projects).where(eq(projects.id, projectId)).limit(1) : [];
  const [runtime] = agent.runtimeId ? await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1) : [];
  const [department] = agent.departmentId ? await db.select().from(departments).where(eq(departments.id, agent.departmentId)).limit(1) : [];
  const [position] = agent.positionId ? await db.select().from(positions).where(and(eq(positions.id, agent.positionId), eq(positions.companyId, companyId))).limit(1) : [];
  const companyGoals = await db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(desc(goals.createdAt));
  const positionPrompt = formatAgentPositionPrompt({ positionName: position?.name, departmentName: department?.name, companyName: company?.name, customPrompt: position?.prompt });
  return [
    `Project: ${project?.name ?? 'No project / general chat'}`,
    project?.description ? `Project description: ${project.description}` : '',
    projectRepoContext(project, runtime),
    `Department: ${department?.name ?? 'none'}`,
    positionPrompt ? `Position prompt:\n${positionPrompt}` : '',
    `Company goals:\n${companyGoals.filter((goal) => !goal.departmentId && !goal.projectId).map(formatGoal).join('\n') || 'none'}`,
    `Department goals:\n${agent.departmentId ? companyGoals.filter((goal) => goal.departmentId === agent.departmentId).map(formatGoal).join('\n') || 'none' : 'none'}`,
    `Project goals:\n${projectId ? companyGoals.filter((goal) => goal.projectId === projectId).map(formatGoal).join('\n') || 'none' : 'none'}`,
  ].filter(Boolean).join('\n');
}

function buildChatPrompt(company: CompanyRow | undefined, agent: AgentRow, history: ChatMessageRow[], kanbanContext: string, goalContext: string): string {
  return [
    company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    `Goal context:\n${goalContext}`,
    [
      `Agent name: ${agent.name}`,
      `Identity label: ${agent.role}`,
      `Title: ${agent.title ?? 'none'}`,
      agent.soul ? `Soul:\n${agent.soul.slice(0, 1200)}` : '',
      `Adapter: ${agent.adapterType}`,
    ].join('\n'),
    `Kanban context snapshot:\n${kanbanContext}`,
    'Conversation history:',
    history.map((message) => `[${message.authorType}] ${message.body}`).join('\n\n'),
  ].filter(Boolean).join('\n\n');
}

async function addChatActivity(input: {
  companyId: string;
  agentId: string;
  userId?: string | null;
  action: string;
  sessionId: string;
  details?: Record<string, unknown>;
}) {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.userId ? 'user' : 'system',
    actorId: input.userId ?? 'system',
    userId: input.userId ?? null,
    agentId: input.agentId,
    action: input.action,
    entityType: 'chat_session',
    entityId: input.sessionId,
    details: input.details ?? {},
  });
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chat/sessions', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; agentId?: string; projectId?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(chatSessions.companyId, query.companyId) : inArray(chatSessions.companyId, access.companyIds),
      query.agentId ? eq(chatSessions.agentId, query.agentId) : undefined,
      query.projectId === 'none' ? isNull(chatSessions.projectId) : query.projectId ? eq(chatSessions.projectId, query.projectId) : undefined,
    ].filter(Boolean);
    return db.select().from(chatSessions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(Math.min(Math.max(Number(query.limit ?? 100), 1), 300));
  });

  app.post('/api/chat/sessions', async (request, reply) => {
    const input = createChatSessionSchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    if (agent.companyId !== input.companyId) return reply.code(400).send({ error: 'agent_company_mismatch' });
    if (input.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId))).limit(1);
      if (!project) return reply.code(400).send({ error: 'project_company_mismatch' });
    }
    const [session] = await db.insert(chatSessions).values({
      companyId: input.companyId,
      agentId: input.agentId,
      projectId: input.projectId ?? null,
      userId: user.id,
      title: input.title ?? `Chat with ${agent.name}`,
    }).returning();
    if (!session) return reply.code(500).send({ error: 'chat_session_create_failed' });
    await addChatActivity({ companyId: session.companyId, agentId: session.agentId, userId: user.id, action: 'chat.session_created', sessionId: session.id, details: { title: session.title } });
    return reply.code(201).send(session);
  });

  app.get('/api/chat/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { limit?: string };
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const user = await requireCompanyRole(request, reply, session.companyId, 'viewer'); if (!user) return reply;
    const rows = await db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
    return rows.reverse();
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createChatMessageSchema.parse(request.body);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const user = await requireCompanyRole(request, reply, session.companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, session.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const [company] = await db.select().from(companies).where(eq(companies.id, session.companyId)).limit(1);

    const now = new Date();
    const [userMessage] = await db.insert(chatMessages).values({
      sessionId: session.id,
      companyId: session.companyId,
      agentId: session.agentId,
      userId: user.id,
      authorType: 'user',
      body: input.body,
      metadata: {},
    }).returning();
    if (!userMessage) return reply.code(500).send({ error: 'chat_message_create_failed' });
    publishLiveEvent({
      type: 'chat.message.created',
      companyId: session.companyId,
      entityType: 'chat_message',
      entityId: userMessage.id,
      sessionId: session.id,
      projectId: session.projectId,
      data: { authorType: 'user', agentId: session.agentId },
    });

    await db.update(chatSessions).set({
      title: session.title.startsWith('Chat with ') ? titleFromMessage(input.body, agent.name) : session.title,
      updatedAt: now,
    }).where(eq(chatSessions.id, session.id));

    if (agent.isActive === false) {
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is paused. Resume the agent before starting a direct chat run.`,
        metadata: { error: 'agent_paused' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.agent_paused', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_paused' } });
      return reply.code(409).send({ error: 'agent_paused', userMessage, systemMessage });
    }

    if (!(await budgetOk(agent))) {
      await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, agent.id));
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is over budget and was paused before starting a direct chat run.`,
        metadata: { error: 'agent_budget_exceeded' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.budget_blocked', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_budget_exceeded' } });
      return reply.code(409).send({ error: 'agent_budget_exceeded', userMessage, systemMessage });
    }

    const [busyAgent] = await db.update(agents).set({ isBusy: true }).where(and(eq(agents.id, agent.id), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
    if (!busyAgent) {
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is busy. Try this session again after the current run finishes.`,
        metadata: { error: 'agent_busy' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.agent_busy', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_busy' } });
      return reply.code(409).send({ error: 'agent_busy', userMessage, systemMessage });
    }

    const [run] = await db.insert(heartbeatRuns).values({
      companyId: session.companyId,
      agentId: agent.id,
      source: 'chat',
      status: 'running',
      startedAt: now,
    }).returning();
    if (!run) {
      await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
      return reply.code(500).send({ error: 'heartbeat_run_create_failed' });
    }

    try {
      publishLiveEvent({
        type: 'chat.reply.started',
        companyId: session.companyId,
        entityType: 'chat_session',
        entityId: session.id,
        sessionId: session.id,
        projectId: session.projectId,
        data: { agentId: agent.id, runId: run.id },
      });
      const recent = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, session.id)).orderBy(desc(chatMessages.createdAt)).limit(30);
      const kanbanContext = await buildCompanyKanbanContext(session.companyId, { focusAgentId: agent.id, budgetChars: 20_000 });
      const goalContext = await buildDirectChatGoalContext(session.companyId, agent, session.projectId);
      const prompt = buildChatPrompt(company, agent, recent.reverse(), kanbanContext, goalContext);
      const adapter = getAdapter(agent.adapterType ?? 'hermes');
      const adapterSession = agent.adapterType === 'codex-app'
        ? await findAdapterSession({
          companyId: session.companyId,
          agentId: agent.id,
          runtimeId: agent.runtimeId,
          adapterType: agent.adapterType,
          scopeType: 'chat',
          scopeId: session.id,
          kind: 'chat',
        })
        : null;
      const result = await adapter.dispatch(
        await buildExecutionAgent(agent, adapterSession?.adapterSessionId ?? session.agentSessionId ?? null),
        { id: `chat-${session.id}`, title: session.title, body: prompt, timeoutSeconds: 300, kind: 'chat' },
      );
      if (agent.adapterType === 'codex-app') {
        await rememberAdapterSession({
          companyId: session.companyId,
          agentId: agent.id,
          runtimeId: agent.runtimeId,
          adapterType: agent.adapterType,
          scopeType: 'chat',
          scopeId: session.id,
          kind: 'chat',
          adapterSessionId: result.sessionId,
          lastTurnId: result.turnId ?? null,
          metadata: { heartbeatRunId: run.id },
        });
      }
      if (!result.success) throw new Error(result.output || 'agent_chat_failed');

      const guard = await getBudgetGuard(agent);
      const nextSpend = Number(agent.spentThisMonth ?? 0) + result.costUsd;
      const monthlyExceeded = guard.monthlyLimit !== null && nextSpend >= guard.monthlyLimit;
      const taskExceeded = guard.perTaskLimit !== null && result.costUsd > guard.perTaskLimit;
      const overBudget = guard.hardStop && (monthlyExceeded || taskExceeded);
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
        companyId: session.companyId,
        agentId: agent.id,
        projectId: session.projectId,
        provider: agent.adapterType ?? 'unknown',
        model: agent.hermesProfile ?? 'direct-chat',
        outputTokens: result.tokensUsed,
        costUsd: result.costUsd.toString(),
      });
      const [agentMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        authorType: 'agent',
        body: result.output,
        metadata: { runId: run.id, adapterType: agent.adapterType, sessionId: result.sessionId, tokensUsed: result.tokensUsed, overBudget },
        costUsd: result.costUsd.toString(),
        durationSeconds: result.durationSeconds,
      }).returning();
      const [updatedSession] = await db.update(chatSessions).set({
        agentSessionId: result.sessionId,
        updatedAt: new Date(),
      }).where(eq(chatSessions.id, session.id)).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: overBudget ? 'chat.budget_hard_stop' : 'chat.reply_received', sessionId: session.id, details: { runId: run.id, costUsd: result.costUsd, overBudget, monthlyExceeded, taskExceeded } });
      if (agentMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: agentMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'agent', agentId: session.agentId, runId: run.id } });
      publishLiveEvent({ type: 'chat.reply.finished', companyId: session.companyId, entityType: 'chat_session', entityId: session.id, sessionId: session.id, projectId: session.projectId, data: { agentId: agent.id, runId: run.id, status: 'success' } });
      return { session: updatedSession, userMessage, agentMessage };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent_chat_failed';
      await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
      await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: message }).where(eq(heartbeatRuns.id, run.id));
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `Agent chat failed: ${message}`,
        metadata: { runId: run.id, error: message },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.failed', sessionId: session.id, details: { runId: run.id, error: message } });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, runId: run.id, error: message } });
      publishLiveEvent({ type: 'chat.reply.finished', companyId: session.companyId, entityType: 'chat_session', entityId: session.id, sessionId: session.id, projectId: session.projectId, data: { agentId: agent.id, runId: run.id, status: 'failed', error: message } });
      return reply.code(502).send({ error: message, userMessage, systemMessage });
    }
  });
}
