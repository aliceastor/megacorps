import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, companyMemberships, users, costEvents, kanbanCards, taskRuns, heartbeatRuns, budgetPolicies } from './db/schema.ts';
import { admitUsage, executeUsage, settleUsage } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';

for (const initialCost of [undefined, '0.4']) test(`ordinary webhook ${initialCost ? 'partial-cost' : 'unknown'} progress preserves exposure while the actual provider operation is held`, async t => {
  const company: any = { id: randomUUID() }, agent: any = { id: randomUUID(), companyId: company.id, isActive: true };
  const other: any = { id: randomUUID(), companyId: company.id, isActive: true };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, columnStatus: 'in_progress' };
  const heartbeat: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id, status: 'running' };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id, heartbeatRunId: heartbeat.id, status: 'running', kind: 'dispatch' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent, other]], [kanbanCards, [card]], [taskRuns, [run]], [heartbeatRuns, [heartbeat]],
    [budgetPolicies, [{ id: randomUUID(), companyId: company.id, monthlyLimitUsd: '1', isActive: true, hardStop: true }]]]);
  const scope = { companyId: company.id, agentId: agent.id, cardId: card.id, taskRunId: run.id, heartbeatRunId: heartbeat.id, attemptKey: `task-run:${run.id}`, source: 'dispatch' };
  const competing = { companyId: company.id, agentId: other.id, attemptKey: randomUUID(), source: 'chat' };
  let release!: () => void, started!: () => void, providerReturned = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const operation = executeUsage(scope, async () => { started(); await held; providerReturned = true; return { success: true, output: 'finished', sessionId: 'synthetic', durationSeconds: 1, tokensUsed: 0, costUsd: 0.4,
    usage: { ...unknownUsage('provider_return'), costStatus: 'actual', costUsd: '0.40000000' } }; });
  t.after(async () => { release(); await operation; }); await entered;
  const prior = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-progress-reservation';
  t.after(() => { if (prior === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = prior; });
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const send = (usage?: unknown) => app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-progress-reservation' },
    payload: { cardId: card.id, taskRunId: run.id, status: 'in_progress', ...(usage ? { usage } : {}) } });
  await assert.rejects(admitUsage(competing), /budget_exceeded_company/);
  const response = await send(initialCost ? { version: 1, costStatus: 'actual', costUsd: initialCost, tokenStatus: 'unknown' } : undefined); assert.equal(response.statusCode, 200, response.body);
  assert.equal(providerReturned, false); assert.equal(run.status, 'running'); assert.equal(heartbeat.status, 'running'); assert.equal(card.columnStatus, 'in_progress');
  await assert.rejects(admitUsage(competing), /budget_exceeded_company/);
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, initialCost ? '0.60000000' : '1.00000000'); assert.equal(state.rows(costEvents)[0]!.settledAt ?? null, null);
  const partial = { version: 1, costStatus: 'actual', costUsd: '0.4', tokenStatus: 'actual', inputTokens: 2 };
  for (let repeat = 0; repeat < 2; repeat++) {
    const progress = await send(partial); assert.equal(progress.statusCode, 200, progress.body);
    assert.equal(state.rows(costEvents)[0]!.costUsd, '0.40000000'); assert.equal(state.rows(costEvents)[0]!.reservationUsd, '0.60000000');
    await assert.rejects(admitUsage(competing), /budget_exceeded_company/);
  }
  release(); await operation;
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.ok(state.rows(costEvents)[0]!.settledAt);
  const late = await send(); assert.equal(late.statusCode, 200, late.body);
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.equal(state.rows(costEvents)[0]!.costUsd, '0.40000000');
  await admitUsage(competing); assert.equal(state.rows(costEvents).length, 2);
});

test('explicit card cancellation releases its reservation without declaring free usage or rejecting late facts', async t => {
  const company: any = { id: randomUUID() }, user: any = { id: randomUUID(), email: 'cancel@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true }, card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, columnStatus: 'in_progress', taskBudgetLimit: '1' };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'operator', status: 'active' }]], [agents, [agent]], [kanbanCards, [card]]]);
  const scope = { companyId: company.id, agentId: agent.id, cardId: card.id, attemptKey: randomUUID(), source: 'dispatch' };
  await admitUsage(scope);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const response = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/cancel`, headers: { cookie: `session=${await signSession(user)}` }, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.equal(state.rows(costEvents)[0]!.costUsd, null);
  await settleUsage(scope, { ...unknownUsage('synthetic_runtime'), costStatus: 'actual', costUsd: '0.25' }, { phase: 'progress' });
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, null);
  assert.equal(card.columnStatus, 'cancelled'); assert.equal(card.costUsd, '0.25000000');
});

test('dashboard month uses scoped ledger actual, estimated and unknown instead of all-time card cost', async t => {
  const company: any = { id: randomUUID(), name: 'Usage company' }, foreign = randomUUID();
  const user: any = { id: randomUUID(), email: 'usage-routes@example.test', role: 'viewer' };
  const now = new Date(), previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1);
  const usage = [
    { id: randomUUID(), companyId: company.id, costUsd: '1.25', costStatus: 'actual', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: '0.5', costStatus: 'estimated', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: null, costStatus: 'unknown', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: '10', costStatus: 'actual', occurredAt: previousMonth },
    { id: randomUUID(), companyId: foreign, costUsd: '99', costStatus: 'actual', occurredAt: now },
  ];
  memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'viewer', status: 'active' }]], [costEvents, usage], [kanbanCards, [{ id: randomUUID(), companyId: company.id, columnStatus: 'done', status: 'done', count: 1, costUsd: 25 }]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  assert.equal(dashboard.json().stats.monthlyCost, 1.75);
  assert.equal(dashboard.json().usage.actualUsd, '1.25000000');
  assert.equal(dashboard.json().usage.estimatedUsd, '0.50000000');
  assert.equal(dashboard.json().usage.unknownAttempts, 1);
  const summary = await app.inject({ method: 'GET', url: `/api/usage-summary?companyId=${company.id}`, headers });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().totalUsd, '1.75000000');
  const denied = await app.inject({ method: 'GET', url: `/api/usage-summary?companyId=${foreign}`, headers });
  assert.equal(denied.statusCode, 403);
});
