import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, departments, positions, kanbanCards, taskRuns, machineRunners, heartbeatRuns, costEvents, approvals } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { dispatchCard, dispatchInternals } from './dispatch.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { getAdapter } from './adapters/registry.ts';

function fixture(t: Parameters<typeof memoryDb>[0], role: 'boss' | 'head') {
  const companyId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const boss: any = { id: randomUUID(), companyId, name: 'Boss', slug: 'boss', positionId, isActive: true, isBusy: false, adapterType: 'webhook' };
  const head: any = { id: randomUUID(), companyId, departmentId, name: 'Head', slug: 'head', isActive: true, isBusy: role === 'boss', adapterType: 'webhook' };
  const staff: any = { id: randomUUID(), companyId, departmentId, name: 'Worker', slug: 'worker', isActive: true, isBusy: true, adapterType: 'webhook' };
  const actor = role === 'boss' ? boss : head, target = role === 'boss' ? head : staff;
  const card: any = { id: randomUUID(), companyId, assigneeId: actor.id, title: 'Write the requested documentation', body: 'Deliver documentation with verified acceptance.', columnStatus: 'todo', tags: [], retryCount: 0, protocolRepairState: {}, runRetryState: {} };
  const run: any = { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind: 'dispatch', status: 'queued', attemptNumber: 1 };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Capacity fixture' }]], [positions, [{ id: positionId, companyId, isCompanyBoss: true }]], [departments, [{ id: departmentId, companyId, name: 'Engineering', headAgentId: head.id }]], [agents, role === 'boss' ? [boss, head] : [boss, head, staff]], [kanbanCards, [card]], [taskRuns, [run]], [machineRunners, [{ id: 'runner', companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-capacity-key') }]]]);
  return { state, card, run, actor, target };
}

for (const role of ['boss', 'head'] as const) {
  test(`${role} internal queue preserves one queued run while required delegate is busy`, async t => {
    const { state, card, run, target } = fixture(t, role);
    for (let tick = 0; tick < 3; tick++) assert.equal(await dispatchInternals.claimNextTaskRun(), null);
    assert.equal(run.status, 'queued'); assert.equal(run.attemptNumber, 1); assert.equal(card.retryCount, 0);
    assert.equal(state.rows(heartbeatRuns).length, 0); assert.equal(state.rows(costEvents).length, 0); assert.equal(state.rows(approvals).length, 0);
    target.isBusy = false;
    assert.equal((await dispatchInternals.claimNextTaskRun())?.id, run.id);
  });
  test(`${role} runner claim waits for required delegate capacity before usage admission`, async t => {
    const { state, run, target } = fixture(t, role);
    const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
    const claim = () => app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers: { 'x-megacorps-runner-key': 'synthetic-capacity-key' }, payload: {} });
    const waiting = await claim(); assert.equal(waiting.statusCode, 200, waiting.body); assert.equal(waiting.json().taskRun, null);
    assert.equal(run.status, 'queued'); assert.equal(state.rows(costEvents).length, 0);
    target.isBusy = false;
    const ready = await claim(); assert.equal(ready.statusCode, 200, ready.body); assert.equal(ready.json().taskRun?.id, run.id);
  });
  test(`${role} actual dispatch makes no provider attempt until required delegate capacity returns`, async t => {
    const { state, card, target } = fixture(t, role); let calls = 0;
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; return { success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'progress', summary: 'Planning the assigned department deliverable.' }), sessionId: 'capacity', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
    await assert.rejects(dispatchCard(card.id), /delegation_capacity_unavailable/);
    assert.equal(calls, 0); assert.equal(card.columnStatus, 'todo'); assert.equal(state.rows(heartbeatRuns).length, 0); assert.equal(state.rows(costEvents).length, 0); assert.equal(state.rows(approvals).length, 0);
    target.isBusy = false;
    await dispatchCard(card.id); assert.equal(calls, 1);
  });
}

test('actual strategy prompt retains busy structural heads during a capacity race', async t => {
  const { state, card, target, actor } = fixture(t, 'boss'); target.isBusy = false;
  const { db } = await import('./db/client.ts'); const original = db.update.bind(db);
  t.mock.method(db, 'update', ((table: any) => ({ set(values: any) { if (table === agents && values.isBusy === true) target.isBusy = true; return original(table).set(values); } })) as any);
  let prompt = '';
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: { body?: string }) => { prompt = task.body ?? ''; return { success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'progress', summary: 'Waiting for existing Engineering head capacity.' }), sessionId: 'race', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  await dispatchCard(card.id);
  assert.match(prompt, /head: Head.*busy/i); assert.match(prompt, /temporary capacity/i);
  assert.match(prompt, /Never execute the implementation yourself/); assert.equal(actor.isBusy, false);
  assert.equal(state.rows(approvals).length, 0);
});
