import bcrypt from 'bcryptjs';
import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAgentSchema, createCardSchema, loginSchema, updateCardSchema, canTransitionCard, type CardStatus } from '@megacorps/shared';
import { signSession, requireAuth } from './auth.ts';
import { db } from './db/client.ts';
import { agents, companies, goals, kanbanCards, projects, users } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';

async function defaultCompanyId(): Promise<string> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
  if (!company) throw new Error('Default company missing. Run migrations.');
  return company.id;
}

function priorityToNumber(priority: string | undefined): number { return priority === 'urgent' ? 3 : priority === 'high' ? 2 : priority === 'low' ? -1 : 0; }

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.post('/api/auth/signup', async (request, reply) => {
    const input = loginSchema.extend({ name: createCardSchema.shape.title }).parse(request.body);
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

  app.get('/api/cards', async (request) => {
    const query = request.query as { status?: string; assigneeId?: string; tag?: string; limit?: string; offset?: string };
    const where = query.status ? eq(kanbanCards.columnStatus, query.status) : undefined;
    return db.select().from(kanbanCards).where(where).orderBy(desc(kanbanCards.updatedAt)).limit(Number(query.limit ?? 100)).offset(Number(query.offset ?? 0));
  });

  app.post('/api/cards', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const input = createCardSchema.parse(request.body);
    const [card] = await db.insert(kanbanCards).values({ companyId: await defaultCompanyId(), title: input.title, body: input.body, priority: priorityToNumber(input.priority), tags: input.tags, assigneeId: input.assigneeId ?? null, createdBy: user.id }).returning();
    return reply.code(201).send(card);
  });

  app.put('/api/cards/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateCardSchema.parse(request.body);
    const [existing] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    if (input.updatedAt && existing.updatedAt && new Date(input.updatedAt).getTime() !== existing.updatedAt.getTime()) return reply.code(409).send({ error: 'card_modified' });
    if (input.columnStatus && !canTransitionCard(existing.columnStatus as CardStatus, input.columnStatus)) return reply.code(400).send({ error: 'invalid_status_transition' });
    const [card] = await db.update(kanbanCards).set({ title: input.title, body: input.body, columnStatus: input.columnStatus, priority: priorityToNumber(input.priority), tags: input.tags, assigneeId: input.assigneeId, updatedAt: new Date() }).where(eq(kanbanCards.id, id)).returning();
    return card;
  });

  app.delete('/api/cards/:id', async (request) => { const id = (request.params as { id: string }).id; await db.delete(kanbanCards).where(eq(kanbanCards.id, id)); return { ok: true }; });

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

  app.post('/api/agents/:id/test-connection', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    try { const adapter = getAdapter(agent.adapterType ?? 'hermes'); return await adapter.dispatch({ hermesProfile: agent.hermesProfile, currentSessionId: agent.currentSessionId, adapterConfig: {} }, { id: 'test', title: 'Connection test', body: 'Return OK.', timeoutSeconds: 30 }); }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'connection_failed' }); }
  });

  app.post('/api/cards/:id/run', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, id)).limit(1);
    if (!card?.assigneeId) return reply.code(400).send({ error: 'card_has_no_assignee' });
    const [agent] = await db.select().from(agents).where(eq(agents.id, card.assigneeId)).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const adapter = getAdapter(agent.adapterType ?? 'hermes');
    const result = await adapter.dispatch({ hermesProfile: agent.hermesProfile, currentSessionId: agent.currentSessionId, adapterConfig: {} }, { id: card.id, title: card.title, body: card.body, timeoutSeconds: 300 });
    await db.update(agents).set({ currentSessionId: result.sessionId, spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${result.costUsd}` }).where(eq(agents.id, agent.id));
    const [updated] = await db.update(kanbanCards).set({ executionLog: result.output, sessionId: result.sessionId, costUsd: result.costUsd.toString(), updatedAt: new Date() }).where(eq(kanbanCards.id, id)).returning();
    return updated;
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
    await db.update(kanbanCards).set({ columnStatus: body.status, executionLog, costUsd: body.costUsd?.toString(), updatedAt: new Date() }).where(eq(kanbanCards.id, body.cardId));
    if (card.assigneeId && body.costUsd) {
      await db.update(agents).set({ spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${body.costUsd}` }).where(eq(agents.id, card.assigneeId));
    }
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
