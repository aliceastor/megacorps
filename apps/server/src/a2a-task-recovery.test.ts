import assert from 'node:assert/strict';
import test from 'node:test';
import { currentA2aRecoveryRun, withA2aRecoveryRun } from './a2a-task-recovery.ts';

test('recovery retains the original run and heartbeat across awaits without leaking between workers', async () => {
  const run = { id: 'original-run', heartbeatRunId: 'original-heartbeat', agentId: 'original-agent' } as any;
  assert.equal(currentA2aRecoveryRun(), undefined);
  await Promise.all([
    withA2aRecoveryRun(run, async () => {
      await Promise.resolve();
      assert.equal(currentA2aRecoveryRun(), run);
    }),
    Promise.resolve().then(() => assert.equal(currentA2aRecoveryRun(), undefined)),
  ]);
  assert.equal(currentA2aRecoveryRun(), undefined);
});

import { randomUUID } from 'node:crypto';
import { memoryDb } from './test-support/memory-db.ts';
import { agents, companies, kanbanCards, taskRuns, heartbeatRuns, a2aExecutions, a2aExecutionAliases, costEvents } from './db/schema.ts';
import { admitUsage, executeUsage, cardUsageScope } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';
import { openHeartbeatRun, claimAgentCapacity, budgetOk, completeTaskRun } from './dispatch.ts';

function fixture(t: Parameters<typeof memoryDb>[0]) {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true, isBusy: true, budgetMonthly: '1', spentThisMonth: '0', adapterType: 'a2a', runtimeId: null };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, columnStatus: 'in_progress', projectId: null };
  const heartbeat: any = { id: randomUUID(), companyId: company.id, cardId: card.id, agentId: agent.id, status: 'running' };
  const run: any = { id: randomUUID(), companyId: company.id, cardId: card.id, agentId: agent.id, heartbeatRunId: heartbeat.id, status: 'running', kind: 'dispatch' };
  const scope = cardUsageScope(card, agent, heartbeat.id, run.id, 'dispatch');
  const record: any = { key: scope.attemptKey, scope: JSON.stringify([agent.id, 'task', card.id, 'execution']), contextId: 'original-context', deadlineAt: 1000, phase: 'polling', revision: 1, outcome: null };
  const journal: any = { key: record.key, companyId: company.id, agentId: agent.id, scope: record.scope, active: true, record };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card]], [heartbeatRuns, [heartbeat]], [taskRuns, [run]], [a2aExecutions, [journal]], [a2aExecutionAliases, [{ key: record.key, executionKey: record.key }]]]);
  return { company, agent, card, heartbeat, run, scope, record, journal, state };
}

test('restart reuses occupied capacity, original heartbeat and reserved usage without a second admission', async t => {
  const f = fixture(t);
  await admitUsage(f.scope);
  let adapterReads = 0;
  const operation = async () => { adapterReads++; return { success: true, output: 'polled original task', sessionId: 'original-context', durationSeconds: 1, tokensUsed: 0, costUsd: 0.5, usage: { ...unknownUsage('fixture'), costStatus: 'actual' as const, costUsd: '0.5' } }; };
  await withA2aRecoveryRun(f.run, async () => {
    assert.equal(await budgetOk(f.agent, undefined, f.card), true);
    assert.equal(await claimAgentCapacity(f.agent), true);
    assert.equal((await openHeartbeatRun(f.card, f.agent, 'dispatch', f.run.id)).id, f.heartbeat.id);
    await executeUsage(f.scope, operation);
    await executeUsage(f.scope, operation);
  });
  assert.equal(adapterReads, 2);
  assert.equal(f.state.rows(heartbeatRuns).length, 1);
  assert.equal(f.state.rows(costEvents).length, 1);
  assert.equal(f.agent.spentThisMonth, '0.50000000');
  assert.equal(f.record.deadlineAt, 1000);
});

test('a successor run consumes the original outstanding accounting attempt and does not reserve again', async t => {
  const f = fixture(t);
  await admitUsage(f.scope);
  const successor: any = { ...f.run, id: randomUUID() };
  f.state.rows(taskRuns).push(successor);
  await executeUsage({ ...f.scope, taskRunId: successor.id, attemptKey: `task-run:${successor.id}` }, async () => ({ success: true, output: 'cached', sessionId: 'original-context', durationSeconds: 1, tokensUsed: 0, costUsd: 0, usage: unknownUsage('fixture') }), { a2aScope: f.record.scope });
  assert.equal(f.state.rows(costEvents).length, 1);
  assert.equal(f.state.rows(costEvents)[0]!.attemptKey, f.scope.attemptKey);
});

