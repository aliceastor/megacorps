import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { memoryDb } from './test-support/memory-db.ts';
import { agents, companies, kanbanCards, taskRuns, workProducts } from './db/schema.ts';
import { requestCardRecovery } from './card-recovery.ts';
import { reviewCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { registerRoutes } from './routes.ts';
const report = {
  kind: 'megacorps-report',
  status: 'completed',
  summary: 'Concrete instructions for missing repository evidence',
  recovery: {
    action: 'rework',
    reason: 'Missing real project pull request',
    instructions: 'Produce a real project PR and exact head evidence',
  },
};
for (const transport of ['native', 'webhook'])
  test(`${transport} recovery action restores work without product approval`, async (t) => {
    const companyId = randomUUID();
    const worker: any = {
      id: randomUUID(),
      companyId,
      slug: 'worker',
      name: 'Worker',
      isActive: true,
      adapterType: 'webhook',
      capabilities: [],
    };
    const head: any = {
      id: randomUUID(),
      companyId,
      slug: 'head',
      name: 'Head',
      isActive: true,
      isBusy: false,
      adapterType: 'webhook',
      capabilities: [],
    };
    worker.bossId = head.id;
    const card: any = {
      id: randomUUID(),
      companyId,
      title: 'Produce real evidence',
      body: 'Original goal',
      columnStatus: 'blocked',
      assigneeId: worker.id,
      reviewerId: null,
      tags: [],
      runRetryState: {},
    };
    const state = memoryDb(t, [
      [companies, [{ id: companyId }]],
      [agents, [worker, head]],
      [kanbanCards, [card]],
    ]);
    await requestCardRecovery(card, { reason: 'Missing evidence', eventKey: 'failure', actorId: worker.id, stage: 'dispatch' });
    const run: any = { id: randomUUID(), cardId: card.id, companyId, agentId: head.id, kind: 'review', status: 'running' };
    state.rows(taskRuns).push(run);
    if (transport === 'native') {
      t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({
        success: true,
        output: JSON.stringify(report),
        sessionId: 'recovery-session',
        tokensUsed: 0,
        costUsd: 0,
        durationSeconds: 1,
      }));
      await reviewCard(card.id, { taskRunId: run.id });
    } else {
      const previous = process.env.WEBHOOK_SHARED_SECRET;
      process.env.WEBHOOK_SHARED_SECRET = 'fixture-recovery-secret';
      t.after(() => {
        if (previous === undefined) delete process.env.WEBHOOK_SHARED_SECRET;
        else process.env.WEBHOOK_SHARED_SECRET = previous;
      });
      const app = Fastify();
      t.after(() => app.close());
      await registerRoutes(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhook/task-complete',
        headers: { 'x-megacorps-webhook-secret': 'fixture-recovery-secret' },
        payload: { cardId: card.id, taskRunId: run.id, status: 'in_review', report },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(card.columnStatus, 'todo');
    assert.equal(card.reviewerId, null);
    assert.equal(card.protocolRepairState.recovery.mode, 'reworking');
    assert.equal(state.rows(workProducts).length, 0);
    assert.equal(state.rows(taskRuns).filter((r) => r.kind === 'dispatch' && r.status === 'queued').length, 1);
    assert.equal(run.status, 'success');
  });

for (const conflicting of [false, true])
  test(`${conflicting ? 'conflicting' : 'invalid'} webhook recovery reply consumes bounded correction and settles original run`, async (t) => {
    const companyId = randomUUID();
    const worker: any = { id: randomUUID(), companyId, bossId: null, isActive: true };
    const head: any = { id: randomUUID(), companyId, slug: 'head', name: 'Head', isActive: true, isBusy: false, adapterType: 'webhook' };
    worker.bossId = head.id;
    const card: any = { id: randomUUID(), companyId, title: 'Repair', columnStatus: 'blocked', assigneeId: worker.id };
    const state = memoryDb(t, [
      [companies, [{ id: companyId }]],
      [agents, [worker, head]],
      [kanbanCards, [card]],
    ]);
    await requestCardRecovery(card, { reason: 'Missing evidence', eventKey: 'failure', actorId: worker.id, stage: 'dispatch' });
    const run: any = { id: randomUUID(), cardId: card.id, companyId, agentId: head.id, kind: 'review', status: 'running' };
    state.rows(taskRuns).push(run);
    const previous = process.env.WEBHOOK_SHARED_SECRET;
    process.env.WEBHOOK_SHARED_SECRET = 'fixture-recovery-secret';
    t.after(() => {
      if (previous === undefined) delete process.env.WEBHOOK_SHARED_SECRET;
      else process.env.WEBHOOK_SHARED_SECRET = previous;
    });
    const app = Fastify();
    t.after(() => app.close());
    await registerRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhook/task-complete',
      headers: { 'x-megacorps-webhook-secret': 'fixture-recovery-secret' },
      payload: {
        cardId: card.id,
        taskRunId: run.id,
        status: 'in_review',
        report: conflicting
          ? report
          : { kind: 'megacorps-report', status: 'completed', summary: 'Approve the artifact', verdict: 'approved' },
        ...(conflicting
          ? {
              output: JSON.stringify({
                ...report,
                summary: 'Contradictory embedded action',
                recovery: { action: 'raise_to_human', reason: 'Stop automatic recovery' },
              }),
            }
          : {}),
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(run.status, 'failed');
    assert.equal(card.protocolRepairState.review.failures, 1);
    assert.equal(card.protocolRepairState.recovery.round, 1);
    assert.equal(state.rows(workProducts).length, 0);
  });
