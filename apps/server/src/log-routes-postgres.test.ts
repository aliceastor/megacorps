import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL bounded log routes preserve precise cursors, projections and authorization', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real PostgreSQL checks run in CI' : false, timeout: 120_000 }, async t => {
  const { sql } = await isolatedPostgres(t);
  const { signSession } = await import('./auth.ts');
  const { encodeLogCursor } = await import('./log-query.ts');
  const { registerRoutes } = await import('./routes.ts');
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const [user] = await sql`INSERT INTO users(email,name,password_hash,role,status) VALUES('logs-owner@example.test','Owner','synthetic','admin','active') RETURNING *`;
  const [otherUser] = await sql`INSERT INTO users(email,name,password_hash,role,status) VALUES('logs-other@example.test','Other','viewer','viewer','active') RETURNING *`;
  const [company] = await sql`INSERT INTO companies(name,slug) VALUES('Logs owner','logs-owner') RETURNING *`;
  const [otherCompany] = await sql`INSERT INTO companies(name,slug) VALUES('Logs other','logs-other') RETURNING *`;
  await sql`INSERT INTO company_memberships(user_id,company_id,role,status) VALUES(${user!.id},${company!.id},'admin','active'),(${otherUser!.id},${otherCompany!.id},'viewer','active')`;
  const headers = { cookie: `session=${await signSession({ id: user!.id, email: user!.email, role: user!.role })}` };
  const otherHeaders = { cookie: `session=${await signSession({ id: otherUser!.id, email: otherUser!.email, role: otherUser!.role })}` };
  const call = (url: string, ownHeaders = headers) => app.inject({ url, headers: ownHeaders });

  const ordered = [
    ['ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-09-06 01:02:03.123999+00', 'newest'],
    ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-09-06 01:02:03.123500+00', 'tie high'],
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-06 01:02:03.123500+00', 'tie low'],
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-06 01:02:03.123001+00', 'needle older'],
  ] as const;
  for (const [id, createdAt, title] of ordered) await sql`INSERT INTO prompt_logs(id,company_id,source,adapter_type,title,prompt,prompt_hash,metadata,created_at) VALUES(${id},${company!.id},'dispatch','codex-app',${title},${`full body ${title}`},'hash','{"contextMode":"full_bootstrap"}'::jsonb,${createdAt}::timestamptz)`;
  const [foreign] = await sql`INSERT INTO prompt_logs(company_id,source,adapter_type,title,prompt,prompt_hash) VALUES(${otherCompany!.id},'chat','codex-app','foreign','secret foreign body','hash') RETURNING id`;

  const first = await call('/api/prompt-logs?view=summary&limit=2');
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().items.map((row: any) => row.id), ordered.slice(0, 2).map(row => row[0]));
  assert.ok(first.json().nextCursor);
  assert.ok(first.json().items.every((row: any) => row.prompt === undefined && row.metadata === undefined && row.contextMode === 'full_bootstrap'));
  const second = await call(`/api/prompt-logs?view=summary&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`);
  assert.deepEqual(second.json().items.map((row: any) => row.id), ordered.slice(2).map(row => row[0]));
  assert.equal(second.json().nextCursor, null);
  const searched = await call('/api/prompt-logs?view=summary&limit=1&q=needle');
  assert.deepEqual(searched.json().items.map((row: any) => row.title), ['needle older']);

  const detail = await call(`/api/prompt-logs/${ordered[0][0]}`);
  assert.equal(detail.statusCode, 200); assert.match(detail.json().prompt, /full body/);
  assert.equal((await call(`/api/prompt-logs/${foreign!.id}`)).statusCode, 404);
  assert.equal((await call(`/api/prompt-logs/${ordered[0][0]}`, otherHeaders)).statusCode, 404);

  const impossibleCursor = encodeLogCursor('2026-02-30 24:00:00.000001+00', ordered[0][0]);
  const impossibleResponse = await call(`/api/prompt-logs?view=summary&cursor=${encodeURIComponent(impossibleCursor)}`);
  assert.equal(impossibleResponse.statusCode, 400, impossibleResponse.body);
  assert.equal(impossibleResponse.json().error, 'invalid_cursor');

  const [foreignCursorRow] = await sql`SELECT created_at::text AS cursor_created_at FROM prompt_logs WHERE id=${foreign!.id}`;
  assert.ok(foreignCursorRow);
  const foreignCreatedAt = foreignCursorRow.cursor_created_at;
  const foreignCursor = encodeLogCursor(String(foreignCreatedAt), foreign!.id);
  const foreignCursorPage = await call(`/api/prompt-logs?view=summary&limit=100&cursor=${encodeURIComponent(foreignCursor)}`);
  assert.equal(foreignCursorPage.statusCode, 200, foreignCursorPage.body);
  assert.ok(foreignCursorPage.json().items.every((row: any) => row.companyId === company!.id));
  assert.ok(foreignCursorPage.json().items.every((row: any) => row.id !== foreign!.id));

  const [ownerApi] = await sql`INSERT INTO api_events(user_id,method,path,status_code,request_body,response_body,error,duration_ms) VALUES(${user!.id},'POST','/api/cards',201,'{"ownerRequest":true}'::jsonb,'{"ownerResponse":true}'::jsonb,NULL,12) RETURNING id`;
  const [otherApi] = await sql`INSERT INTO api_events(user_id,method,path,status_code,request_body,response_body,error,duration_ms) VALUES(${otherUser!.id},'GET','/api/private',403,'{"otherRequest":true}'::jsonb,'{"otherResponse":true}'::jsonb,'forbidden',4) RETURNING id`;
  const apiSummary = await call('/api/system-logs?view=summary&limit=100');
  assert.equal(apiSummary.statusCode, 200, apiSummary.body);
  assert.ok(apiSummary.json().items.some((row: any) => row.id === ownerApi!.id));
  assert.ok(apiSummary.json().items.every((row: any) => row.id !== otherApi!.id && row.requestBody === undefined && row.responseBody === undefined));
  const ownerApiDetail = await call(`/api/system-logs/${ownerApi!.id}`);
  assert.deepEqual(ownerApiDetail.json().requestBody, { ownerRequest: true });
  assert.equal((await call(`/api/system-logs/${otherApi!.id}`)).statusCode, 404);
  assert.equal((await call(`/api/system-logs/${ownerApi!.id}`, otherHeaders)).statusCode, 404);
  const otherApiSummary = await call('/api/system-logs?view=summary&limit=100', otherHeaders);
  assert.deepEqual(otherApiSummary.json().items.map((row: any) => row.id), [otherApi!.id]);

  const [card] = await sql`INSERT INTO kanban_cards(company_id,title,body,column_status,created_by) VALUES(${company!.id},'Diagnostic task','Task body','done',${user!.id}) RETURNING id`;
  const adapterSessionId = '11111111-1111-4111-8111-111111111111';
  const [task] = await sql`INSERT INTO task_runs(company_id,card_id,kind,source,status,attempt_number,max_attempts,adapter_session_id,adapter_turn_id,started_at,completed_at,duration_seconds,error,output,cost_usd) VALUES(${company!.id},${card!.id},'dispatch','manual','failed',2,3,${adapterSessionId},'turn-17','2026-09-06 02:00:00+00','2026-09-06 02:00:09+00',9,'synthetic failure','full diagnostic output',0.1234) RETURNING id`;
  const taskSummary = await call('/api/task-runs?view=summary&limit=100');
  const taskRow = taskSummary.json().items.find((row: any) => row.id === task!.id);
  assert.equal(taskRow.output, undefined);
  assert.equal(taskRow.preview, 'full diagnostic output');
  assert.equal(taskRow.error, 'synthetic failure');
  assert.equal(taskRow.adapterSessionId, adapterSessionId);
  assert.equal(taskRow.durationSeconds, 9);
  assert.equal(taskRow.costUsd, '0.1234');
  const taskDetail = await call(`/api/task-runs/${task!.id}`);
  assert.equal(taskDetail.statusCode, 200, taskDetail.body);
  assert.equal(taskDetail.json().output, 'full diagnostic output');
  assert.equal(taskDetail.json().error, 'synthetic failure');
  assert.equal(taskDetail.json().adapterTurnId, 'turn-17');

  const [globalActivity] = await sql`INSERT INTO activity_log(company_id,action,entity_type,entity_id,details) VALUES(NULL,'admin.synthetic','system','global','{"private":"detail"}'::jsonb) RETURNING id`;
  assert.equal((await call(`/api/activity/${globalActivity!.id}`)).statusCode, 404);
  assert.equal((await call(`/api/admin/activity/${globalActivity!.id}`)).statusCode, 200);
  assert.equal((await call(`/api/admin/activity/${globalActivity!.id}`, otherHeaders)).statusCode, 403);

  const indexes = await sql`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname LIKE '%_created_id_idx'`;
  assert.ok(indexes.length >= 5, 'migration 29 must install compound paging indexes');
});
