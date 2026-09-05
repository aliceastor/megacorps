import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, approvals, cardComments, kanbanCards, machineRunners, taskRuns } from './db/schema.ts';
import { completeTaskRun, dispatchInternals, enqueueMessageTaskRun, enqueueTaskRun, reviewCard, reviewMessageDelegation, runMessageDelegation } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { registerRoutes } from './routes.ts';

for (const kind of ['review', 'message', 'message_review']) {
  test(`${kind} failures back off 1/5/15/30 minutes, then block without queuing more work`, async (t) => {
    let now = Date.UTC(2026, 8, 5);
    t.mock.timers.enable({ apis: ['Date'], now });
    const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer', assigneeId: 'worker', deletedAt: null };
    const comment: any = { id: 'comment', cardId: card.id, reviewerAgentId: 'reviewer', assigneeAgentId: 'worker', action: 'delegate_request', delegationStatus: 'queued' };
    const state = memoryDb(t, [[kanbanCards, [card]], [taskRuns, []], [cardComments, [comment]]]);
    const enqueue = () => kind === 'review' ? enqueueTaskRun(card.id, 'review', 'loop') : enqueueMessageTaskRun(comment, kind as 'message' | 'message_review');
    for (let count = 1; count <= 5; count++) {
      const run = await enqueue();
      await completeTaskRun(run.id, { status: 'failed', error: 'hermes timeout', retryableFailure: true } as any);
      const retry = card.runRetryState?.[kind];
      assert.equal(retry?.failures, count);
      if (count < 5) {
        const delay = [1, 5, 15, 30][count - 1]! * 60_000;
        assert.equal(retry.nextRunAt, new Date(now + delay).toISOString());
        assert.notEqual(card.columnStatus, 'blocked');
        now += delay;
        t.mock.timers.setTime(now);
      } else {
        assert.equal(retry.nextRunAt, null);
        assert.equal(card.columnStatus, 'blocked');
        assert.match(card.lastError, /hermes timeout/);
        const priorCount = state.rows(taskRuns).length;
        await assert.rejects(enqueue, /retry_exhausted|card_blocked/);
        assert.equal(state.rows(taskRuns).length, priorCount);
      }
    }
  });
}

test('success resets only its kind, duplicate completion does not count twice, operator run resets the stop', async (t) => {
  const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer', deletedAt: null };
  const state = memoryDb(t, [[kanbanCards, [card]], [taskRuns, []]]);
  for (const [id, kind, status] of [['r1', 'review', 'failed'], ['r2', 'review', 'failed'], ['m1', 'message', 'failed'], ['r3', 'review', 'success']]) {
    state.rows(taskRuns).push({ id, cardId: card.id, kind, status: 'running' });
    await completeTaskRun(id, { status, error: 'timeout', retryableFailure: status === 'failed' } as any);
  }
  assert.equal(card.runRetryState?.review, undefined);
  assert.equal(card.runRetryState?.message?.failures, 1);
  await completeTaskRun('m1', { status: 'failed', error: 'duplicate', retryableFailure: true } as any);
  assert.equal(card.runRetryState.message.failures, 1);
  card.runRetryState.review = { failures: 5, nextRunAt: null };
  await enqueueTaskRun(card.id, 'review', 'manual', 'operator');
  assert.equal(card.runRetryState.review, undefined);
});

test('queue claimant respects delay and blocked cards while another run kind remains eligible', async (t) => {
  const now = Date.UTC(2026, 8, 5);
  t.mock.timers.enable({ apis: ['Date'], now });
  const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer', assigneeId: 'worker', deletedAt: null, runRetryState: { review: { failures: 1, nextRunAt: new Date(now + 60_000).toISOString() } } };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [{ id: 'reviewer', isActive: true, isBusy: false }]], [taskRuns, [{ id: 'queued', cardId: card.id, kind: 'review', status: 'queued' }]]]);
  const claim = (dispatchInternals as any).claimNextTaskRun;
  assert.equal(await claim(), null);
  state.rows(taskRuns).push({ id: 'message', cardId: card.id, kind: 'message', agentId: 'reviewer', messageCommentId: 'comment', status: 'queued' });
  assert.equal((await claim())?.id, 'message');
  t.mock.timers.setTime(now + 60_000);
  assert.equal((await claim())?.id, 'queued');
  state.rows(taskRuns)[0]!.status = 'queued';
  card.columnStatus = 'blocked';
  assert.equal(await claim(), null);
});

for (const kind of ['review', 'message', 'message_review']) {
  test(`machine runner cannot bypass ${kind} delay or exhaustion`, async (t) => {
    const now = Date.UTC(2026, 8, 5);
    t.mock.timers.enable({ apis: ['Date'], now });
    const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', deletedAt: null, runRetryState: { [kind]: { failures: 1, nextRunAt: new Date(now + 60_000).toISOString() } } };
    const state = memoryDb(t, [[kanbanCards, [card]], [machineRunners, [{ id: 'runner', companyId: 'company', name: 'Runner', apiKeyHash: hashRunnerApiKey('test-only-key') }]], [agents, [{ id: 'agent', adapterType: 'webhook' }]], [taskRuns, [{ id: 'queued', companyId: 'company', cardId: card.id, agentId: 'agent', kind, status: 'queued' }]]]);
    const app = Fastify();
    t.after(() => app.close());
    await registerRunnerRoutes(app);
    const claim = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers: { 'x-megacorps-runner-key': 'test-only-key' }, payload: {} });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().taskRun;
    };
    assert.equal(await claim(), null);
    t.mock.timers.setTime(now + 60_000);
    assert.equal((await claim())?.id, 'queued');
    state.rows(taskRuns)[0]!.status = 'queued';
    card.runRetryState[kind] = { failures: 5, nextRunAt: null };
    assert.equal(await claim(), null);
    card.runRetryState = {};
    card.columnStatus = 'blocked';
    assert.equal(await claim(), null);
  });
}

