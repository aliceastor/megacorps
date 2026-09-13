import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { isolatedPostgres } from './test-support/postgres-db.ts';

const collaboration = {
  kind: 'megacorps-report',
  status: 'input_required',
  summary: 'Product input is required before the owner can finish.',
  request: {
    kind: 'collaboration',
    departmentSlug: 'product',
    question: 'Provide the approved wording for every visible error state.',
    acceptance: ['Every visible error state has approved wording.'],
  },
};

test('runner and webhook collaboration requests use the guarded child creator', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'Dedicated PostgreSQL test URL absent' : false, timeout: 60_000 }, async t => {
  const { sql } = await isolatedPostgres(t);
  const { hashRunnerApiKey } = await import('./runner-auth.ts');
  const { registerRunnerRoutes } = await import('./runner-routes.ts');
  const { registerRoutes } = await import('./routes.ts');
  const [company] = await sql`INSERT INTO companies(name,slug) VALUES('Collaboration channels','collaboration-channels') RETURNING id`;
  const [source] = await sql`INSERT INTO departments(company_id,name,slug) VALUES(${company!.id},'Engineering','engineering') RETURNING id`;
  const [target] = await sql`INSERT INTO departments(company_id,name,slug) VALUES(${company!.id},'Product','product') RETURNING id`;
  const [sourceHeadPosition] = await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id) VALUES(${company!.id},'Engineering Head','engineering-head',true,${source!.id}) RETURNING id`;
  const [targetHeadPosition] = await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id) VALUES(${company!.id},'Product Head','product-head',true,${target!.id}) RETURNING id`;
  const [staffPosition] = await sql`INSERT INTO positions(company_id,name,slug,default_department_id) VALUES(${company!.id},'Engineer','engineer',${source!.id}) RETURNING id`;
  const [bossPosition] = await sql`INSERT INTO positions(company_id,name,slug,is_company_boss) VALUES(${company!.id},'Boss','boss',true) RETURNING id`;
  await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Boss','boss','Boss',${bossPosition!.id},'webhook')`;
  const [sourceHead] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Engineering Head','engineering-head','Head',${sourceHeadPosition!.id},'webhook') RETURNING id`;
  const [targetHead] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Product Head','product-head','Head',${targetHeadPosition!.id},'webhook') RETURNING id`;
  const [owner] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type) VALUES(${company!.id},'Owner','owner','worker',${staffPosition!.id},'webhook') RETURNING id`;
  await sql`UPDATE departments SET head_agent_id=${sourceHead!.id} WHERE id=${source!.id}`;
  await sql`UPDATE departments SET head_agent_id=${targetHead!.id} WHERE id=${target!.id}`;
  const runnerKey = 'collaboration-runner-key';
  const [runner] = await sql`INSERT INTO machine_runners(company_id,name,slug,api_key_hash) VALUES(${company!.id},'Collaboration runner','collaboration-runner',${hashRunnerApiKey(runnerKey)}) RETURNING id`;
  const previousSecret = process.env.WEBHOOK_SHARED_SECRET;
  process.env.WEBHOOK_SHARED_SECRET = 'collaboration-webhook-secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = previousSecret; });

  const createRun = async (kind: 'dispatch' | 'review' | 'message' = 'dispatch', departmentSlug = 'product') => {
    const [card] = await sql`INSERT INTO kanban_cards(company_id,department_id,title,body,assignee_id,reviewer_id,column_status,execution_lock_id,execution_locked_by_agent_id) VALUES(${company!.id},${source!.id},'Owner work','Acceptance: integrate approved Product wording.',${owner!.id},${sourceHead!.id},'in_progress',public.gen_random_uuid(),${owner!.id}) RETURNING *`;
    const agentId = kind === 'review' ? sourceHead!.id : owner!.id;
    const [run] = await sql`INSERT INTO task_runs(company_id,card_id,agent_id,kind,status,locked_by) VALUES(${company!.id},${card!.id},${agentId},${kind},'running',${runner!.id}) RETURNING *`;
    await sql`UPDATE kanban_cards SET execution_lock_id=${run!.id} WHERE id=${card!.id}`;
    return { card, run, report: { ...collaboration, request: { ...collaboration.request, departmentSlug } } };
  };

  await t.test('runner dispatch consumes the request, preserves the owner and settles the source run', async () => {
    const f = await createRun();
    const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run!.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status: 'success', report: f.report } });
    assert.equal(response.statusCode, 200, response.body);
    const [parent] = await sql`SELECT * FROM kanban_cards WHERE id=${f.card!.id}`;
    const children = await sql`SELECT * FROM kanban_cards WHERE parent_card_id=${f.card!.id}`;
    assert.equal(children.length, 1); assert.equal(children[0]!.assignee_id, targetHead!.id);
    assert.equal(parent!.assignee_id, owner!.id); assert.equal(parent!.column_status, 'in_progress'); assert.equal(parent!.rollup_status, 'waiting_on_children'); assert.equal(parent!.execution_lock_id, null);
    assert.equal((await sql`SELECT status FROM task_runs WHERE id=${f.run!.id}`)[0]!.status, 'success');
  });

  await t.test('webhook dispatch consumes the request before ordinary help escalation', async () => {
    const f = await createRun();
    const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'collaboration-webhook-secret' }, payload: { cardId: f.card!.id, taskRunId: f.run!.id, status: 'needs_review', report: f.report } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().newStatus, 'in_progress');
    const [parent] = await sql`SELECT * FROM kanban_cards WHERE id=${f.card!.id}`;
    assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${f.card!.id}`).length, 1);
    assert.equal(parent!.assignee_id, owner!.id); assert.equal(parent!.rollup_status, 'waiting_on_children'); assert.equal(parent!.review_feedback, null); assert.equal(parent!.last_error, null);
    assert.equal((await sql`SELECT status FROM task_runs WHERE id=${f.run!.id}`)[0]!.status, 'success');
  });

  for (const kind of ['review', 'message'] as const) await t.test(`${kind} webhook cannot silently consume an owner collaboration request`, async () => {
    const f = await createRun(kind);
    const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'collaboration-webhook-secret' }, payload: { cardId: f.card!.id, taskRunId: f.run!.id, status: 'done', report: f.report } });
    assert.equal(response.statusCode, 409, response.body); assert.match(response.body, /collaboration_dispatch_required/);
    assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${f.card!.id}`).length, 0);
  });

  for (const channel of ['runner', 'webhook'] as const) for (const status of ['failed', 'blocked', 'cancelled'] as const) await t.test(`${channel} ${status} outer status cannot create collaboration work`, async () => {
    const f = await createRun();
    const app = Fastify(); t.after(() => app.close());
    const response = channel === 'runner'
      ? (await registerRunnerRoutes(app), await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run!.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status, report: f.report } }))
      : (await registerRoutes(app), await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'collaboration-webhook-secret' }, payload: { cardId: f.card!.id, taskRunId: f.run!.id, status, report: f.report } }));
    assert.ok(response.statusCode < 500, response.body);
    assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${f.card!.id}`).length, 0);
  });

  for (const channel of ['runner', 'webhook'] as const) await t.test(`${channel} permission outcome parks normally and cannot create collaboration work`, async () => {
    const f = await createRun();
    const report = { ...f.report, summary: 'Permission denied by the sandbox while inspecting the requested source.' };
    const app = Fastify(); t.after(() => app.close());
    const response = channel === 'runner'
      ? (await registerRunnerRoutes(app), await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run!.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status: 'success', report } }))
      : (await registerRoutes(app), await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'collaboration-webhook-secret' }, payload: { cardId: f.card!.id, taskRunId: f.run!.id, status: 'needs_review', report } }));
    assert.ok(response.statusCode < 500, response.body);
    assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${f.card!.id}`).length, 0);
    const [parent] = await sql`SELECT column_status, last_error FROM kanban_cards WHERE id=${f.card!.id}`;
    assert.notEqual(parent!.column_status, 'in_progress'); assert.match(parent!.last_error, /permission/i);
    assert.equal((await sql`SELECT status FROM task_runs WHERE id=${f.run!.id}`)[0]!.status, 'failed');
  });

  await t.test('same-company non-owner agent token cannot mutate another owner card while rejecting collaboration', async () => {
    const f = await createRun();
    const [intruder] = await sql`INSERT INTO agents(company_id,name,slug,role,position_id,adapter_type,api_token) VALUES(${company!.id},'Intruder','intruder','worker',${staffPosition!.id},'webhook','mcagt_collaboration_intruder') RETURNING id`;
    const beforeCard = (await sql`SELECT * FROM kanban_cards WHERE id=${f.card!.id}`)[0]!;
    const beforeRun = (await sql`SELECT * FROM task_runs WHERE id=${f.run!.id}`)[0]!;
    const beforeComments = await sql`SELECT * FROM card_comments WHERE card_id=${f.card!.id}`;
    const beforeLogs = await sql`SELECT * FROM task_logs WHERE card_id=${f.card!.id}`;
    const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { authorization: 'Bearer mcagt_collaboration_intruder' }, payload: { cardId: f.card!.id, status: 'needs_review', report: f.report } });
    assert.equal(response.statusCode, 409, response.body); assert.match(response.body, /collaboration_authority_changed/);
    assert.equal((await sql`SELECT id FROM kanban_cards WHERE parent_card_id=${f.card!.id}`).length, 0);
    assert.deepEqual((await sql`SELECT * FROM kanban_cards WHERE id=${f.card!.id}`)[0], beforeCard);
    assert.deepEqual((await sql`SELECT * FROM task_runs WHERE id=${f.run!.id}`)[0], beforeRun);
    assert.deepEqual(await sql`SELECT * FROM card_comments WHERE card_id=${f.card!.id}`, beforeComments);
    assert.deepEqual(await sql`SELECT * FROM task_logs WHERE card_id=${f.card!.id}`, beforeLogs);
    assert.notEqual(intruder!.id, owner!.id);
  });

  await t.test('creator rejection returns its precise feedback and requeues dispatch', async () => {
    const f = await createRun('dispatch', 'missing-department');
    const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run!.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status: 'success', report: f.report } });
    assert.equal(response.statusCode, 200, response.body);
    const runs = await sql`SELECT status FROM task_runs WHERE card_id=${f.card!.id} AND kind='dispatch' ORDER BY created_at`;
    assert.equal(runs.at(-1)!.status, 'queued');
    const logs = await sql`SELECT message FROM task_logs WHERE card_id=${f.card!.id}`;
    assert.ok(logs.some(row => /collaboration_target_department_unknown/.test(row.message)));
  });
});
