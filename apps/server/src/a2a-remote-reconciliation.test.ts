import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectA2aRemoteTask, remoteWorkPending } from './a2a-remote-reconciliation.ts';
import type { A2aInvocationRecord } from './a2a-polling.ts';
import type { A2aSendOutcome } from './a2a-client.ts';

const record = (patch: Partial<A2aInvocationRecord> = {}): A2aInvocationRecord => ({ key: 'task-run:original', scope: 'original-scope', route: 'original-route', contextId: 'original-context', taskId: 'original-task', baselineTaskIds: ['previous-task'], phase: 'reconciliation_required', deadlineAt: 1, outcome: null, lastError: 'a2a_deadline_exceeded', revision: 2, ...patch });
const outcome = (state: A2aSendOutcome['state'], patch: Partial<A2aSendOutcome> = {}): A2aSendOutcome => ({ taskId: 'original-task', contextId: 'original-context', state, text: '', report: null, artifacts: [], ...patch });

for (const reason of ['cancelled', 'deadline', 'restart']) test(`${reason} keeps original remote work occupied and reads only its exact task after the local deadline`, async () => {
  const original = record();
  const reads: string[] = [];
  const result = await inspectA2aRemoteTask(original, { route: original.route, getTask: async (id, full) => { reads.push(`${id}:${full}`); return outcome('working'); }, listTasks: async () => { throw new Error('known task must not be rediscovered'); } });
  assert.equal(result.state, 'waiting');
  assert.equal(remoteWorkPending({ active: true, record: original }), true);
  assert.deepEqual(reads, ['original-task:false']);
  assert.equal(original.deadlineAt, 1);
});

test('CancelTask acknowledgment is not proof that the remote subprocess stopped', async () => {
  const original = record({ phase: 'terminal', outcome: outcome('canceled') });
  assert.equal(remoteWorkPending({ active: false, record: original }), true);
  const result = await inspectA2aRemoteTask(original, { route: original.route, getTask: async () => outcome('canceled'), listTasks: async () => ({ tasks: [], nextPageToken: null }) });
  assert.equal(result.state, 'unresolved');
  assert.equal(result.reason, 'a2a_remote_cancel_unverified');
});

test('only the full naturally terminal original task resolves the remote drain', async () => {
  const reads: boolean[] = [];
  const result = await inspectA2aRemoteTask(record(), { route: 'original-route', getTask: async (_id, full) => { reads.push(full); return outcome('completed', { text: full ? 'final result' : '' }); }, listTasks: async () => ({ tasks: [], nextPageToken: null }) });
  assert.equal(result.state, 'resolved');
  assert.equal(result.outcome?.text, 'final result');
  assert.deepEqual(reads, [false, true]);
});

for (const mismatch of ['route', 'task', 'context', 'missing']) test(`a ${mismatch} mismatch never releases capacity`, async () => {
  const result = await inspectA2aRemoteTask(record(), {
    route: mismatch === 'route' ? 'new-route' : 'original-route',
    getTask: async () => { if (mismatch === 'missing') throw new Error('missing'); if (mismatch === 'route') assert.fail('changed route must not be contacted'); return outcome('completed', mismatch === 'task' ? { taskId: 'other-task' } : { contextId: 'other-context' }); },
    listTasks: async () => ({ tasks: [], nextPageToken: null }),
  });
  assert.equal(result.state, 'unresolved');
});

test('unknown acceptance uses saved baseline and refuses ambiguous matches', async () => {
  const original = record({ taskId: null });
  const result = await inspectA2aRemoteTask(original, { route: original.route, getTask: async () => assert.fail('ambiguous discovery cannot read a guessed task'), listTasks: async () => ({ tasks: [outcome('completed', { taskId: 'previous-task' }), outcome('working'), outcome('working', { taskId: 'another-new-task' })], nextPageToken: null }) });
  assert.equal(result.reason, 'a2a_ambiguous_task');
  assert.equal(result.state, 'unresolved');
});

import { randomUUID } from 'node:crypto';
import { memoryDb } from './test-support/memory-db.ts';
import { agents, companies, kanbanCards, taskRuns, heartbeatRuns, a2aExecutions, a2aExecutionAliases, costEvents, chatSessions } from './db/schema.ts';
import { createA2aExecutionStore, acknowledgeA2aExecution } from './a2a-executions.ts';
import { claimAgentCapacity } from './dispatch.ts';
import { admitUsage } from './usage-ledger.ts';
import { enqueueChatJob } from './chat-jobs.ts';

