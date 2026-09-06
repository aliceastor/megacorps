import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, costEvents, kanbanCards, adapterSessions, taskRuns, heartbeatRuns, budgetPolicies } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { admitUsage, executeUsage, settleUsage } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';
import { pythonSortedJson, parseA2aPushPayload } from './a2a-client.ts';
import { withUsageAttempt } from './usage-context.ts';
import { createA2aDispatch } from './adapters/a2a.ts';

test('signed A2A working token usage keeps exposure until the held provider operation returns', async t => {
  const company: any = { id: randomUUID() }, agent: any = { id: randomUUID(), companyId: company.id, isActive: true, adapterConfig: { a2aPushSecret: 'synthetic-working-secret' } };
  const other: any = { id: randomUUID(), companyId: company.id, isActive: true }, card: any = { id: randomUUID(), companyId: company.id, columnStatus: 'in_progress' };
  const heartbeat: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id, status: 'running' };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id, status: 'running' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent, other]], [kanbanCards, [card]], [taskRuns, [run]], [heartbeatRuns, [heartbeat]],
    [budgetPolicies, [{ id: randomUUID(), companyId: company.id, monthlyLimitUsd: '1', hardStop: true, isActive: true }]]]);
  const scope = { companyId: company.id, agentId: agent.id, cardId: card.id, taskRunId: run.id, heartbeatRunId: heartbeat.id, attemptKey: randomUUID(), source: 'dispatch' };
  const competing = { companyId: company.id, agentId: other.id, attemptKey: randomUUID(), source: 'chat' };
  let release!: () => void, started!: () => void, providerReturned = false;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const operation = executeUsage(scope, async () => { started(); await held; providerReturned = true; return { success: true, output: 'finished', sessionId: 'synthetic', durationSeconds: 1, tokensUsed: 0, costUsd: 0.25,
    usage: { ...unknownUsage('provider_return'), costStatus: 'actual', costUsd: '0.25000000' } }; });
  t.after(async () => { release(); await operation; }); await entered;
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const payload = { statusUpdate: { taskId: 'held-turn', status: { state: 'TASK_STATE_WORKING' }, metadata: { megacorpsUsage: { version: 1, costStatus: 'unknown', tokenStatus: 'actual', inputTokens: 9 } } } };
  const send = () => app.inject({ method: 'POST', url: `/api/a2a/push?usageAttemptKey=${scope.attemptKey}`, payload,
    headers: { 'x-a2a-signature': createHmac('sha256', 'synthetic-working-secret').update(pythonSortedJson(payload)).digest('hex') } });
  await assert.rejects(admitUsage(competing), /budget_exceeded_company/);
  const response = await send(); assert.equal(response.statusCode, 200, response.body);
  assert.equal(providerReturned, false); assert.equal(run.status, 'running'); assert.equal(heartbeat.status, 'running'); assert.equal(card.columnStatus, 'in_progress');
  await assert.rejects(admitUsage(competing), /budget_exceeded_company/);
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, '1.00000000'); assert.equal(state.rows(costEvents)[0]!.settledAt ?? null, null);
  await send(); assert.equal(state.rows(costEvents)[0]!.reservationUsd, '1.00000000');
  release(); await operation;
  await send(); assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.ok(state.rows(costEvents)[0]!.settledAt);
  assert.equal(state.rows(costEvents)[0]!.costUsd, '0.25000000'); assert.equal(state.rows(costEvents)[0]!.usage.inputTokens, 9);
  await admitUsage(competing); assert.equal(state.rows(costEvents).length, 2);
});

test('A2A callback URL carries logical attempt identity independently of reused context', async () => {
  const urls: string[] = [];
  const dispatch = createA2aDispatch({ fetchImpl: async (_url, init) => {
    urls.push(JSON.parse(String(init?.body)).params.configuration.taskPushNotificationConfig.url);
    return new Response(JSON.stringify({ result: { task: { id: 'turn', contextId: 'same-session', status: { state: 'completed' } } } }));
  } });
  const agent = { id: 'synthetic', hermesProfile: null, currentSessionId: 'same-session', adapterConfig: { a2aBaseUrl: 'http://usage-fixture.internal:9900', a2aPushSecret: 'synthetic-registered-secret' } };
  for (const key of ['operation:first', 'operation:second']) await withUsageAttempt(key, () => dispatch(agent, { id: 'card', title: 'Test', body: 'Synthetic' }));
  assert.equal(new URL(urls[0]!).searchParams.get('usageAttemptKey'), 'operation:first');
  assert.equal(new URL(urls[1]!).searchParams.get('usageAttemptKey'), 'operation:second');
});

