import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, approvals, companies, kanbanCards, machineRunners, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';

for (const kind of ['dispatch', 'review']) {
  test(`runner ${kind} permission denial routes recovery without persisting partial evidence`, async (t) => {
    const companyId = randomUUID();
    const actor = { id: randomUUID(), companyId, slug: 'actor', name: 'Actor', isActive: true, adapterType: 'webhook' };
    const card: any = {
      id: randomUUID(),
      companyId,
      title: 'Produce authorized evidence',
      columnStatus: kind === 'dispatch' ? 'in_progress' : 'in_review',
      assigneeId: actor.id,
      reviewerId: kind === 'review' ? actor.id : null,
      runRetryState: {},
    };
    const runnerId = randomUUID();
    const run = { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind, status: 'running', lockedBy: runnerId };
    const state = memoryDb(t, [
      [companies, [{ id: companyId }]],
      [agents, [actor]],
      [kanbanCards, [card]],
      [taskRuns, [run]],
      [machineRunners, [{ id: runnerId, companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('runner-permission-fixture') }]],
    ]);
    const app = Fastify();
    t.after(() => app.close());
    await registerRunnerRoutes(app);
    const payload = {
      status: 'success',
      report: {
        kind: 'megacorps-report',
        status: 'input_required',
        summary: 'Repository write requires permission before any work can be accepted.',
        request: { kind: 'permission', question: 'Authorize the repository write.' },
        workProducts: [{ type: 'pull_request', title: 'Partial work', url: 'https://github.com/example/repo/pull/1' }],
      },
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/runner/task-runs/${run.id}/complete`,
      headers: { 'x-megacorps-runner-key': 'runner-permission-fixture' },
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.rows(workProducts).length, 0, 'Permission-denied results must not become completion evidence');
    assert.equal(run.status, 'failed');
    assert.equal(card.protocolRepairState.recovery.mode, 'awaiting_human');
    assert.equal(card.protocolRepairState.recovery.permissionBlocked, true);
    assert.equal(state.rows(approvals).filter((row) => row.status === 'pending' && row.payload?.humanGate).length, 1);
    assert.deepEqual(card.runRetryState, {});
    assert.notEqual(card.columnStatus, 'done');
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/runner/task-runs/${run.id}/complete`,
      headers: { 'x-megacorps-runner-key': 'runner-permission-fixture' },
      payload,
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(state.rows(workProducts).length, 0);
    assert.equal(state.rows(approvals).length, 1);
  });
}