test('real review and message adapter failures record backoff; a pending human gate survives exhaustion', async (t) => {
  const card: any = { id: 'card', companyId: 'company', title: 'snake', body: 'Review game', columnStatus: 'in_review', reviewerId: 'reviewer', assigneeId: 'author', deletedAt: null, tags: [], dependencyCardIds: [] };
  const reviewer = { id: 'reviewer', companyId: 'company', name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, bossId: null, adapterType: 'webhook', capabilities: [], deletedAt: null };
  const comment = { id: 'message', cardId: card.id, assigneeAgentId: reviewer.id, action: 'delegate_request', body: 'Implement snake', delegationStatus: 'queued' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [reviewer]], [cardComments, [comment]], [taskRuns, [{ id: 'review', cardId: card.id, kind: 'review', status: 'running' }, { id: 'message', cardId: card.id, kind: 'message', messageCommentId: comment.id, agentId: reviewer.id, status: 'running' }]]]);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: false, output: 'hermes timeout', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await assert.rejects(reviewCard(card.id, { taskRunId: 'review' }), /hermes timeout/);
  assert.equal(card.runRetryState?.review?.failures, 1);
  await runMessageDelegation(card.id, { taskRunId: 'message' });
  assert.equal(card.runRetryState?.message?.failures, 1);
  state.rows(cardComments).push({ id: 'report', cardId: card.id, parentCommentId: comment.id, reviewerAgentId: reviewer.id, action: 'delegate_report', body: 'Completed snake', delegationStatus: 'submitted' });
  state.rows(taskRuns).push({ id: 'message-review', cardId: card.id, kind: 'message_review', messageCommentId: 'report', agentId: reviewer.id, status: 'running' });
  await reviewMessageDelegation(card.id, { taskRunId: 'message-review' });
  assert.equal(card.runRetryState?.message_review?.failures, 1);
  card.runRetryState.review = { failures: 4, nextRunAt: null };
  state.rows(approvals).push({ cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
  state.rows(taskRuns).push({ id: 'late-failure', cardId: card.id, kind: 'review', status: 'running' });
  await completeTaskRun('late-failure', { status: 'failed', error: 'hermes timeout', retryableFailure: true } as any);
  assert.equal(card.columnStatus, 'in_review');
  assert.equal(state.rows(approvals)[0]?.status, 'pending');
});

for (const kind of ['review', 'message', 'message_review']) {
  test(`successful machine runner ${kind} completion resets its streak`, async (t) => {
    const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', runRetryState: { [kind]: { failures: 2, nextRunAt: null } } };
    memoryDb(t, [[kanbanCards, [card]], [machineRunners, [{ id: 'runner', companyId: 'company', name: 'Runner', apiKeyHash: hashRunnerApiKey('test-only-key') }]], [taskRuns, [{ id: 'run', companyId: 'company', cardId: card.id, kind, status: 'running', lockedBy: 'runner' }]]]);
    const app = Fastify();
    t.after(() => app.close());
    await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/runner/task-runs/run/complete', headers: { 'x-megacorps-runner-key': 'test-only-key' }, payload: { status: 'in_review', summary: 'Valid report' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(card.runRetryState[kind], undefined);
  });
}

for (const includeRunId of [true, false]) {
  test(`successful review webhook resets its streak with ${includeRunId ? 'run ID' : 'heartbeat fallback'}`, async (t) => {
    const priorSecret = process.env.WEBHOOK_SHARED_SECRET;
    process.env.WEBHOOK_SHARED_SECRET = 'test-only-webhook-secret';
    t.after(() => { if (priorSecret === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = priorSecret; });
    const runId = randomUUID();
    const card: any = { id: randomUUID(), companyId: randomUUID(), columnStatus: 'in_review', activeHeartbeatRunId: 'heartbeat', runRetryState: { review: { failures: 2, nextRunAt: null }, message: { failures: 1, nextRunAt: null } } };
    memoryDb(t, [[kanbanCards, [card]], [taskRuns, [{ id: runId, companyId: card.companyId, cardId: card.id, heartbeatRunId: 'heartbeat', kind: 'review', status: 'running' }]]]);
    const app = Fastify();
    t.after(() => app.close());
    await registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'test-only-webhook-secret' }, payload: { cardId: card.id, ...(includeRunId ? { taskRunId: runId } : {}), status: 'in_review', summary: 'Valid report' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(card.runRetryState.review, undefined);
    assert.equal(card.runRetryState.message.failures, 1);
  });
}
