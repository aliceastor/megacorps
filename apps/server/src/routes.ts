import bcrypt from 'bcryptjs';
import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAgentSchema, createCardSchema, loginSchema, signupSchema, updateCardSchema, canTransitionCard, type CardStatus } from '@megacorps/shared';
import { signSession, requireAuth } from './auth.ts';
import { db } from './db/client.ts';
import { agentRuntimes, agents, apiEvents, companies, goals, kanbanCards, projects, taskLogs, users } from './db/schema.ts';
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
      companyId: await defaultCompanyId(),
      title: input.title,
      body: input.body,
      priority: priorityToNumber(input.priority),
      tags: input.tags,
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

  app.delete('/api/cards/:id', async (request) => { const id = (request.params as { id: string }).id; await db.delete(kanbanCards).where(eq(kanbanCards.id, id)); return { ok: true }; });
  app.get('/api/cards/:id/logs', async (request) => getTaskLogs((request.params as { id: string }).id));
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
    const [agent] = await db.insert(agents).values({ companyId: await defaultCompanyId(), slug: input.slug, name: input.name, role: input.role, title: input.title, adapterType: input.adapterType, hermesProfile: input.hermesProfile, bossId: input.bossId ?? null, budgetPerTask: input.budgetPerTask?.toString(), budgetMonthly: input.budgetMonthly?.toString() }).returning();
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
      adapterType: input.adapterType,
      hermesProfile: input.hermesProfile,
      bossId: input.bossId,
      budgetPerTask: input.budgetPerTask?.toString(),
      budgetMonthly: input.budgetMonthly?.toString(),
    }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return agent;
  });

  app.get('/api/agent-runtimes', async () => db.select().from(agentRuntimes));
  app.post('/api/agent-runtimes', async (request, reply) => {
    const body = request.body as { name?: string; adapterType?: string; config?: Record<string, unknown> };
    if (!body.name || !body.adapterType) return reply.code(400).send({ error: 'name_and_adapter_required' });
    const [row] = await db.insert(agentRuntimes).values({ name: body.name, adapterType: body.adapterType, config: body.config ?? {} }).returning();
    return reply.code(201).send(row);
  });

  app.post('/api/agents/:id/test-connection', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    try { const adapter = getAdapter(agent.adapterType ?? 'hermes'); return await adapter.dispatch({ hermesProfile: agent.hermesProfile, currentSessionId: agent.currentSessionId, adapterConfig: {} }, { id: 'test', title: 'Connection test', body: 'Return OK.', timeoutSeconds: 30 }); }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'connection_failed' }); }
  });

  app.get('/api/projects', async () => db.select().from(projects));
  app.post('/api/projects', async (request, reply) => { const body = request.body as { name?: string; description?: string }; if (!body.name) return reply.code(400).send({ error: 'name_required' }); const [row] = await db.insert(projects).values({ companyId: await defaultCompanyId(), name: body.name, description: body.description }).returning(); return reply.code(201).send(row); });
  app.get('/api/goals', async () => db.select().from(goals));
  app.post('/api/goals', async (request, reply) => { const body = request.body as { title?: string; body?: string }; if (!body.title) return reply.code(400).send({ error: 'title_required' }); const [row] = await db.insert(goals).values({ companyId: await defaultCompanyId(), title: body.title, body: body.body }).returning(); return reply.code(201).send(row); });

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