test('missing original accounting evidence blocks recovery before the adapter is called', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(executeUsage(f.scope, async () => { calls++; throw new Error('must not dispatch'); }), /a2a_usage_reconciliation_required/);
  assert.equal(calls, 0);
  assert.equal(f.state.rows(costEvents).length, 0);
});

test('a missing original heartbeat is fenced instead of opening a replacement', async t => {
  const f = fixture(t);
  f.heartbeat.status = 'cancelled';
  await assert.rejects(withA2aRecoveryRun(f.run, () => openHeartbeatRun(f.card, f.agent, 'dispatch', f.run.id)), /a2a_recovery_heartbeat_missing/);
  assert.equal(f.state.rows(heartbeatRuns).length, 1);
});

for (const kind of ['dispatch', 'review']) for (const phase of ['terminal', 'reconciliation_required']) test(`${kind} completion acknowledges only a handled terminal journal (${phase})`, async t => {
  const f = fixture(t);
  f.run.kind = kind;
  f.record.phase = phase;
  await completeTaskRun(f.run.id, { status: 'success', preserveCard: true, output: 'handled' });
  assert.equal(f.run.status, 'success');
  assert.equal(f.journal.active, phase !== 'terminal');
});

test('a distinct management scope cannot borrow an execution reservation', async t => {
  const f = fixture(t);
  await admitUsage(f.scope);
  const successor: any = { ...f.run, id: randomUUID() };
  f.state.rows(taskRuns).push(successor);
  let calls = 0;
  await assert.rejects(executeUsage({ ...f.scope, taskRunId: successor.id, attemptKey: `task-run:${successor.id}` }, async () => { calls++; throw new Error('must not dispatch'); }, { a2aScope: JSON.stringify([f.agent.id, 'task', f.card.id, 'management']) } as any), /budget_exceeded_agent/);
  assert.equal(calls, 0);
});


test('accounting pins the successor alias before a concurrent acknowledgment can release the scope', async t => {
  const f = fixture(t);
  await admitUsage(f.scope);
  const successor: any = { ...f.run, id: randomUUID() };
  f.state.rows(taskRuns).push(successor);
  const key = `task-run:${successor.id}`;
  const { createA2aExecutionStore } = await import('./a2a-executions.ts');
  await executeUsage({ ...f.scope, taskRunId: successor.id, attemptKey: key }, async () => {
    f.journal.active = false;
    const resumed = await createA2aExecutionStore(f.agent.id).begin({ ...f.record, key });
    assert.equal(resumed.created, false);
    assert.equal(resumed.record.key, f.record.key);
    return { success: true, output: 'replay', sessionId: 'original-context', durationSeconds: 1, tokensUsed: 0, costUsd: 0, usage: unknownUsage('fixture') };
  }, { a2aScope: f.record.scope });
  assert.equal(f.state.rows(costEvents).length, 1);
});

import { A2aTaskRunLease, withA2aTaskRunLease } from './a2a-task-recovery.ts';

for (const loss of ['connection', 'owner', 'cancelled']) test(`a ${loss} loss during the remote call fences late projection and settlement`, async t => {
  const f = fixture(t);
  f.run.lockedBy = 'original-worker';
  await admitUsage(f.scope);
  const lease = new A2aTaskRunLease(f.run);
  let projected = false;
  await assert.rejects(withA2aTaskRunLease(lease, async () => {
    await executeUsage(f.scope, async () => {
      if (loss === 'connection') lease.markLost();
      else if (loss === 'owner') f.run.lockedBy = 'replacement-worker';
      else f.run.status = 'cancelled';
      return { success: true, output: 'late', sessionId: 'original-context', durationSeconds: 1, tokensUsed: 0, costUsd: 0, usage: unknownUsage('fixture') };
    });
    projected = true;
  }), /a2a_task_run_lease_lost/);
  assert.equal(projected, false);
  assert.equal(f.state.rows(costEvents)[0]!.settledAt ?? null, null);
  assert.equal(f.heartbeat.status, 'running');
  assert.equal(f.agent.isBusy, true);
});

test('connection loss fences failed operations before their ordinary failure handling', async t => {
  const f = fixture(t);
  f.run.lockedBy = 'original-worker';
  await admitUsage(f.scope);
  const lease = new A2aTaskRunLease(f.run);
  await assert.rejects(withA2aTaskRunLease(lease, () => executeUsage(f.scope, async () => {
    lease.markLost();
    throw new Error('network error');
  })), /a2a_task_run_lease_lost/);
  assert.equal(f.state.rows(costEvents)[0]!.settledAt ?? null, null);
});
