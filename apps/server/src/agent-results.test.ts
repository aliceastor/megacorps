import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, approvals, cardComments, heartbeatRuns, kanbanCards, taskRuns, workProducts } from './db/schema.ts';
import { dispatchCard, reviewCard, runMessageDelegation } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { db } from './db/client.ts';
import { normalizeAgentResult } from './agent-results.ts';
import { apiHelpCatalog } from './api-help.ts';

function fixture(t: TestContext) {
  const card: any = { id: randomUUID(), companyId: randomUUID(), title: 'Build change', body: 'Implement the requested change.', assigneeId: randomUUID(), reviewerId: null, projectId: null, columnStatus: 'todo', requiresApproval: false, deletedAt: null, tags: [], dependencyCardIds: [], retryCount: 0 };
  const agent = { id: card.assigneeId, companyId: card.companyId, name: 'Builder', slug: 'builder', isActive: true, isBusy: false, bossId: null, adapterType: 'webhook', capabilities: [], deletedAt: null };
  const run = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: agent.id, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [agent]], [taskRuns, [run]]]);
  // These fixtures have no position/department rows; the roster's LEFT JOIN
  // keeps the agent rows intact. Keep this narrow support local to this suite.
  const select = db.select.bind(db);
  t.mock.method(db, 'select', ((...args: any[]) => {
    const query: any = select(...args as []);
    const from = query.from.bind(query);
    query.from = (table: any) => {
      const chain = from(table);
      chain.leftJoin = (joined: any) => { assert.equal(state.rows(joined).length, 0); return chain; };
      return chain;
    };
    return query;
  }) as typeof db.select);
  return { card, agent, run, state };
}

const report = (status: string, extra = {}) => ({ kind: 'megacorps-report', status, summary: 'Current result', ...extra });
const product = { type: 'pull_request', title: 'Change', url: 'https://github.com/example/repo/pull/1' };
const unsafeOutputs = [
  ['failed', JSON.stringify(report('failed')), 'failure'],
  ['permission', 'Cannot complete: clone pending approval', 'blocked'],
  ['invalid', JSON.stringify(report('bogus')), 'repair'],
  ['progress', JSON.stringify(report('progress')), 'progress'],
] as const;

for (const [label, output, outcome] of unsafeOutputs) {
  test(`dispatch entrypoint cannot finish ${label} output from a successful adapter`, async (t) => {
    const { card, run, state } = fixture(t);
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output, sessionId: 'test-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await dispatchCard(card.id, 'manual', { taskRunId: run.id });
    assert.notEqual(card.columnStatus, 'done');
    assert.equal(state.rows(approvals).length, 0);
    if (outcome === 'blocked') { assert.equal(card.columnStatus, 'blocked'); assert.match(card.lastError, /approval|permission/i); }
    if (outcome === 'repair') assert.ok(state.rows(cardComments).some((row) => /report.*invalid|report.*repair/.test(row.body)));
    if (outcome === 'failure') assert.equal(state.rows(taskRuns).find((row) => row.id === run.id)?.status, 'failed');
  });
}

test('dispatch persists report-only work products with trusted identities and preserves artifacts', async (t) => {
  const { card, agent, run, state } = fixture(t);
  let productsAtCompletion = -1;
  const update = db.update.bind(db);
  t.mock.method(db, 'update', ((table: any) => {
    const query = update(table);
    const set = query.set.bind(query);
    query.set = ((values: any) => {
      if (table === kanbanCards && values.columnStatus === 'done') productsAtCompletion = state.rows(workProducts).length;
      return set(values);
    }) as typeof query.set;
    return query;
  }) as typeof db.update);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report('completed', { workProducts: [{ ...product, cardId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), taskRunId: randomUUID() }] })), artifacts: [{ artifactId: 'a1', name: 'Screenshot', uri: 'https://example.com/screenshot.png' }], sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(state.rows(workProducts).length, 2);
  assert.equal(productsAtCompletion, 2, 'evidence must exist before the completion stage changes');
  const stored = state.rows(workProducts).find((row) => row.url === product.url)!;
  assert.ok(stored);
  assert.equal(stored.cardId, card.id);
  assert.equal(stored.companyId, card.companyId);
  assert.equal(stored.agentId, agent.id);
  assert.equal(stored.taskRunId, run.id);
});

async function webhook(t: TestContext) {
  const prior = process.env.WEBHOOK_SHARED_SECRET;
  process.env.WEBHOOK_SHARED_SECRET = 'synthetic-task-one-secret';
  t.after(() => { if (prior === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = prior; });
  const app = Fastify();
  t.after(() => app.close());
  await registerRoutes(app);
  return (payload: any) => app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-task-one-secret' }, payload });
}

for (const [label, output] of unsafeOutputs) {
  test(`webhook entrypoint cannot finish ${label} report in returned content`, async (t) => {
    const { card, run, state } = fixture(t);
    const send = await webhook(t);
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', output });
    assert.ok(response.statusCode < 500, response.body);
    assert.notEqual(card.columnStatus, 'done');
    assert.equal(state.rows(approvals).length, 0);
  });
}

for (const status of ['progress', 'input_required', 'completed']) {
  test(`message webhook preserves ${status} semantics and report work products`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const comment = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, action: 'delegate_request', body: 'Build change', delegationStatus: 'queued' };
    state.rows(cardComments).push(comment);
    run.kind = 'message'; (run as any).messageCommentId = comment.id;
    const send = await webhook(t);
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report(status, { workProducts: [product] }) });
    assert.equal(response.statusCode, 200, response.body);
    if (status !== 'completed') assert.ok(!['approved', 'submitted'].includes(comment.delegationStatus));
    assert.equal(state.rows(workProducts).length, 1);
  });
}

