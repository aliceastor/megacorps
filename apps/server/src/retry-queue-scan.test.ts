import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { agents, kanbanCards, machineRunners, taskRuns } from './db/schema.ts';
import { dispatchInternals } from './dispatch.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { memoryDb } from './test-support/memory-db.ts';

function retryQueue(count: number, now: number) {
  const cards = Array.from({ length: count + 1 }, (_, index) => ({
    id: `card-${index}`,
    companyId: 'company',
    columnStatus: 'in_review',
    reviewerId: 'reviewer',
    deletedAt: null,
    runRetryState: index < count
      ? { review: { failures: 1, nextRunAt: new Date(now + 60_000).toISOString() } }
      : {},
  }));
  const runs = cards.map((card, index) => ({
    id: index < count ? `delayed-${index}` : 'ready',
    companyId: 'company',
    cardId: card.id,
    agentId: 'reviewer',
    kind: 'review',
    status: 'queued',
    priority: 0,
    createdAt: new Date(now + index),
  }));
  return { cards, runs };
}

test('internal claimant scans past a full delayed retry page', async (t) => {
  const now = Date.UTC(2026, 8, 5);
  t.mock.timers.enable({ apis: ['Date'], now });
  const queue = retryQueue(250, now);
  memoryDb(t, [
    [kanbanCards, queue.cards],
    [agents, [{ id: 'reviewer', companyId: 'company', isActive: true, isBusy: false, adapterType: 'webhook', deletedAt: null }]],
    [taskRuns, queue.runs],
  ]);

  const claimed = await (dispatchInternals as any).claimNextTaskRun();

  assert.equal(claimed?.id, 'ready');
});

test('runner claim API scans past a full delayed retry page', async (t) => {
  const now = Date.UTC(2026, 8, 5);
  t.mock.timers.enable({ apis: ['Date'], now });
  const queue = retryQueue(25, now);
  memoryDb(t, [
    [kanbanCards, queue.cards],
    [agents, [{ id: 'reviewer', companyId: 'company', isActive: true, isBusy: false, adapterType: 'webhook', deletedAt: null }]],
    [machineRunners, [{ id: 'runner', companyId: 'company', name: 'Runner', apiKeyHash: hashRunnerApiKey('test-only-key') }]],
    [taskRuns, queue.runs],
  ]);
  const app = Fastify();
  t.after(() => app.close());
  await registerRunnerRoutes(app);

  const response = await app.inject({
    method: 'POST',
    url: '/api/runner/task-runs/claim',
    headers: { 'x-megacorps-runner-key': 'test-only-key' },
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().taskRun?.id, 'ready');
});
