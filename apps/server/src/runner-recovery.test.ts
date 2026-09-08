import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, kanbanCards, machineRunners, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { requestCardRecovery } from './card-recovery.ts';

for (const scenario of ['rework', 'malformed', 'conflicting', 'outside_context']) {
  test(`runner recovery ${scenario} preserves recovery authority and evidence`, async (t) => {
    const companyId = randomUUID();
    const manager = {
      id: randomUUID(),
      companyId,
      slug: 'manager',
      name: 'Manager',
      isActive: true,
      isBusy: false,
      adapterType: 'webhook',
    };
    const worker = { ...manager, id: randomUUID(), slug: 'worker', bossId: manager.id };
    const card: any = {
      id: randomUUID(),
      companyId,
      title: 'Recover evidence',
      body: 'Original goal',
      columnStatus: 'blocked',
      assigneeId: worker.id,
      reviewerId: null,
      runRetryState: {},
    };
    const runnerId = randomUUID();
    const state = memoryDb(t, [
      [companies, [{ id: companyId }]],
      [agents, [manager, worker]],
      [kanbanCards, [card]],
      [machineRunners, [{ id: runnerId, companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('recovery-runner-fixture') }]],
    ]);
    if (scenario !== 'outside_context')
      await requestCardRecovery(card, { reason: 'Missing real evidence', eventKey: 'failure', actorId: worker.id, stage: 'dispatch' });
    else card.columnStatus = 'in_progress';
    const run = {
      id: randomUUID(),
      companyId,
      cardId: card.id,
      agentId: scenario === 'outside_context' ? worker.id : manager.id,
      kind: scenario === 'outside_context' ? 'dispatch' : 'review',
      status: 'running',
      lockedBy: runnerId,
    };
    state.rows(taskRuns).push(run);
    const report = {
      kind: 'megacorps-report',
      status: 'completed',
      summary: 'Concrete recovery instructions',
      recovery: { action: 'rework', reason: 'Missing evidence', instructions: 'Produce the exact project PR and head evidence' },
    };
    const payload = {
      status: 'success',
      report:
        scenario === 'malformed'
          ? { kind: 'megacorps-report', status: 'completed', summary: 'Approved without recovery', verdict: 'approved' }
          : report,
      ...(scenario === 'conflicting'
        ? { output: JSON.stringify({ ...report, recovery: { action: 'raise_to_human', reason: 'Conflicting decision' } }) }
        : {}),
    };
    const app = Fastify();
    t.after(() => app.close());
    await registerRunnerRoutes(app);
    const call = () =>
      app.inject({
        method: 'POST',
        url: `/api/runner/task-runs/${run.id}/complete`,
        headers: { 'x-megacorps-runner-key': 'recovery-runner-fixture' },
        payload,
      });
    const response = await call();
    assert.equal(response.statusCode, scenario === 'rework' ? 200 : 409, response.body);
    assert.equal(state.rows(workProducts).length, 0);
    if (scenario === 'rework') {
      assert.equal(card.columnStatus, 'todo');
      assert.equal(run.status, 'success');
      assert.equal(card.protocolRepairState.recovery.round, 1);
      assert.equal(state.rows(taskRuns).filter((r) => r.kind === 'dispatch' && r.status === 'queued').length, 1);
    } else if (scenario === 'outside_context') {
      assert.equal(card.columnStatus, 'in_progress');
      assert.equal(card.protocolRepairState, undefined);
      assert.equal(run.status, 'running');
      return;
    } else {
      assert.equal(card.columnStatus, 'needs_review');
      assert.equal(run.status, 'failed');
      assert.equal(card.protocolRepairState.review.failures, 1);
    }
    const runCount = state.rows(taskRuns).length;
    const duplicate = await call();
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(state.rows(taskRuns).length, runCount);
    assert.equal(card.protocolRepairState.recovery.round, 1);
  });
}
