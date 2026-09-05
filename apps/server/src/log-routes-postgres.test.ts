import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL bounded log routes preserve precise cursors, projections and authorization', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real PostgreSQL checks run in CI' : false, timeout: 120_000 }, async t => {
  const { sql } = await isolatedPostgres(t);
  const { signSession } = await import('./auth.ts');
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

  const [globalActivity] = await sql`INSERT INTO activity_log(company_id,action,entity_type,entity_id,details) VALUES(NULL,'admin.synthetic','system','global','{"private":"detail"}'::jsonb) RETURNING id`;
  assert.equal((await call(`/api/activity/${globalActivity!.id}`)).statusCode, 404);
  assert.equal((await call(`/api/admin/activity/${globalActivity!.id}`)).statusCode, 200);
  assert.equal((await call(`/api/admin/activity/${globalActivity!.id}`, otherHeaders)).statusCode, 403);

  const indexes = await sql`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname LIKE '%_created_id_idx'`;
  assert.ok(indexes.length >= 5, 'migration 29 must install compound paging indexes');
});
