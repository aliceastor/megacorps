import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, companies, departments, positions, kanbanCards, taskRuns, agentRuntimes } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { dispatchCard, processChildSplits, enqueueTaskRun, dispatchInternals } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';

function fixture(t: TestContext, role: 'boss' | 'head' = 'boss') {
  const companyId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const base = { companyId, adapterType: 'webhook', isActive: true, isBusy: false };
  const boss: any = { ...base, id: randomUUID(), slug: 'alice', name: 'Boss', positionId };
  const head: any = { ...base, id: randomUUID(), slug: 'cto', name: 'Head', departmentId };
  const worker: any = { ...base, id: randomUUID(), slug: 'worker', name: 'Worker', departmentId };
  const actor = role === 'boss' ? boss : head, target = role === 'boss' ? head : worker;
  const card: any = { id: randomUUID(), companyId, title: 'Deliver verified result', body: '## Acceptance\n- Verified result', assigneeId: actor.id, columnStatus: 'todo', tags: [], dependencyCardIds: [], protocolRepairState: {}, runRetryState: {}, splitRound: 0 };
  const run: any = { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Fixture' }]], [positions, [{ id: positionId, companyId, name: 'Boss', isCompanyBoss: true }]], [departments, [{ id: departmentId, companyId, name: 'Engineering', headAgentId: head.id }]], [agents, role === 'boss' ? [boss, head] : [boss, head, worker]], [kanbanCards, [card]], [taskRuns, [run]]]);
  const child = { title: 'Produce department evidence', body: '## Acceptance\n- Durable artifact meets requested requirements', assigneeSlug: target.slug };
  return { state, card, run, actor, target, child };
}
for (const role of ['boss', 'head'] as const) test(`${role} actual admitted dispatch queues an authorized delegate that becomes busy before split returns`, async t => {
  const f = fixture(t, role); let calls = 0;
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    calls++;
    // Admission saw capacity. Another task acquires that member while the model
    // is running; its structural membership and UUID have not changed.
    f.target.isBusy = true;
    return { success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'progress', summary: 'Delegate the scoped work and wait for its evidence.', children: [f.child] }), sessionId: 'synthetic-busy-split', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  const children = f.state.rows(kanbanCards).filter(row => row.parentCardId === f.card.id);
  assert.equal(children.length, 1, 'Temporary capacity must not invalidate a structurally authorized split.');
  const child = children[0]!;
  assert.equal(child.assigneeId, f.target.id, 'Literal canonical slug resolves to the authorized full UUID.');
  assert.equal(child.columnStatus, 'todo'); assert.equal(f.card.rollupStatus, 'waiting_on_children');
  assert.equal(f.target.isBusy, true); assert.equal(calls, 1);
  await enqueueTaskRun(child.id, 'dispatch', 'queue');
  assert.equal(await dispatchInternals.claimNextTaskRun(), null, 'Child waits while the assigned member is busy.');
  f.target.isBusy = false;
  assert.equal((await dispatchInternals.claimNextTaskRun())?.cardId, child.id, 'Normal queue can claim after capacity returns.');
});

for (const invalid of ['uuid_as_slug', 'unknown_slug', 'foreign_company', 'outside_hierarchy', 'paused', 'inactive_runtime', 'reassigned_actor'] as const) test(`busy split preserves ${invalid} rejection`, async t => {
  const f = fixture(t); f.card.columnStatus = 'in_progress'; f.target.isBusy = true;
  if (invalid === 'uuid_as_slug') f.child.assigneeSlug = f.target.id;
  if (invalid === 'unknown_slug') f.child.assigneeSlug = 'invented-head';
  if (invalid === 'foreign_company') f.target.companyId = randomUUID();
  if (invalid === 'outside_hierarchy') f.state.rows(departments)[0]!.headAgentId = randomUUID();
  if (invalid === 'paused') f.target.isActive = false;
  if (invalid === 'inactive_runtime') {
    f.target.runtimeId = randomUUID();
    f.state.rows(agentRuntimes).push({ id: f.target.runtimeId, companyId: f.card.companyId, isActive: false });
  }
  if (invalid === 'reassigned_actor') f.card.assigneeId = randomUUID();
  const result = await processChildSplits(f.card, f.actor, [f.child], f.run.id);
  assert.equal(result.created.length, 0); assert.ok(result.errors.length > 0);
  assert.equal(f.state.rows(kanbanCards).length, 1);
});
