import bcrypt from 'bcryptjs';
import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAgentRuntimeSchema, createAgentSchema, createCardCommentSchema, createCardSchema, createCompanySchema, createDepartmentSchema, createGoalSchema, createKnowledgeDocSchema, createProjectSchema, loginSchema, signupSchema, updateCardSchema } from '@megacorps/shared';
import { signSession, requireAuth } from './auth.ts';
import { db } from './db/client.ts';
import { agentRuntimes, agents, apiEvents, cardComments, companies, departments, goals, kanbanCards, knowledgeDocs, projects, taskLogs, users } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { cascadeParentStatus, decomposeCard, dispatchCard, getTaskLogs, reviewCard } from './dispatch.ts';

async function defaultCompanyId(): Promise<string> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
  if (!company) throw new Error('Default company missing. Run migrations.');
  return company.id;
}

function priorityToNumber(priority: string | undefined): number { return priority === 'urgent' ? 3 : priority === 'high' ? 2 : priority === 'low' ? -1 : 0; }
function actorLabel(user: { email?: string; id?: string } | null): string { return user?.email ?? user?.id ?? 'system'; }

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.post('/api/auth/signup', async (request, reply) => {
    const input = signupSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const [user] = await db.insert(users).values({ email: input.email, name: input.name, passwordHash, role: 'admin' }).returning();
    if (!user) return reply.code(500).send({ error: 'signup_failed' });
    const token = await signSession({ id: user.id, email: user.email, role: user.role ?? 'admin' });
    reply.setCookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/', secure: false });
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) return reply.code(401).send({ error: 'invalid_credentials' });
    const token = await signSession({ id: user.id, email: user.email, role: user.role ?? 'viewer' });
    reply.setCookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/', secure: false });
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post('/api/auth/logout', async (_request, reply) => { reply.clearCookie('session', { path: '/' }); return { ok: true }; });
  app.get('/api/me', async (request, reply) => { const user = await requireAuth(request, reply); return user ? { user } : reply; });
  app.get('/api/system-logs', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
    return db.select().from(apiEvents).orderBy(desc(apiEvents.createdAt)).limit(limit);
  });
  app.get('/api/dashboard', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const [cards, agentRows, companyRows, recentTaskLogs, recentApiEvents] = await Promise.all([
      db.select().from(kanbanCards),
      db.select().from(agents),
      db.select().from(companies),
      db.select().from(taskLogs).orderBy(desc(taskLogs.createdAt)).limit(20),
      db.select().from(apiEvents).orderBy(desc(apiEvents.createdAt)).limit(20),
    ]);
    const openCards = cards.filter((card) => !['done', 'blocked'].includes(card.columnStatus ?? 'backlog'));
    const completedCards = cards.filter((card) => card.columnStatus === 'done');
    const blockedCards = cards.filter((card) => card.columnStatus === 'blocked');
    const activeAgents = agentRows.filter((agent) => agent.isActive !== false);
    const busyAgents = agentRows.filter((agent) => agent.isBusy);
    const monthlyCost = cards.reduce((sum, card) => sum + Number(card.costUsd ?? 0), 0);
    return {
      stats: {
        companies: companyRows.length,
        tasks: cards.length,
        openTasks: openCards.length,
        completedTasks: completedCards.length,
        blockedTasks: blockedCards.length,
        agents: agentRows.length,
        activeAgents: activeAgents.length,
        busyAgents: busyAgents.length,
        monthlyCost: Number(monthlyCost.toFixed(4)),
      },
      stages: cards.reduce<Record<string, number>>((acc, card) => {
        const key = card.columnStatus ?? 'backlog';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      recentTaskLogs,
      recentApiEvents,
    };
  });

  app.get('/api/companies', async () => db.select().from(companies).orderBy(desc(companies.createdAt)));
  app.post('/api/companies', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createCompanySchema.parse(request.body);
    const [company] = await db.insert(companies).values({
      name: input.name,
      slug: input.slug,
      mission: input.mission ?? null,
      dispatchIntervalSeconds: input.dispatchIntervalSeconds,
      autoDispatchEnabled: input.autoDispatchEnabled,
    }).returning();
    return reply.code(201).send(company);
  });
  app.put('/api/companies/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = createCompanySchema.partial().parse(request.body);
    const [company] = await db.update(companies).set({
      name: input.name,
      slug: input.slug,
      mission: input.mission,
      dispatchIntervalSeconds: input.dispatchIntervalSeconds,
      autoDispatchEnabled: input.autoDispatchEnabled,
    }).where(eq(companies.id, id)).returning();
    if (!company) return reply.code(404).send({ error: 'company_not_found' });
    return company;
  });

  app.get('/api/departments', async (request) => {
    const query = request.query as { companyId?: string };
    return db.select().from(departments).where(query.companyId ? eq(departments.companyId, query.companyId) : undefined).orderBy(desc(departments.createdAt));
  });
  app.post('/api/departments', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createDepartmentSchema.parse(request.body);
    const [department] = await db.insert(departments).values(input).returning();
    return reply.code(201).send(department);
  });

  app.get('/api/cards', async (request) => {
    const query = request.query as { status?: string; assigneeId?: string; tag?: string; priority?: string; limit?: string; offset?: string };
    const filters = [
      query.status ? eq(kanbanCards.columnStatus, query.status) : undefined,
      query.assigneeId ? eq(kanbanCards.assigneeId, query.assigneeId) : undefined,
      query.priority ? eq(kanbanCards.priority, priorityToNumber(query.priority)) : undefined,
      query.tag ? drizzleSql`${query.tag} = ANY(${kanbanCards.tags})` : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;
    return db.select().from(kanbanCards).where(where).orderBy(desc(kanbanCards.updatedAt)).limit(Number(query.limit ?? 100)).offset(Number(query.offset ?? 0));
  });

  app.post('/api/cards', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createCardSchema.parse(request.body);
    const [card] = await db.insert(kanbanCards).values({
      companyId: input.companyId ?? await defaultCompanyId(),
      title: input.title,
      body: input.body,
      priority: priorityToNumber(input.priority),
      tags: input.tags,
      departmentId: input.departmentId ?? null,
      assigneeId: input.assigneeId ?? null,
      reviewerId: input.reviewerId ?? null,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      parentCardId: input.parentCardId ?? null,
      dependencyCardIds: input.dependencyCardIds,
      requiresApproval: input.requiresApproval,
      maxRetries: input.maxRetries,
      createdBy: user.id,
    }).returning();
    if (card) await db.insert(taskLogs).values({ cardId: card.id, type: 'stage', status: 'success', message: `Stage set to ${card.columnStatus ?? 'backlog'} by ${actorLabel(user)}` });
    return reply.code(201).send(card);
  });

  app.put('/api/cards/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = updateCardSchema.parse(request.body);
    const [existing] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    if (input.updatedAt && existing.updatedAt && new Date(input.updatedAt).getTime() !== existing.updatedAt.getTime()) return reply.code(409).send({ error: 'card_modified' });
    const [card] = await db.update(kanbanCards).set({
      title: input.title,
      body: input.body,
      columnStatus: input.columnStatus,
      priority: input.priority ? priorityToNumber(input.priority) : undefined,
      tags: input.tags,
      departmentId: input.departmentId,
      assigneeId: input.assigneeId,
      reviewerId: input.reviewerId,
      projectId: input.projectId,
      goalId: input.goalId,
      parentCardId: input.parentCardId,
      dependencyCardIds: input.dependencyCardIds,
      requiresApproval: input.requiresApproval,
      maxRetries: input.maxRetries,
      completedAt: input.columnStatus === 'done' ? new Date() : undefined,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, id)).returning();
    if (card && input.columnStatus && input.columnStatus !== existing.columnStatus) {
      await db.insert(taskLogs).values({
        cardId: card.id,
        agentId: card.assigneeId,
        type: 'stage',
        status: 'success',
        message: `Stage changed from ${existing.columnStatus ?? 'backlog'} to ${input.columnStatus} by ${actorLabel(user)}`,
      });
    }
    return card;
  });

  app.delete('/api/cards/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    await db.update(kanbanCards).set({ parentCardId: null }).where(eq(kanbanCards.parentCardId, id));
    await db.delete(cardComments).where(eq(cardComments.cardId, id));
    await db.delete(taskLogs).where(eq(taskLogs.cardId, id));
    await db.delete(kanbanCards).where(eq(kanbanCards.id, id));
    return { ok: true };
  });
  app.get('/api/cards/:id/logs', async (request) => getTaskLogs((request.params as { id: string }).id));
  app.get('/api/cards/:id/comments', async (request) => db.select().from(cardComments).where(eq(cardComments.cardId, (request.params as { id: string }).id)).orderBy(desc(cardComments.createdAt)));
  app.post('/api/cards/:id/comments', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = createCardCommentSchema.parse(request.body);
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, id)).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    const [comment] = await db.insert(cardComments).values({ cardId: id, authorType: 'user', authorId: user.id, body: input.body, action: input.action }).returning();
    await db.insert(taskLogs).values({ cardId: id, agentId: card.assigneeId, type: 'comment', status: 'success', message: `${actorLabel(user)} added a ${input.action} comment.`, output: input.body });
    if (input.action === 'pause_agent') {
      if (card.assigneeId) await db.update(agents).set({ isBusy: false, isActive: false }).where(eq(agents.id, card.assigneeId));
      await db.update(kanbanCards).set({ columnStatus: 'blocked', lastError: `Paused by ${actorLabel(user)}: ${input.body}`, updatedAt: new Date() }).where(eq(kanbanCards.id, id));
      await db.insert(taskLogs).values({ cardId: id, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'backlog'} to blocked by ${actorLabel(user)}.` });
    } else if (input.action === 'continue_run') {
      if (card.assigneeId) await db.update(agents).set({ isActive: true, isBusy: false }).where(eq(agents.id, card.assigneeId));
      await db.update(kanbanCards).set({ columnStatus: 'todo', lastError: null, nextRunAt: null, updatedAt: new Date() }).where(eq(kanbanCards.id, id));
      await db.insert(taskLogs).values({ cardId: id, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'backlog'} to todo by ${actorLabel(user)}.` });
    } else if (input.action === 'send_to_agent') {
      await db.insert(taskLogs).values({ cardId: id, agentId: card.assigneeId, type: 'comment', status: 'queued', message: 'Comment queued for agent context on the next run.', output: input.body });
    }
    return reply.code(201).send(comment);
  });
  app.post('/api/cards/:id/run', async (request, reply) => {
    try { return await dispatchCard((request.params as { id: string }).id, 'manual'); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'dispatch_failed' }); }
  });
  app.post('/api/cards/:id/review', async (request, reply) => {
    try { return await reviewCard((request.params as { id: string }).id); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'review_failed' }); }
  });
  app.post('/api/cards/:id/decompose', async (request, reply) => {
    try { return reply.code(201).send(await decomposeCard((request.params as { id: string }).id)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'decompose_failed' }); }
  });

  app.get('/api/agents', async () => db.select().from(agents));
  app.post('/api/agents', async (request, reply) => {
    const input = createAgentSchema.parse(request.body);
    const [agent] = await db.insert(agents).values({ companyId: input.companyId ?? await defaultCompanyId(), departmentId: input.departmentId ?? null, slug: input.slug, name: input.name, role: input.role, title: input.title, adapterType: input.adapterType, adapterConfig: input.adapterConfig ?? {}, runtimeId: input.runtimeId ?? null, hermesProfile: input.hermesProfile, bossId: input.bossId ?? null, budgetPerTask: input.budgetPerTask?.toString(), budgetMonthly: input.budgetMonthly?.toString() }).returning();
    return reply.code(201).send(agent);
  });
  app.delete('/api/agents/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    await db.update(kanbanCards).set({ assigneeId: null }).where(eq(kanbanCards.assigneeId, id));
    await db.delete(agents).where(eq(agents.id, id));
    return { ok: true };
  });
  app.post('/api/agents/:id/pause', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return agent;
  });
  app.post('/api/agents/:id/resume', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.update(agents).set({ isActive: true }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return agent;
  });
  app.post('/api/agents/:id/reset-session', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.update(agents).set({ currentSessionId: null, isBusy: false }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return agent;
  });
  app.put('/api/agents/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createAgentSchema.partial().parse(request.body);
    const [agent] = await db.update(agents).set({
      name: input.name,
      slug: input.slug,
      role: input.role,
      title: input.title,
      departmentId: input.departmentId,
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      runtimeId: input.runtimeId,
      hermesProfile: input.hermesProfile,
      bossId: input.bossId,
      budgetPerTask: input.budgetPerTask?.toString(),
      budgetMonthly: input.budgetMonthly?.toString(),
    }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return agent;
  });

  app.get('/api/agent-runtimes', async () => db.select().from(agentRuntimes).orderBy(desc(agentRuntimes.createdAt)));
  app.post('/api/agent-runtimes', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createAgentRuntimeSchema.parse(request.body);
    const [row] = await db.insert(agentRuntimes).values(input).returning();
    return reply.code(201).send(row);
  });
  app.put('/api/agent-runtimes/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = createAgentRuntimeSchema.partial().parse(request.body);
    const [row] = await db.update(agentRuntimes).set({
      name: input.name,
      adapterType: input.adapterType,
      config: input.config,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(agentRuntimes.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'runtime_not_found' });
    return row;
  });
  app.delete('/api/agent-runtimes/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    await db.update(agents).set({ runtimeId: null }).where(eq(agents.runtimeId, id));
    await db.delete(agentRuntimes).where(eq(agentRuntimes.id, id));
    return { ok: true };
  });

  app.post('/api/agents/:id/test-connection', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    try {
      const adapter = getAdapter(agent.adapterType ?? 'hermes');
      let runtimeConfig: Record<string, unknown> = {};
      if (agent.runtimeId) {
        const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1);
        if (runtime && runtime.isActive === false) return reply.code(400).send({ error: 'runtime_inactive' });
        runtimeConfig = (runtime?.config as Record<string, unknown> | null) ?? {};
      }
      return await adapter.dispatch({
        hermesProfile: agent.hermesProfile,
        currentSessionId: agent.currentSessionId,
        adapterConfig: { ...runtimeConfig, ...((agent.adapterConfig as Record<string, unknown> | null) ?? {}) },
      }, { id: 'test', title: 'Connection test', body: 'Return OK.', timeoutSeconds: 30 });
    }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'connection_failed' }); }
  });

  app.get('/api/projects', async (request) => {
    const query = request.query as { companyId?: string };
    return db.select().from(projects).where(query.companyId ? eq(projects.companyId, query.companyId) : undefined).orderBy(desc(projects.createdAt));
  });
  app.post('/api/projects', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createProjectSchema.parse(request.body);
    const [row] = await db.insert(projects).values({ companyId: input.companyId ?? await defaultCompanyId(), name: input.name, description: input.description }).returning();
    return reply.code(201).send(row);
  });
  app.get('/api/goals', async (request) => {
    const query = request.query as { companyId?: string };
    return db.select().from(goals).where(query.companyId ? eq(goals.companyId, query.companyId) : undefined).orderBy(desc(goals.createdAt));
  });
  app.post('/api/goals', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createGoalSchema.parse(request.body);
    const [row] = await db.insert(goals).values({ companyId: input.companyId ?? await defaultCompanyId(), title: input.title, body: input.body }).returning();
    return reply.code(201).send(row);
  });
  app.get('/api/knowledge-docs', async (request) => {
    const query = request.query as { companyId?: string; tag?: string };
    const filters = [
      query.companyId ? eq(knowledgeDocs.companyId, query.companyId) : undefined,
      query.tag ? drizzleSql`${query.tag} = ANY(${knowledgeDocs.tags})` : undefined,
    ].filter(Boolean);
    return db.select().from(knowledgeDocs).where(filters.length ? and(...filters) : undefined).orderBy(desc(knowledgeDocs.updatedAt));
  });
  app.post('/api/knowledge-docs', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createKnowledgeDocSchema.parse(request.body);
    const [row] = await db.insert(knowledgeDocs).values({ ...input, createdBy: user.id }).returning();
    return reply.code(201).send(row);
  });
  app.put('/api/knowledge-docs/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const id = (request.params as { id: string }).id;
    const input = createKnowledgeDocSchema.partial().parse(request.body);
    const [row] = await db.update(knowledgeDocs).set({ ...input, updatedAt: new Date() }).where(eq(knowledgeDocs.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'knowledge_doc_not_found' });
    return row;
  });
  app.delete('/api/knowledge-docs/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    await db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, (request.params as { id: string }).id));
    return { ok: true };
  });

  app.post('/api/webhook/task-complete', async (request, reply) => {
    const body = request.body as { cardId?: string; status?: string; summary?: string; output?: string; costUsd?: number };
    if (!body.cardId || !body.status) return reply.code(400).send({ error: 'missing_fields' });
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, body.cardId)).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    const executionLog = body.summary ? `${body.summary}\n\n${body.output || ''}` : (body.output || '');
    await db.update(kanbanCards).set({ columnStatus: body.status, executionLog, costUsd: body.costUsd?.toString(), completedAt: body.status === 'done' ? new Date() : undefined, updatedAt: new Date() }).where(eq(kanbanCards.id, body.cardId));
    if (body.status !== card.columnStatus) await db.insert(taskLogs).values({ cardId: body.cardId, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'backlog'} to ${body.status} by webhook` });
    await db.insert(taskLogs).values({ cardId: body.cardId, agentId: card.assigneeId, type: 'webhook', status: body.status === 'blocked' ? 'failed' : 'success', message: body.summary ?? `Webhook marked card ${body.status}`, output: body.output, costUsd: body.costUsd?.toString() });
    if (card.assigneeId && body.costUsd) {
      await db.update(agents).set({ spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${body.costUsd}` }).where(eq(agents.id, card.assigneeId));
    }
    if (body.status === 'done') await cascadeParentStatus(card.parentCardId);
    return { ok: true, cardId: body.cardId, newStatus: body.status };
  });

  app.get('/api/help', async () => {
    return `MegaCorps API Documentation
===========================

Endpoints:
- GET /api/cards
- POST /api/cards
- PUT /api/cards/:id
- DELETE /api/cards/:id
- POST /api/cards/:id/run
- GET /api/agents
- POST /api/agents
- DELETE /api/agents/:id
- POST /api/webhook/task-complete

Webhook Payload:
{
  "cardId": "uuid",
  "status": "done" | "blocked" | "in_review",
  "summary": "...",
  "output": "...",
  "costUsd": 0.05
}
`;
  });
}
