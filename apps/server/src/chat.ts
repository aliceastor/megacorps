import { createChatMessageSchema, createChatSessionSchema } from '@megacorps/shared';
import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.ts';
import { getAdapter } from './adapters/registry.ts';
import { db } from './db/client.ts';
import { activityLog, agents, chatMessages, chatSessions, companies, costEvents, heartbeatRuns } from './db/schema.ts';
import { buildCompanyKanbanContext, buildExecutionAgent } from './dispatch.ts';

type ChatMessageRow = typeof chatMessages.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

function titleFromMessage(body: string, agentName: string): string {
  const firstLine = body.replace(/\s+/g, ' ').trim().slice(0, 72);
  return firstLine || `Chat with ${agentName}`;
}

function buildChatPrompt(company: CompanyRow | undefined, agent: AgentRow, history: ChatMessageRow[], kanbanContext: string): string {
  return [
    company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    [
      `Agent name: ${agent.name}`,
      `Identity label: ${agent.role}`,
      `Title: ${agent.title ?? 'none'}`,
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
    const user = await requireAuth(request, reply); if (!user) return reply;
    const query = request.query as { companyId?: string; agentId?: string; limit?: string };
    const filters = [
      query.companyId ? eq(chatSessions.companyId, query.companyId) : undefined,
      query.agentId ? eq(chatSessions.agentId, query.agentId) : undefined,
    ].filter(Boolean);
    return db.select().from(chatSessions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(Math.min(Math.max(Number(query.limit ?? 100), 1), 300));
  });

  app.post('/api/chat/sessions', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createChatSessionSchema.parse(request.body);
    const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    if (agent.companyId !== input.companyId) return reply.code(400).send({ error: 'agent_company_mismatch' });
    const [session] = await db.insert(chatSessions).values({
      companyId: input.companyId,
      agentId: input.agentId,
      userId: user.id,
      title: input.title ?? `Chat with ${agent.name}`,
    }).returning();
    if (!session) return reply.code(500).send({ error: 'chat_session_create_failed' });
    await addChatActivity({ companyId: session.companyId, agentId: session.agentId, userId: user.id, action: 'chat.session_created', sessionId: session.id, details: { title: session.title } });
    return reply.code(201).send(session);
  });

  app.get('/api/chat/sessions/:id/messages', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const query = request.query as { limit?: string };
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const rows = await db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
    return rows.reverse();
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = createChatMessageSchema.parse(request.body);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const [agent] = await db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
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
      return reply.code(409).send({ error: 'agent_paused', userMessage, systemMessage });
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
      const recent = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, session.id)).orderBy(desc(chatMessages.createdAt)).limit(30);
      const kanbanContext = await buildCompanyKanbanContext(session.companyId, { focusAgentId: agent.id, budgetChars: 20_000 });
      const prompt = buildChatPrompt(company, agent, recent.reverse(), kanbanContext);
      const adapter = getAdapter(agent.adapterType ?? 'hermes');
      const result = await adapter.dispatch(
        await buildExecutionAgent(agent, session.agentSessionId ?? null),
        { id: `chat-${session.id}`, title: session.title, body: prompt, timeoutSeconds: 300, kind: 'chat' },
      );
      if (!result.success) throw new Error(result.output || 'agent_chat_failed');

      const nextSpend = Number(agent.spentThisMonth ?? 0) + result.costUsd;
      const monthlyLimit = agent.budgetMonthly ? Number(agent.budgetMonthly) : null;
      const overBudget = monthlyLimit !== null && monthlyLimit > 0 && nextSpend >= monthlyLimit;
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
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.reply_received', sessionId: session.id, details: { runId: run.id, costUsd: result.costUsd, overBudget } });
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
      return reply.code(502).send({ error: message, userMessage, systemMessage });
    }
  });
}
