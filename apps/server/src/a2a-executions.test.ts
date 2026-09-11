import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './test-support/memory-db.ts';
import { agents, a2aExecutions, a2aExecutionAliases, costEvents } from './db/schema.ts';
import { createA2aExecutionStore, acknowledgeA2aExecution } from './a2a-executions.ts';
import type { A2aInvocationRecord } from './a2a-polling.ts';
import { db } from './db/client.ts';

const operationEntries = () => [1, 2, 3].map(id => ({ attemptKey: `operation:${id}`, agentId: 'agent', companyId: 'company', source: 'test_connection', admittedAt: new Date(), settledAt: null, runtimeId: null }));

const seed = (key = 'operation:1'): Omit<A2aInvocationRecord, 'revision'> => ({ key, scope: 'agent:card:execution', route: 'route-hash', contextId: 'context-1', baselineTaskIds: null, phase: 'preparing', taskId: null, deadlineAt: 900_000, outcome: null, lastError: null });

test('restart and a successor retry retain the original invocation and deadline without submission ownership', async t => {
  memoryDb(t, [[agents, [{ id: 'agent', companyId: 'company' }]], [costEvents, operationEntries()], [a2aExecutions, []], [a2aExecutionAliases, []]]);
  const first = await createA2aExecutionStore('agent').begin(seed());
  assert.equal(first.created, true);
  const restarted = createA2aExecutionStore('agent');
  const retry = await restarted.begin({ ...seed('operation:2'), contextId: 'new-context', deadlineAt: 1_800_000 });
  assert.equal(retry.created, false);
  assert.equal(retry.record.key, 'operation:1');
  assert.equal(retry.record.contextId, 'context-1');
  assert.equal(retry.record.deadlineAt, 900_000);
});

test('only terminal receipts can be acknowledged; consumed key replays but a new operation can submit', async t => {
  memoryDb(t, [[agents, [{ id: 'agent', companyId: 'company' }]], [costEvents, operationEntries()], [a2aExecutions, []], [a2aExecutionAliases, []]]);
  const store = createA2aExecutionStore('agent');
  await store.begin(seed());
  await acknowledgeA2aExecution('operation:1');
  assert.equal((await store.begin(seed('operation:2'))).created, false);
  await store.compareAndSet('operation:1', 0, { phase: 'terminal' });
  await acknowledgeA2aExecution('operation:2');
  assert.equal((await store.begin(seed())).created, false);
  assert.equal((await store.begin(seed('operation:3'))).created, true);
});

test('compare-and-set rejects stale writers and preserves agent isolation', async t => {
  memoryDb(t, [[agents, [{ id: 'agent', companyId: 'company' }, { id: 'other', companyId: 'company' }]], [costEvents, operationEntries()], [a2aExecutions, []], [a2aExecutionAliases, []]]);
  const store = createA2aExecutionStore('agent');
  await store.begin(seed());
  assert.equal((await store.compareAndSet('operation:1', 0, { phase: 'sending', baselineTaskIds: [] }))?.revision, 1);
  assert.equal(await store.compareAndSet('operation:1', 0, { contextId: 'wrong' }), null);
  assert.equal(await createA2aExecutionStore('other').get('operation:1'), null);
  await assert.rejects(createA2aExecutionStore('other').begin(seed()), /identity/);
});

test('acknowledgment rolls back with platform projection and sanitization preserves opaque identities', async t => {
  memoryDb(t, [[agents, [{ id: 'agent', companyId: 'company', apiToken: 'opaque-secret' }]], [costEvents, operationEntries()], [a2aExecutions, []], [a2aExecutionAliases, []]]);
  const store = createA2aExecutionStore('agent');
  await store.begin(seed());
  const outcome = { contextId: 'context-opaque-secret', taskId: 'task-opaque-secret', state: 'completed' as const, text: 'Avoid leaking opaque-secret', artifacts: [{ artifactId: 'artifact-opaque-secret', text: 'opaque-secret' }], report: null };
  const saved = await store.compareAndSet('operation:1', 0, { phase: 'terminal', outcome });
  assert.equal(saved!.outcome!.contextId, outcome.contextId);
  assert.equal(saved!.outcome!.taskId, outcome.taskId);
  assert.equal(saved!.outcome!.artifacts[0]!.artifactId, outcome.artifacts[0]!.artifactId);
  assert.ok(!saved!.outcome!.text.includes('opaque-secret'));
  assert.ok(!saved!.outcome!.artifacts[0]!.text!.includes('opaque-secret'));
  await assert.rejects(db.transaction(async tx => { await acknowledgeA2aExecution('operation:1', tx); throw new Error('projection_failed'); }));
  assert.equal((await store.begin(seed('operation:2'))).created, false);
});
