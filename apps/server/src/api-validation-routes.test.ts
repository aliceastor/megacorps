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
  const foreign = { id: randomUUID(), name: 'Foreign', slug: 'foreign' };
  const foreignCard = { ...card, id: randomUUID(), companyId: foreign.id };
  const deletedCard = { ...card, id: randomUUID(), deletedAt: new Date() };
  const state = memoryDb(t, [[users, [user]], [companies, [company, foreign]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'viewer', status: 'active' }]], [kanbanCards, [card, foreignCard, deletedCard]], [chatSessions, [session]]]);
  const { buildServer } = await import('./index.ts');
  const app = await buildServer(); t.after(() => app.close());
  const headers = { cookie: `session=${await signSession(user)}` };
  for (const suffix of ['actions', 'assignment-history']) {
    for (const authenticated of [false, true]) await t.test(`${suffix}: malformed path ${authenticated ? 'authenticated' : 'anonymous'}`, async () => {
      const response = await app.inject({ url: `/api/cards/not-a-uuid/${suffix}`, ...(authenticated ? { headers } : {}) });
      assert.equal(response.statusCode, authenticated ? 400 : 401, response.body);
      if (authenticated) {
        assert.equal(response.json().error, 'validation_failed');
        assert.deepEqual(response.json().issues[0].path, ['id']);
      }
    });
    for (const [id, status] of [[randomUUID(), 404], [foreignCard.id, 403], [deletedCard.id, 404], [card.id, 200]] as const) await t.test(`${suffix}: card visibility ${status} ${id}`, async () => {
      const response = await app.inject({ url: `/api/cards/${id}/${suffix}`, headers });
      assert.equal(response.statusCode, status, response.body);
      if (status === 200) assert.deepEqual(response.json(), []);
    });
  }
  const routes = ['/api/search?q=synthetic&limit=', '/api/dashboard/timeseries?days=', '/api/approvals?limit=', '/api/notifications?limit=', '/api/chat/sessions?limit=', `/api/chat/sessions/${session.id}/messages?limit=`, '/api/cards?limit=', `/api/cards/${card.id}/actions?limit=`, `/api/cards/${card.id}/assignment-history?limit=`, '/api/cards?offset='];
  for (const route of routes) for (const value of ['NaN', '1.5', 'Infinity']) await t.test(`${route}${value}`, async () => {
    const response = await app.inject({ url: route + value, headers });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'validation_failed');
    assert.ok(response.json().issues.length);
  });
  for (const route of ['/api/chat/sessions?agentId=bad', '/api/chat/sessions?projectId=bad', '/api/chat/sessions/bad/messages', '/api/search?companyId=bad', '/api/approvals?cardId=bad', '/api/cards?assigneeId=bad', '/api/system-logs/bad', '/api/prompt-logs/bad', '/api/activity/bad', '/api/heartbeat-runs/bad', '/api/task-runs/bad', '/api/cron/runs/bad', '/api/prompt-logs?agentId=bad', '/api/heartbeat-runs?cardId=bad', '/api/task-runs?agentId=bad']) await t.test(route, async () => {
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
