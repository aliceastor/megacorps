import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, costEvents, kanbanCards, adapterSessions } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { admitUsage, settleUsage } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';
import { pythonSortedJson, parseA2aPushPayload } from './a2a-client.ts';
import { withUsageAttempt } from './usage-context.ts';
import { createA2aDispatch } from './adapters/a2a.ts';

test('A2A callback URL carries logical attempt identity independently of reused context', async () => {
  const urls: string[] = [];
  const dispatch = createA2aDispatch({ fetchImpl: async (_url, init) => {
    urls.push(JSON.parse(String(init?.body)).params.configuration.taskPushNotificationConfig.url);
    return new Response(JSON.stringify({ result: { task: { id: 'turn', contextId: 'same-session', status: { state: 'completed' } } } }));
  } });
  const agent = { id: 'synthetic', hermesProfile: null, currentSessionId: 'same-session', adapterConfig: { a2aBaseUrl: 'http://usage-fixture.internal:9900' } };
  for (const key of ['operation:first', 'operation:second']) await withUsageAttempt(key, () => dispatch(agent, { id: 'card', title: 'Test', body: 'Synthetic' }));
  assert.equal(new URL(urls[0]!).searchParams.get('usageAttemptKey'), 'operation:first');
  assert.equal(new URL(urls[1]!).searchParams.get('usageAttemptKey'), 'operation:second');
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
