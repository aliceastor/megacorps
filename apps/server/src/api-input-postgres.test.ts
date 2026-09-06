import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL authenticated read contracts include production hooks and useful input errors', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; actual SQL query contracts run in CI' : false, timeout: 120_000 }, async t => {
  const { sql } = await isolatedPostgres(t);
  const flags = ['DISPATCH_LOOP_ENABLED', 'TASK_RUN_WORKER_ENABLED', 'MAINTENANCE_SWEEP_ENABLED', 'LOG_RETENTION_ENABLED', 'PROVISIONING_SWEEP_ENABLED', 'RATE_LIMIT_ENABLED'];
  const previous = flags.map(key => process.env[key]); flags.forEach(key => { process.env[key] = 'false'; });
  t.after(() => flags.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  const { buildServer } = await import('./index.ts'); const { signSession } = await import('./auth.ts');
  const app = await buildServer(); t.after(() => app.close());
  const [user] = await sql`INSERT INTO users(email,name,role,status) VALUES('read-contract@example.test','Reader','viewer','active') RETURNING *`;
  const [company] = await sql`INSERT INTO companies(name,slug) VALUES('Read contracts','read-contracts') RETURNING *`;
  const [foreign] = await sql`INSERT INTO companies(name,slug) VALUES('Foreign','foreign-read') RETURNING *`;
  await sql`INSERT INTO company_memberships(user_id,company_id,role,status) VALUES(${user!.id},${company!.id},'viewer','active')`;
  const [agent] = await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type) VALUES(${company!.id},'Reader','reader','worker','webhook') RETURNING *`;
  const [session] = await sql`INSERT INTO chat_sessions(company_id,agent_id,title) VALUES(${company!.id},${agent!.id},'Synthetic conversation') RETURNING *`;
  const [card] = await sql`INSERT INTO kanban_cards(company_id,title,body,column_status) VALUES(${company!.id},'Synthetic goal','Natural language deliverable','todo') RETURNING *`;
  const headers = { cookie: `session=${await signSession(user as any)}` };
  const call = (url: string) => app.inject({ url, headers });
  for (const url of ['/api/search?q=Synthetic&limit=NaN', '/api/dashboard/timeseries?days=NaN', '/api/chat/sessions?agentId=bad', '/api/chat/sessions/bad/messages', `/api/chat/sessions/${session!.id}/messages?limit=1.5`, '/api/approvals?limit=NaN', '/api/notifications?limit=Infinity', '/api/cards?offset=-1', `/api/cards/${card!.id}/actions?limit=NaN`, `/api/cards/${card!.id}/assignment-history?limit=1.5`, '/api/usage-summary?period=2026-13', '/api/prompt-logs/bad', '/api/system-logs/bad', '/api/task-runs?agentId=bad', '/api/cron/runs/bad']) {
    const response = await call(url); assert.equal(response.statusCode, 400, `${url}: ${response.body}`); assert.equal(response.json().error, 'validation_failed');
  }
  const search = await call('/api/search?q=Synthetic&limit=8'); assert.equal(search.statusCode, 200, search.body); assert.equal(search.json().cards[0].id, card!.id);
  const series = await call('/api/dashboard/timeseries?days=7'); assert.equal(series.statusCode, 200, series.body); assert.equal(series.json().points.length, 7);
  assert.equal((await call('/api/chat/sessions?projectId=none')).json()[0].id, session!.id);
  assert.equal((await call(`/api/chat/sessions/${session!.id}/messages?limit=500`)).statusCode, 200);
  assert.equal((await call(`/api/chat/sessions/${randomUUID()}/messages`)).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/chat/sessions/bad/messages' })).statusCode, 401);
  assert.equal((await call(`/api/usage-summary?companyId=${foreign!.id}`)).statusCode, 403);
  const dashboard = await call('/api/dashboard'); assert.equal(dashboard.statusCode, 200, dashboard.body); assert.equal(dashboard.json().stages.todo, 1);
  assert.equal(dashboard.json().usage.totalUsd, '0.00000000');
  // Wait for the bounded onResponse writer, then read its stored metadata.
  let logged: any[] = [];
  for (let i = 0; i < 100; i++) {
    logged = await sql`SELECT id,status_code,request_body FROM api_events WHERE user_id=${user!.id} AND path='/api/dashboard'`;
    if (logged.length) break; await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(logged[0]?.status_code, 200); assert.equal(logged[0]?.request_body, null);
  const summary = await call('/api/system-logs?view=summary&limit=1'); assert.equal(summary.statusCode, 200, summary.body); assert.equal(summary.json().items[0].requestBody, undefined);
  const detail = await call(`/api/system-logs/${logged[0].id}`); assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().responseBody.stats.tasks, 1);
});
