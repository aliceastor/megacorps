import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, kanbanCards, machineRunners, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { getAdapter } from './adapters/registry.ts';
import { reviewCard } from './dispatch.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';

for (const via of ['reviewCard', 'runner', 'webhook']) for (const status of ['progress', 'completed', 'empty']) test(`${via} protocol ${status} guidance is independent of a product verdict`, async (t) => {
  const companyId = randomUUID(), helperId = randomUUID(), authorId = randomUUID();
  const card: any = { id: randomUUID(), companyId, title: 'Repair original report', columnStatus: 'needs_review', assigneeId: authorId, reviewerId: helperId, tags: [], dependencyCardIds: [], runRetryState: {}, protocolRepairState: { dispatch: { actorId: authorId, originalReviewerId: null, failures: 3, mode: 'escalated', fallbackId: helperId, helpAttempted: true, runKeys: ['one', 'two', 'three'], visitedActorIds: [authorId], sessionId: null, updatedAt: '' } } };
  const helper = { id: helperId, companyId, name: 'Helper', slug: 'helper', adapterType: 'webhook', isActive: true, isBusy: false, capabilities: [] };
  const run = { id: randomUUID(), companyId, cardId: card.id, agentId: helperId, kind: 'review', status: 'running', lockedBy: 'runner' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [helper, { ...helper, id: authorId, slug: 'author' }]], [taskRuns, [run]], [machineRunners, [{ id: 'runner', companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
  const report = { kind: 'megacorps-report', status: status === 'empty' ? 'completed' : status, summary: status === 'empty' ? '' : 'Use status progress and include the parser validation results in the report summary.' };
  const app = Fastify(); t.after(() => app.close());
  if (via === 'reviewCard') {
    let prompt = '';
    t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: { body?: string }) => { prompt = task.body ?? ''; return { success: true, output: JSON.stringify(report), sessionId: 'guidance', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
    await reviewCard(card.id, { taskRunId: run.id });
    assert.match(prompt, /protocol repair guidance/i);
    assert.doesNotMatch(prompt, /never omit the decision|APPROVE\/DONE/);
  } else if (via === 'runner') {
    await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${run.id}/complete`, headers: { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { status: 'success', report } });
    assert.equal(response.statusCode, 200, response.body);
  } else {
    const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-webhook';
    t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
    await registerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-webhook' }, payload: { cardId: card.id, taskRunId: run.id, status: 'done', report } });
    assert.equal(response.statusCode, status === 'empty' ? 409 : 200, response.body);
  }
  assert.equal(card.columnStatus, status === 'empty' ? 'blocked' : 'todo');
  assert.equal(card.assigneeId, authorId);
  assert.equal(card.protocolRepairState.dispatch.failures, 3);
  assert.equal(card.protocolRepairState.review, undefined);
  const queued = state.rows(taskRuns).filter((row) => row.kind === 'dispatch' && row.status === 'queued');
  assert.equal(queued.length, status === 'empty' ? 0 : 1);
  if (queued.length) assert.equal(queued[0]?.agentId, authorId);
  assert.equal(state.rows(workProducts).length, 0);
});
