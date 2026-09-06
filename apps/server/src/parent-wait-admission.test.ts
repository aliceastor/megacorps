import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, kanbanCards, taskRuns, machineRunners, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { cascadeParentStatus, dispatchCard, dispatchInternals } from './dispatch.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { getAdapter } from './adapters/registry.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';

function fixture(t: Parameters<typeof memoryDb>[0]) {
  const companyId = randomUUID(), state = memoryDb(t, []);
  const { bossId, headId } = readyCompany(state, companyId);
  const parent: any = { id: randomUUID(), companyId, projectId: null, title: 'Deliver requested work', body: 'Acceptance: verified report', assigneeId: bossId, columnStatus: 'in_progress', rollupStatus: 'waiting_on_children', protocolRepairState: {}, runRetryState: {} };
  const child: any = { id: randomUUID(), companyId, projectId: null, parentCardId: parent.id, assigneeId: headId, title: 'Department report', columnStatus: 'todo', childRequirementLevel: 'required' };
  const run: any = { id: randomUUID(), companyId, cardId: parent.id, agentId: bossId, kind: 'dispatch', status: 'queued' };
  state.rows(kanbanCards).push(parent, child); state.rows(taskRuns).push(run);
  state.rows(machineRunners).push({ id: 'runner', companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-wait-key') });
  return { state, parent, child, run, bossId };
}
const progress = () => ({ success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'progress', summary: 'The required department child is pending; waiting for its verified report.' }), sessionId: 'repair', tokensUsed: 0, costUsd: 0, durationSeconds: 1 });

test('a valid protocol correction acknowledging pending children stops parent polling', async t => {
  const { state, parent, run, bossId } = fixture(t); run.status = 'running';
  parent.protocolRepairState.dispatch = { actorId: bossId, failures: 2, mode: 'fresh_context', runKeys: [], visitedActorIds: [], sessionId: null };
  let calls = 0; t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; return progress(); });
  await dispatchCard(parent.id, 'loop', { taskRunId: run.id });
  assert.equal(calls, 1); assert.equal(parent.protocolRepairState.dispatch.mode, 'clear');
  assert.equal(parent.rollupStatus, 'waiting_on_children');
  assert.equal(state.rows(taskRuns).filter(row => row.cardId === parent.id && row.status === 'queued').length, 0);
});

test('stale parent queue waits for accepted children and then resumes through cascade', async t => {
  const { state, parent, child, run } = fixture(t);
  assert.equal(await dispatchInternals.claimNextTaskRun(), null);
  child.columnStatus = 'done';
  assert.equal(await dispatchInternals.claimNextTaskRun(), null, 'Mutable Done without accepted evidence is not readiness');
  state.rows(workProducts).push({ id: randomUUID(), companyId: parent.companyId, projectId: null, cardId: child.id, agentId: child.assigneeId, type: 'report', summary: 'Verified report content and acceptance' });
  child.deliveryAcceptance = await captureDeliveryAcceptance(child); assert.ok(child.deliveryAcceptance);
  await cascadeParentStatus(parent.id);
  assert.equal(parent.rollupStatus, 'integrating');
  assert.equal((await dispatchInternals.claimNextTaskRun())?.id, run.id);
});

test('parent dispatch preflight does not call provider for stale waiting work', async t => {
  const { parent } = fixture(t); let calls = 0;
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; return progress(); });
  await assert.rejects(dispatchCard(parent.id), /parent_waiting_on_children/);
  assert.equal(calls, 0);
});

test('runner skips a waiting parent but still admits its bounded protocol repair', async t => {
  const { parent, run, bossId } = fixture(t);
  const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
  const claim = () => app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers: { 'x-megacorps-runner-key': 'synthetic-wait-key' }, payload: {} });
  const waiting = await claim(); assert.equal(waiting.statusCode, 200, waiting.body); assert.equal(waiting.json().taskRun, null);
  parent.protocolRepairState.dispatch = { actorId: bossId, failures: 1, mode: 'same_session', runKeys: [], visitedActorIds: [], sessionId: null };
  const repair = await claim(); assert.equal(repair.statusCode, 200, repair.body); assert.equal(repair.json().taskRun?.id, run.id);
});
