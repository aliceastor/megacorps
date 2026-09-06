import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { users, companies, companyMemberships, kanbanCards, chatSessions, apiEvents } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { signSession } from './auth.ts';

// Actual startup composition, with explicitly disabled background jobs: no provider I/O.
test('authenticated startup rejects malformed read inputs before SQL', async t => {
  const flags = ['DISPATCH_LOOP_ENABLED', 'TASK_RUN_WORKER_ENABLED', 'MAINTENANCE_SWEEP_ENABLED', 'LOG_RETENTION_ENABLED', 'PROVISIONING_SWEEP_ENABLED', 'RATE_LIMIT_ENABLED'];
  const previous = flags.map(key => process.env[key]); flags.forEach(key => { process.env[key] = 'false'; });
  t.after(() => flags.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  const user = { id: randomUUID(), email: 'validation@example.test', role: 'viewer', status: 'active' };
  const company = { id: randomUUID(), name: 'Synthetic', slug: 'synthetic' };
  const card = { id: randomUUID(), companyId: company.id, title: 'Synthetic', columnStatus: 'todo', day: '2026-09-06', completed: 0 };
  const session = { id: randomUUID(), companyId: company.id };
  const state = memoryDb(t, [[users, [user]], [companies, [company]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'viewer', status: 'active' }]], [kanbanCards, [card]], [chatSessions, [session]]]);
  const { buildServer } = await import('./index.ts');
  const app = await buildServer(); t.after(() => app.close());
  const headers = { cookie: `session=${await signSession(user)}` };
  const routes = ['/api/search?q=synthetic&limit=', '/api/dashboard/timeseries?days=', '/api/approvals?limit=', '/api/notifications?limit=', '/api/chat/sessions?limit=', `/api/chat/sessions/${session.id}/messages?limit=`, '/api/cards?limit=', `/api/cards/${card.id}/actions?limit=`, `/api/cards/${card.id}/assignment-history?limit=`, '/api/cards?offset='];
  for (const route of routes) for (const value of ['NaN', '1.5', 'Infinity']) await t.test(`${route}${value}`, async () => {
    const response = await app.inject({ url: route + value, headers });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'validation_failed');
    assert.ok(response.json().issues.length);
  });
  for (const route of ['/api/chat/sessions?agentId=bad', '/api/chat/sessions?projectId=bad', '/api/chat/sessions/bad/messages', '/api/search?companyId=bad', '/api/approvals?cardId=bad', '/api/cards?assigneeId=bad']) await t.test(route, async () => {
    const response = await app.inject({ url: route, headers }); assert.equal(response.statusCode, 400, response.body);
  });
  await t.test('unauthenticated malformed chat detail is 401 before lookup; supported unbound project remains valid', async () => {
    assert.equal((await app.inject({ url: '/api/chat/sessions/bad/messages' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/chat/sessions?projectId=none', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/chat/sessions/${randomUUID()}/messages`, headers })).statusCode, 404);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.rows(apiEvents).some(row => row.statusCode === 400 && row.userId === user.id));
});