function fixture(t: Parameters<typeof memoryDb>[0]) {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, adapterType: 'a2a', isActive: true, isBusy: false, maxConcurrent: 4 };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, columnStatus: 'cancelled' };
  const heartbeat: any = { id: randomUUID(), companyId: company.id, cardId: card.id, agentId: agent.id, status: 'cancelled' };
  const run: any = { id: randomUUID(), companyId: company.id, cardId: card.id, agentId: agent.id, heartbeatRunId: heartbeat.id, status: 'cancelled' };
  const original = record({ key: `task-run:${run.id}`, scope: JSON.stringify([agent.id, 'task', card.id, 'execution']) });
  const execution: any = { key: original.key, companyId: company.id, agentId: agent.id, scope: original.scope, active: true, record: original };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, title: 'Chat with Worker' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card]], [heartbeatRuns, [heartbeat]], [taskRuns, [run]], [a2aExecutions, [execution]], [a2aExecutionAliases, [{ key: original.key, executionKey: original.key }]], [chatSessions, [session]]]);
  return { company, agent, card, heartbeat, run, original, execution, session, state };
}

test('local cancel cannot free multi-concurrent dispatch capacity while the exact remote task still runs', async t => {
  const f = fixture(t);
  assert.equal(await claimAgentCapacity(f.agent), false);
});

test('cancelled remote work rejects new usage admission even when the cached busy flag is false', async t => {
  const f = fixture(t);
  await assert.rejects(admitUsage({ companyId: f.company.id, agentId: f.agent.id, attemptKey: 'new-operation', source: 'fixture' }), /a2a_remote_work_pending/);
  assert.equal(f.state.rows(costEvents).length, 0);
});

test('Direct Chat cannot claim an agent whose cancelled card still has remote work', async t => {
  const f = fixture(t);
  const result = await enqueueChatJob(f.session, randomUUID(), 'new work');
  assert.equal('error' in result ? result.error : null, 'a2a_remote_work_pending');
});

test('a fresh journal cannot submit after its original task was cancelled', async t => {
  const f = fixture(t);
  f.state.rows(a2aExecutions).splice(0);
  f.state.rows(a2aExecutionAliases).splice(0);
  await assert.rejects(createA2aExecutionStore(f.agent.id).begin({ ...f.original, phase: 'preparing' }), /a2a_local_execution_stopped/);
  assert.equal(f.state.rows(a2aExecutions).length, 0);
});

test('acknowledgment cannot release a remotely canceled task without natural termination evidence', async t => {
  const f = fixture(t);
  f.execution.record = record({ key: f.original.key, phase: 'terminal', outcome: outcome('canceled') });
  await acknowledgeA2aExecution(f.original.key);
  assert.equal(f.execution.active, true);
});

import { finishA2aRemoteReconciliation, agentsWithRemoteStatus, refreshAgentRemoteCapacity } from './a2a-remote-reconciliation.ts';

async function admittedFixture(t: Parameters<typeof memoryDb>[0]) {
  const f = fixture(t);
  f.card.columnStatus = 'in_progress'; f.run.status = 'running'; f.heartbeat.status = 'running';
  f.execution.active = false;
  const scope = { companyId: f.company.id, agentId: f.agent.id, cardId: f.card.id, taskRunId: f.run.id, heartbeatRunId: f.heartbeat.id, attemptKey: f.original.key, source: 'dispatch' };
  await admitUsage(scope);
  f.execution.active = true;
  f.card.columnStatus = 'cancelled'; f.run.status = 'cancelled'; f.heartbeat.status = 'cancelled';
  f.execution.record.remoteReconciliation = { state: 'waiting', reason: 'waiting', attempts: 1, nextAttemptAt: 1000, leaseToken: 'original-lease', leaseExpiresAt: 1000 };
  return f;
}

