import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, users, companyMemberships, chatSessions, costEvents, heartbeatRuns, kanbanCards } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerChatRoutes } from './chat.ts';
import { signSession } from './auth.ts';
import { getAdapter } from './adapters/registry.ts';
import { recordCostAndEnforceBudget } from './dispatch.ts';
import { runAgentMaintenance } from './agent-maintenance.ts';
import { registerRoutes } from './routes.ts';
import { summarizeUsage, utcPeriod } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';

for (const success of [true, false]) test(`${success ? 'successful' : 'failed'} actual Direct Chat result retains supplied billable usage`, async t => {
  const company: any = { id: randomUUID(), name: 'Usage fixture', slug: 'usage' };
  const user: any = { id: randomUUID(), email: 'usage@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Worker', slug: 'worker', isActive: true, isBusy: false, adapterType: 'codex-app', adapterConfig: {}, spentThisMonth: '0' };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, title: 'Usage chat', userId: user.id };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'operator', status: 'active' }]], [agents, [agent]], [chatSessions, [session]]]);
  t.mock.method(getAdapter('codex-app'), 'dispatch', async () => ({ success, output: 'synthetic paid response', sessionId: 'session-1', tokensUsed: 7, costUsd: 0.00000019, durationSeconds: 1, usage: { ...unknownUsage('synthetic_runtime_report'), costStatus: 'actual', costUsd: '0.00000019' } }));
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerChatRoutes(app);
  const response = await app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: { cookie: `session=${await signSession(user)}` }, payload: { body: 'Synthetic usage test' } });
  assert.equal(response.statusCode, success ? 200 : 502, response.body);
  assert.equal(state.rows(costEvents).length, 1, 'A returned failure must settle its attempt before error handling');
  assert.equal(agent.spentThisMonth, '0.00000019');
  assert.equal(summarizeUsage(state.rows(costEvents) as any, { period: utcPeriod() }).actualUsd, '0.00000019');
});

test('same original heartbeat accounting callback is idempotent', async t => {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, spentThisMonth: '0', isActive: true };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card]], [heartbeatRuns, [run]]]);
  await recordCostAndEnforceBudget(card, agent, run.id, 1.5, 7, 1);
  await recordCostAndEnforceBudget(card, agent, run.id, 1.5, 7, 1);
  assert.equal(state.rows(costEvents).length, 1, 'Duplicate same-attempt callbacks must not insert a second charge');
});

for (const success of [true, false]) test(`${success ? 'successful' : 'failed'} maintenance retains returned usage`, async t => {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true, isBusy: false, adapterType: 'hermes-ssh', adapterConfig: {}, name: 'Maintenance fixture' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]]]);
  let called = false;
  t.mock.method(getAdapter('hermes-ssh'), 'dispatch', async () => { called = true; return { success, output: 'synthetic paid response', sessionId: 'session', tokensUsed: 4, costUsd: 0.125, durationSeconds: 1, usage: { ...unknownUsage('synthetic_runtime_report'), costStatus: 'actual', costUsd: '0.12500019' } }; });
  const app = Fastify(); t.after(() => app.close());
  await runAgentMaintenance(app, agent);
  assert.ok(called, 'Actual maintenance must reach the adapter');
  assert.equal(state.rows(costEvents).length, 1, 'Failed maintenance usage must settle before failure handling');
  assert.equal(agent.spentThisMonth, '0.12500019');
  assert.equal(summarizeUsage(state.rows(costEvents) as any, { period: utcPeriod() }).actualUsd, '0.12500019');
});

test('executing connection test creates an accounted attempt', async t => {
  const company: any = { id: randomUUID(), name: 'Connection fixture' };
  const user: any = { id: randomUUID(), email: 'usage@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true, adapterType: 'webhook', name: 'Fixture' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [users, [user]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'operator', status: 'active' }]]]);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'OK', sessionId: 'session', tokensUsed: 4, costUsd: 0.125, durationSeconds: 1 }));
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const response = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/test-connection`, headers: { cookie: `session=${await signSession(user)}` } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().success, true);
  assert.equal(state.rows(costEvents).length, 1, 'Executing connection tests must be admitted and accounted');
});
