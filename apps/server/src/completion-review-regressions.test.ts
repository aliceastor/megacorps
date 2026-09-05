import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { agents, approvals, cardComments, departments, externalWaits, kanbanCards, machineRunners, projects, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { planMergeGate, applyMergeGatePlan, parkForMerge } from './merge-gate.ts';
import { dispatchCard, reviewCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { sweepExternalWaitPolls } from './external-events.ts';
import { registerRoutes } from './routes.ts';
import { db } from './db/client.ts';

function fixture(t: TestContext) {
  const card: any = { id: 'card', companyId: 'company', title: 'Deliver work', assigneeId: 'author', reviewerId: null, columnStatus: 'in_progress', tags: [], dependencyCardIds: [], runRetryState: {}, protocolRepairState: {}, updatedAt: new Date(0) };
  const actor: any = { id: 'author', companyId: 'company', name: 'Author', slug: 'author', isActive: true, isBusy: false, adapterType: 'webhook', capabilities: [] };
  const run: any = { id: 'run', cardId: card.id, companyId: card.companyId, agentId: actor.id, kind: 'dispatch', status: 'running', lockedBy: 'runner' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [actor]], [taskRuns, [run]], [machineRunners, [{ id: 'runner', companyId: card.companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
  const app = Fastify(); t.after(() => app.close());
  const complete = async (payload: any) => { await registerRunnerRoutes(app); return app.inject({ method: 'POST', url: '/api/runner/task-runs/run/complete', headers: { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { status: 'success', ...payload } }); };
  return { card, actor, run, state, complete };
}
const report = (extra: any = {}) => ({ kind: 'megacorps-report', status: 'completed', summary: 'Implemented and verified the requested deliverable.', ...extra });

test('runner legacy rejection cannot become Done', async (t) => {
  const { card, run, complete } = fixture(t); card.columnStatus = 'in_review'; run.kind = 'review';
  const response = await complete({ output: 'REVISION_REQUESTED: Required tests are missing.' });
  assert.equal(response.statusCode, 200, response.body); assert.equal(card.columnStatus, 'todo');
});

for (const request of ['children', 'delegations', 'checkpoint', 'help']) test(`runner recognized ${request} cannot disappear into Done`, async (t) => {
  const { card, complete } = fixture(t); card.forceBrainstorm = true;
  const extra = request === 'children' ? { children: [{ title: 'Subtask', body: 'Implement the parser and verify the acceptance criteria with regression tests.', assigneeSlug: 'worker' }] }
    : request === 'delegations' ? { delegations: [{ to: 'worker', objective: 'Verify the acceptance criteria.' }] }
    : { request: { kind: request, question: 'Which acceptance criteria should be used?' } };
  const response = await complete({ report: report(extra) });
  assert.ok(response.statusCode < 500, response.body); assert.notEqual(card.columnStatus, 'done');
  if (request === 'checkpoint') assert.equal(response.statusCode, 409, 'unauthorized explicit checkpoint must be rejected');
  if (request === 'help') assert.ok(['needs_review', 'in_review', 'blocked'].includes(card.columnStatus));
});

test('report artifactRefs survive runner quality gate', async (t) => {
  const { card, state, complete } = fixture(t); card.reviewerId = 'reviewer'; card.projectId = 'project';
  state.rows(projects).push({ id: 'project', companyId: 'company', repoUrl: 'https://gitea.test/org/repo', completionRequiresMerge: true });
  const response = await complete({ report: report({ artifactRefs: ['https://gitea.test/org/repo/pulls/12'] }) });
  assert.equal(response.statusCode, 200, response.body); assert.equal(card.columnStatus, 'in_review');
  const plan = await planMergeGate(card, { fetchImpl: async () => new Response('{}') });
  assert.ok(plan.disposition !== 'blocked' || plan.reason !== 'no_candidate', JSON.stringify(plan));
  card.executionLog = 'Reviewer has approved the deliverable.';
  const afterReview = await planMergeGate(card, { fetchImpl: async () => new Response('{}') });
  assert.ok(afterReview.disposition !== 'blocked' || afterReview.reason !== 'no_candidate', 'durable evidence survives replacement by later review output');
});

for (const request of ['children', 'delegations', 'checkpoint']) test(`runner executes eligible ${request} orchestration`, async (t) => {
  const { card, actor, state, complete } = fixture(t);
  if (request === 'checkpoint') state.rows(departments).push({ id: 'department', companyId: card.companyId, headAgentId: actor.id });
  else state.rows(agents).push({ ...actor, id: 'worker', slug: 'worker', bossId: actor.id });
  const extra = request === 'children' ? { children: [{ title: 'Parser', body: 'Implement the parser for all supported inputs.\n\nAcceptance:\n- Tests verify valid and invalid records.', assigneeSlug: 'worker' }] }
    : request === 'delegations' ? { delegations: [{ to: 'worker', objective: 'Verify parser acceptance criteria.' }] }
    : { request: { kind: 'checkpoint', question: 'Which parser format is required?' } };
  const response = await complete({ report: report(extra) });
  assert.equal(response.statusCode, 200, response.body); assert.notEqual(card.columnStatus, 'done');
  if (request === 'children') { assert.equal(state.rows(kanbanCards).filter((row) => row.parentCardId === card.id).length, 1); assert.equal(card.rollupStatus, 'waiting_on_children'); }
  if (request === 'delegations') { assert.equal(state.rows(cardComments).filter((row) => row.action === 'delegate_request').length, 1); assert.equal(state.rows(taskRuns).filter((row) => row.kind === 'message').length, 1); }
  if (request === 'checkpoint') { assert.equal(card.columnStatus, 'waiting_on_client'); assert.equal(state.rows(approvals)[0]?.type, 'client_checkpoint'); }
});

for (const change of ['human_gate', 'cancelled']) test(`runner final write preserves a write-time ${change}`, async (t) => {
  const { card, run, state, complete } = fixture(t); card.columnStatus = 'in_review'; run.kind = 'review';
  const update = db.update.bind(db); let before: any;
  t.mock.method(db, 'update', ((table: any) => {
    const writer = update(table);
    return { set(values: any) {
      if (table === kanbanCards && values.columnStatus === 'done') {
        if (change === 'human_gate') state.rows(approvals).push({ id: 'human', cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
        else card.columnStatus = 'cancelled';
        card.updatedAt = new Date(999); card.runRetryState = { review: { failures: 4, nextRunAt: null } }; before = structuredClone(card);
      }
      return writer.set(values);
    } };
  }) as any);
  const response = await complete({ output: 'VERDICT: APPROVED' });
  assert.equal(response.statusCode, 200, response.body); assert.ok(before); assert.deepEqual(card, before);
});

test('runner human approval uses durable humanGate', async (t) => {
  const { card, state, complete } = fixture(t); card.requiresApproval = true;
  const response = await complete({ report: report() });
  assert.equal(response.statusCode, 200, response.body); assert.equal(card.columnStatus, 'in_review');
  assert.equal(state.rows(approvals)[0]?.payload?.humanGate, true);
});

for (const result of ['approved', 'invalid']) test(`protocol-help ${result} preserves dispatch exhaustion and cannot approve work`, async (t) => {
  const { card, actor, run } = fixture(t); actor.id = 'helper'; actor.slug = 'helper'; run.agentId = actor.id; run.kind = 'review'; card.columnStatus = 'needs_review'; card.reviewerId = actor.id;
  card.protocolRepairState = { dispatch: { failures: 3, mode: 'escalated', actorId: 'author', sessionId: null, runKeys: ['r1', 'r2', 'r3'], visitedActorIds: ['author'], fallbackId: actor.id, updatedAt: new Date(0).toISOString() } };
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: result === 'approved' ? 'VERDICT: APPROVED\nReply format issue resolved.' : 'No recognizable verdict.', sessionId: 'session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewCard(card.id, { taskRunId: run.id });
  assert.notEqual(card.columnStatus, 'done'); assert.equal(card.protocolRepairState.dispatch.failures, 3);
  assert.equal(card.protocolRepairState.review, undefined, 'helper cannot receive a new repair budget');
  assert.equal(card.columnStatus, result === 'approved' ? 'todo' : 'blocked');
});

for (const outcome of ['valid', 'malformed']) test(`valid protocol help resumes original actor once: ${outcome} correction`, async (t) => {
  const { card, actor, run, state, complete } = fixture(t);
  card.columnStatus = 'needs_review'; card.reviewerId = 'helper';
  card.protocolRepairState = { dispatch: { failures: 3, mode: 'escalated', actorId: actor.id, originalReviewerId: null, sessionId: null, runKeys: ['r1', 'r2', 'r3'], visitedActorIds: [actor.id], fallbackId: 'helper', updatedAt: new Date(0).toISOString() } };
  state.rows(agents).push({ ...actor, id: 'helper', slug: 'helper' });
  state.rows(taskRuns).push({ id: 'help-run', cardId: card.id, companyId: card.companyId, agentId: 'helper', kind: 'review', status: 'running' });
  run.status = 'failed';
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'VERDICT: APPROVED\nUse the report schema and include the evidence.', sessionId: 'helper-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewCard(card.id, { taskRunId: 'help-run' });
  assert.equal(card.columnStatus, 'todo'); assert.equal(card.protocolRepairState.dispatch.failures, 3);
  const queued = state.rows(taskRuns).filter((row) => row.kind === 'dispatch' && row.status === 'queued');
  assert.equal(queued.length, 1); assert.equal(card.protocolRepairState.dispatch.helpAttempted, true);
  // The queued original task is claimed by the runner; its actor is unchanged.
  const continuation = queued[0]!; continuation.id = run.id; continuation.agentId = actor.id; continuation.status = 'running'; continuation.lockedBy = 'runner';
  state.rows(taskRuns).splice(state.rows(taskRuns).indexOf(run), 1);
  card.columnStatus = 'in_progress'; card.executionLockId = continuation.id;
  const response = await complete({ report: outcome === 'valid' ? report({ workProducts: [{ type: 'report', title: 'Verified deliverable' }] }) : report({ status: 'bogus' }) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(card.columnStatus, outcome === 'valid' ? 'done' : 'blocked');
  assert.equal(state.rows(taskRuns).filter((row) => row.status === 'queued').length, 0);
  assert.equal(state.rows(cardComments).filter((row) => row.action === 'protocol_help_required').length, 0, 'no additional help request');
  if (outcome === 'malformed') assert.equal(card.protocolRepairState.dispatch.failures, 3);
  else assert.equal(state.rows(workProducts).length, 1);
});

test('runner help schedules the existing review orchestration', async (t) => {
  const { card, actor, state, complete } = fixture(t); actor.bossId = 'helper';
  const response = await complete({ report: report({ request: { kind: 'help', question: 'Please clarify the integration requirement.' } }) });
  assert.equal(response.statusCode, 200, response.body); assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.reviewerId, 'helper'); assert.equal(state.rows(taskRuns).filter((row) => row.kind === 'review' && row.status === 'queued').length, 1);
});

test('webhook report artifactRefs survive the human approval gate', async (t) => {
  const { card, state } = fixture(t); card.id = '00000000-0000-4000-8000-000000000001'; card.projectId = 'project'; card.requiresApproval = true;
  state.rows(projects).push({ id: 'project', companyId: 'company', repoUrl: 'https://gitea.test/org/repo', completionRequiresMerge: true });
  const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-webhook';
  t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-webhook' }, payload: { cardId: card.id, status: 'done', report: report({ artifactRefs: ['https://gitea.test/org/repo/pulls/12'] }) } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(card.columnStatus, 'in_review');
  const plan = await planMergeGate(card, { fetchImpl: async () => new Response('{}') });
  assert.ok(plan.disposition !== 'blocked' || plan.reason !== 'no_candidate', JSON.stringify(plan));
});

for (const via of ['runner', 'review', 'dispatch']) for (const change of ['human_gate', 'cancelled', 'new_run']) test(`${via} delayed provider plan preserves ${change} and full card`, async (t) => {
  const { card, actor, run, state, complete } = fixture(t); card.columnStatus = 'in_review'; card.projectId = 'project'; card.reviewerId = actor.id; card.assigneeId = 'owner'; run.kind = 'review';
  if (via === 'dispatch') { card.columnStatus = 'todo'; card.assigneeId = actor.id; card.reviewerId = null; run.kind = 'dispatch'; }
  state.rows(projects).push({ id: 'project', companyId: 'company', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main', completionRequiresMerge: true });
  state.rows(workProducts).push({ id: 'wp', cardId: card.id, projectId: 'project', type: 'pull_request', pullRequestUrl: 'https://gitea.test/org/repo/pulls/12', commitSha: 'a'.repeat(40) });
  const oldUrl = process.env.GITEA_URL, oldToken = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-provider-token';
  t.after(() => { if (oldUrl === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = oldUrl; if (oldToken === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = oldToken; });
  let protectedCard: any;
  t.mock.method(globalThis, 'fetch', async () => {
    if (change === 'human_gate') state.rows(approvals).push({ id: 'human', cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
    if (change === 'cancelled') card.columnStatus = 'cancelled';
    if (change === 'new_run') { card.executionLockId = 'new-run'; card.activeHeartbeatRunId = 'new-heartbeat'; }
    card.updatedAt = new Date(1234); card.runRetryState = { review: { failures: 4, nextRunAt: null } }; card.protocolRepairState = { review: { failures: 2, mode: 'fresh_context', actorId: actor.id, runKeys: [], visitedActorIds: [], fallbackId: null, sessionId: null, updatedAt: '' } };
    protectedCard = structuredClone(card);
    return new Response(JSON.stringify({ number: 12, state: 'open', merged: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } }));
  });
  if (via === 'runner') { const response = await complete({ output: 'VERDICT: APPROVED' }); assert.equal(response.statusCode, 200, response.body); }
  else { t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'VERDICT: APPROVED', sessionId: 'session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 })); if (via === 'dispatch') await dispatchCard(card.id, 'manual', { taskRunId: run.id }); else await reviewCard(card.id, { taskRunId: run.id }); }
  assert.ok(protectedCard, 'provider boundary must execute'); assert.deepEqual(card, protectedCard); assert.equal(state.rows(externalWaits).length, 0);
});

test('delayed missing-evidence application preserves cancellation', async (t) => {
  const { card } = fixture(t); const snapshot = structuredClone(card); card.columnStatus = 'cancelled';
  const before = structuredClone(card);
  await applyMergeGatePlan(snapshot, { disposition: 'blocked', reason: 'no_candidate', detail: 'No evidence found.' });
  assert.deepEqual(card, before);
});

test('authorized park cannot overwrite pending human gate', async (t) => {
  const { card, state } = fixture(t); card.columnStatus = 'in_review';
  state.rows(approvals).push({ id: 'approval', cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
  const before = structuredClone(card);
  await parkForMerge(structuredClone(card), { disposition: 'wait', project: {} as any, candidate: { kind: 'commit', headSha: 'a'.repeat(40) } as any, headSha: 'a'.repeat(40), defaultBranch: 'main', waitingFor: 'merge', externalId: 'head', externalUrl: null });
  assert.deepEqual(card, before); assert.equal(state.rows(externalWaits).length, 0);
});

test('exhausted merge checks cannot starve later waits', async (t) => {
  const { card, state } = fixture(t); card.columnStatus = 'waiting_on_external'; card.projectId = 'project';
  state.rows(projects).push({ id: 'project', companyId: 'company', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main', completionRequiresMerge: true });
  for (let n = 0; n < 31; n++) state.rows(externalWaits).push({ id: `wait-${n}`, cardId: card.id, companyId: card.companyId, provider: 'gitea', status: 'waiting', externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12', authorizedHeadSha: 'a'.repeat(40), pollIntervalSeconds: null, pollCount: n < 30 ? 24 : 0, createdAt: new Date(n), lastPolledAt: new Date(0) });
  await sweepExternalWaitPolls({ log: { info() {}, warn() {} } } as any);
  assert.equal(state.rows(externalWaits)[30]?.pollCount, 1);
});