test('review webhook honors a structured current rejection over approval prose', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', summary: 'APPROVED', report: report('completed', { verdict: 'revision_requested' }) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(card.columnStatus, 'todo');
  assert.equal(state.rows(taskRuns).find((row) => row.id === run.id)?.status, 'failed');
});

test('API help teaches the normalized report states, requests and work products', () => {
  const catalog = apiHelpCatalog();
  const endpoint = catalog.endpoints.find((item) => item.path === '/api/webhook/task-complete');
  assert.match(JSON.stringify(endpoint?.body), /checkpointKind/);
  assert.match(JSON.stringify(endpoint?.body), /progress/);
  assert.ok((endpoint?.body as any)?.report?.workProducts);
});

for (const inOutput of [false, true]) for (const duplicate of [false, true]) {
  test(`webhook persists report work products once (${inOutput ? 'output' : 'report'} field, duplicate=${duplicate})`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const send = await webhook(t);
    const data = report('completed', { workProducts: [{ ...product, agentId: randomUUID(), taskRunId: randomUUID() }] });
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', ...(inOutput ? { output: JSON.stringify(data) } : { report: data }), ...(duplicate ? { workProducts: [product] } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.rows(workProducts).length, 1);
    assert.equal(state.rows(workProducts)[0]?.agentId, agent.id);
    assert.equal(state.rows(workProducts)[0]?.taskRunId, run.id);
  });
}

test('webhook returns correction feedback for a present invalid report without product side effects', async (t) => {
  const { card, run, state } = fixture(t);
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report('bogus'), workProducts: [product] });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().message, /report.*invalid|report.*repair/);
  assert.equal(state.rows(workProducts).length, 0);
});

test('webhook cannot overwrite a cancelled run or attach its stale products', async (t) => {
  const { card, run, state } = fixture(t);
  card.columnStatus = 'cancelled'; run.status = 'cancelled';
  const send = await webhook(t);
  await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report('completed', { workProducts: [product] }) });
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(workProducts).length, 0);
});

test('late dispatch output preserves a stage changed outside the run and inserts no products', async (t) => {
  const { card, run, state } = fixture(t);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    card.columnStatus = 'cancelled'; card.executionLockId = null; card.activeHeartbeatRunId = null;
    return { success: true, output: JSON.stringify(report('completed', { workProducts: [product] })), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(workProducts).length, 0);
  assert.equal(state.rows(heartbeatRuns)[0]?.status, 'cancelled');
});

test('normalizer keeps structured status authoritative and maps typed requests without mutating input', () => {
  assert.equal(normalizeAgentResult({ output: 'Permission denied', report: report('completed') }).outcome, 'completed');
  assert.equal(normalizeAgentResult({ report: report('completed', { request: { kind: 'permission', question: 'Allow clone?' } }) }).outcome, 'permission');
  const input = report('input_required', { request: { kind: 'checkpoint', checkpointKind: 'interim', question: 'Keep this direction?', options: ['Keep', 'Revise'] } });
  const original = structuredClone(input);
  assert.equal(normalizeAgentResult({ report: input }).report?.checkpoint?.kind, 'interim');
  assert.deepEqual(input, original);
  assert.equal(normalizeAgentResult({ output: 'Completed', needsInput: { question: 'Which format?' } }).outcome, 'input_required');
});

test('conflicting current structured report verdicts require repair', () => {
  assert.equal(normalizeAgentResult({ output: JSON.stringify(report('completed', { verdict: 'revision_requested' })), report: report('completed', { verdict: 'approved' }) }).outcome, 'invalid');
});

test('a reviewer permission blocker parks the actual review without creating approval', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'Clone pending approval', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewCard(card.id, { taskRunId: run.id });
  assert.equal(card.columnStatus, 'blocked');
  assert.match(card.lastError, /permission|approval/);
  assert.equal(state.rows(approvals).length, 0);
});

test('a late reviewer permission blocker preserves a human gate created during the same review stage', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  const approval = { id: randomUUID(), cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } };
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    state.rows(approvals).push(approval);
    return { success: true, output: 'Clone pending approval', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await reviewCard(card.id, { taskRunId: run.id });
  assert.equal(card.columnStatus, 'in_review');
  assert.deepEqual(state.rows(approvals), [approval]);
});

for (const [label, output] of unsafeOutputs) {
  test(`message delegation cannot submit or approve ${label} output`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const comment = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, action: 'delegate_request', body: 'Build change', delegationStatus: 'queued' };
    state.rows(cardComments).push(comment);
    run.kind = 'message'; (run as any).messageCommentId = comment.id;
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output, sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await runMessageDelegation(card.id, { taskRunId: run.id });
    assert.ok(!['approved', 'submitted'].includes(comment.delegationStatus));
    assert.equal(state.rows(cardComments).filter((row) => row.action === 'delegate_report').length, 0);
  });
}