for (const terminalState of ['completed', 'failed', 'canceled', 'rejected']) test(`signed A2A ${terminalState} ends exposure even without new usage facts`, async t => {
  const company: any = { id: randomUUID() }, agent: any = { id: randomUUID(), companyId: company.id, isActive: true, budgetMonthly: '1', adapterConfig: { a2aPushSecret: 'synthetic-terminal-secret' } };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]]]);
  const scope = { companyId: company.id, agentId: agent.id, attemptKey: randomUUID(), source: 'chat' };
  await admitUsage(scope);
  const expiry = state.rows(costEvents)[0]!.reservationExpiresAt;
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const send = (taskState: string, usage?: unknown) => {
    const payload = { statusUpdate: { taskId: 'synthetic-turn', status: { state: taskState }, ...(usage ? { metadata: { megacorpsUsage: usage } } : {}) } };
    return app.inject({ method: 'POST', url: `/api/a2a/push?usageAttemptKey=${scope.attemptKey}`, payload,
      headers: { 'x-a2a-signature': createHmac('sha256', 'synthetic-terminal-secret').update(pythonSortedJson(payload)).digest('hex') } });
  };
  for (const progress of ['submitted', 'working', 'input_required', 'auth_required']) {
    const response = await send(progress, { version: 1, costStatus: 'unknown', tokenStatus: 'actual', inputTokens: 2 });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.rows(costEvents)[0]!.reservationUsd, '1.00000000'); assert.deepEqual(state.rows(costEvents)[0]!.reservationExpiresAt, expiry);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await send(terminalState); assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.ok(state.rows(costEvents)[0]!.settledAt);
    assert.equal(state.rows(costEvents)[0]!.costUsd, null); assert.equal(state.rows(costEvents)[0]!.usage.inputTokens, 2);
  }
  await send('working', { version: 1, costStatus: 'actual', costUsd: '0.25', tokenStatus: 'unknown' });
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, null); assert.equal(state.rows(costEvents)[0]!.costUsd, '0.25000000');
});

test('signed late push settles original terminal attempt without borrowing a reused session', async t => {
  const company: any = { id: randomUUID() }, agent: any = { id: randomUUID(), companyId: company.id, adapterType: 'a2a', adapterConfig: { a2aPushSecret: 'synthetic-push-secret' }, isActive: true };
  const card: any = { id: randomUUID(), companyId: company.id, columnStatus: 'in_progress' };
  const later: any = { id: randomUUID(), companyId: company.id, columnStatus: 'todo', nextRunAt: new Date(Date.now() + 100000) };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card, later]], [adapterSessions, [{ id: randomUUID(), adapterType: 'a2a', agentId: agent.id, adapterSessionId: 'reused-context', scopeType: 'card', scopeId: later.id }]]]);
  const scope = { companyId: company.id, agentId: agent.id, cardId: card.id, attemptKey: randomUUID(), source: 'dispatch' };
  await admitUsage(scope); await settleUsage(scope, unknownUsage('a2a_timeout'));
  card.columnStatus = 'cancelled'; agent.isActive = false;
  const payload = { statusUpdate: { taskId: 'original-turn', contextId: 'reused-context', status: { state: 'completed' }, metadata: { megacorpsUsage: { version: 1, costStatus: 'actual', tokenStatus: 'unknown', costUsd: '0.25000019', providerEventId: 'stable-provider-event' } } } };
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const url = `/api/a2a/push?usageAttemptKey=${scope.attemptKey}`;
  const signature = createHmac('sha256', 'synthetic-push-secret').update(pythonSortedJson(payload)).digest('hex');
  const response = await app.inject({ method: 'POST', url, payload, headers: { 'x-a2a-signature': signature } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(state.rows(costEvents)[0]!.costUsd, '0.25000019');
  assert.equal(card.columnStatus, 'cancelled'); assert.ok(later.nextRunAt, 'Accounting must not accelerate a later card sharing the context');
  await app.inject({ method: 'POST', url, payload, headers: { 'x-a2a-signature': signature } });
  assert.equal(state.rows(costEvents).length, 1);
  const denied = await app.inject({ method: 'POST', url, payload }); assert.equal(denied.statusCode, 401);
  assert.equal(parseA2aPushPayload(payload)?.usage?.source, 'a2a_push_metadata_v1');
});

test('unsigned adapter callbacks retain context hints without settling ledger accounting', async t => {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Synthetic', isActive: true, budgetMonthly: '1', currentSessionId: 'unsigned-context', adapterConfig: { a2aBaseUrl: 'http://synthetic.internal:9900' } };
  const card: any = { id: randomUUID(), companyId: company.id, columnStatus: 'todo', nextRunAt: new Date(Date.now() + 100000) };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card]], [adapterSessions, [{ id: randomUUID(), adapterType: 'a2a', agentId: agent.id, adapterSessionId: 'unsigned-context', scopeType: 'card', scopeId: card.id }]]]);
  const scope = { companyId: company.id, agentId: agent.id, cardId: card.id, attemptKey: randomUUID(), source: 'dispatch' };
  await admitUsage(scope);
  let callback = '';
  const dispatch = createA2aDispatch({ fetchImpl: async (_url, init) => {
    callback = JSON.parse(String(init?.body)).params.configuration.taskPushNotificationConfig.url;
    return new Response(JSON.stringify({ result: { task: { id: 'turn', contextId: 'unsigned-context', status: { state: 'completed' } } } }));
  } });
  const result = await withUsageAttempt(scope.attemptKey, () => dispatch(agent, { id: card.id, title: 'Test', body: 'Synthetic' }));
  assert.equal(result.success, true);
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const payload = { statusUpdate: { taskId: 'turn', contextId: 'unsigned-context', status: { state: 'completed' }, metadata: { megacorpsUsage: { version: 1, costStatus: 'actual', costUsd: '0.5', tokenStatus: 'unknown' } } } };
  const url = new URL(callback);
  const response = await app.inject({ method: 'POST', url: url.pathname + url.search, payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().accelerated, true);
  assert.equal(url.searchParams.has('usageAttemptKey'), false);
  assert.equal(card.nextRunAt, null);
  assert.equal(state.rows(costEvents)[0]!.costUsd, null);
  assert.equal(state.rows(costEvents)[0]!.reservationUsd, '1.00000000');
  assert.equal(state.rows(costEvents)[0]!.settledAt ?? null, null);
  const forged = await app.inject({ method: 'POST', url: `/api/a2a/push?usageAttemptKey=${scope.attemptKey}`, payload });
  assert.equal(forged.statusCode, 401);
});