for (const otherWork of [false, true]) test(`a late natural terminal result only settles original usage and preserves other ownership (${otherWork})`, async t => {
  const f = await admittedFixture(t);
  f.agent.maxConcurrent = 1;
  if (otherWork) f.state.rows(heartbeatRuns).push({ id: randomUUID(), companyId: f.company.id, agentId: f.agent.id, status: 'running' });
  const before = { ...f.card };
  const terminal = outcome('completed', { text: 'ignored late report', usage: { costUsd: '0.25', costStatus: 'actual', tokenStatus: 'unknown', reason: 'synthetic remote usage' } as any });
  await finishA2aRemoteReconciliation(f.execution, { state: 'resolved', reason: 'a2a_remote_naturally_finished', taskId: 'original-task', outcome: terminal });
  assert.equal(f.execution.active, false);
  assert.equal(f.execution.record.phase, 'reconciliation_required');
  assert.equal(f.run.status, 'cancelled');
  assert.deepEqual({ ...f.card, costUsd: before.costUsd }, { ...before, costUsd: before.costUsd });
  assert.equal(f.agent.isBusy, otherWork);
  assert.equal(f.state.rows(costEvents).length, 1);
  assert.equal(f.state.rows(costEvents)[0]!.costUsd, '0.25');
});

test('legacy terminal journal is closed only against its original completed local owner', async t => {
  const f = await admittedFixture(t);
  f.run.status = 'success'; f.heartbeat.status = 'success';
  f.execution.record.phase = 'terminal'; f.execution.record.outcome = outcome('completed');
  await finishA2aRemoteReconciliation(f.execution, { state: 'resolved', reason: 'a2a_remote_naturally_finished', outcome: outcome('completed') });
  assert.equal(f.execution.active, false);
  assert.equal(f.agent.isBusy, false);
});

test('agent API projection reports waiting despite an incorrect cached idle flag', async t => {
  const f = fixture(t);
  const [agent] = await agentsWithRemoteStatus([f.agent]);
  assert.equal(agent.isBusy, true);
  assert.equal(agent.remoteWork?.status, 'waiting_for_remote');
  await refreshAgentRemoteCapacity(f.agent.id);
  assert.equal(f.agent.isBusy, true);
});

test('cancel between journal creation and sending intent prevents the Send transition', async t => {
  const f = fixture(t);
  f.execution.record.phase = 'preparing';
  await assert.rejects(createA2aExecutionStore(f.agent.id).compareAndSet(f.original.key, f.original.revision, { phase: 'sending' }), /a2a_local_execution_stopped/);
  assert.equal(f.execution.record.phase, 'preparing');
});


test('an expired reconciliation lease cannot overwrite the winning usage settlement', async t => {
  const f = await admittedFixture(t);
  const stale = structuredClone(f.execution);
  f.execution.record.remoteReconciliation.leaseToken = 'replacement-lease';
  const winning = structuredClone(f.execution);
  const facts = (costUsd: string) => outcome('completed', { usage: { costUsd, costStatus: 'actual', tokenStatus: 'unknown' } as any });
  await finishA2aRemoteReconciliation(winning, { state: 'resolved', reason: 'natural', outcome: facts('10') });
  await finishA2aRemoteReconciliation(stale, { state: 'resolved', reason: 'natural', outcome: facts('5') });
  assert.equal(f.state.rows(costEvents)[0]!.costUsd, '10');
});

test('a canceled preparing journal is fenced and released without inventing remote completion', async t => {
  const f = await admittedFixture(t);
  f.execution.record.phase = 'preparing'; f.execution.record.taskId = null; f.execution.record.baselineTaskIds = null;
  await finishA2aRemoteReconciliation(structuredClone(f.execution), { state: 'resolved', reason: 'a2a_never_submitted' });
  assert.equal(f.execution.active, false);
  assert.equal(f.execution.record.outcome, null);
  assert.equal(f.execution.record.phase, 'reconciliation_required');
  assert.equal(f.agent.isBusy, false);
  await assert.rejects(createA2aExecutionStore(f.agent.id).compareAndSet(f.original.key, f.execution.record.revision, { phase: 'sending' }), /a2a_local_execution_stopped/);
});

test('unknown and settled operation owners cannot authorize submission', async t => {
  const f = fixture(t);
  f.state.rows(a2aExecutions).splice(0); f.state.rows(a2aExecutionAliases).splice(0);
  await assert.rejects(createA2aExecutionStore(f.agent.id).begin({ ...f.original, key: 'unknown:owner', phase: 'preparing' }), /a2a_execution_owner_unknown/);
  const key = 'operation:stopped';
  f.state.rows(costEvents).push({ attemptKey: key, companyId: f.company.id, agentId: f.agent.id, source: 'test_connection', admittedAt: new Date(), settledAt: new Date() });
  await assert.rejects(createA2aExecutionStore(f.agent.id).begin({ ...f.original, key, phase: 'preparing' }), /a2a_local_execution_stopped/);
});
