import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('A2A original task recovery and accounting', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; PostgreSQL checks run in CI' : false, timeout: 60_000 }, async t => {
  const { db } = await isolatedPostgres(t);
  const schema = await import('./db/schema.ts');
  const { companies, agents, kanbanCards, taskRuns, heartbeatRuns, a2aExecutions, a2aExecutionAliases, costEvents } = schema;
  const { claimRecoverableA2aTaskRun, withTaskRunWorkerLease, withA2aRecoveryRun } = await import('./a2a-task-recovery.ts');
  const { admitUsage, executeUsage, cardUsageScope } = await import('./usage-ledger.ts');
  const { unknownUsage } = await import('./usage-facts.ts');
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Recovery', slug: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: 'Worker', slug: 'worker', role: 'worker', adapterType: 'a2a', isBusy: true, budgetMonthly: '1' }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Original task', body: '', assigneeId: agent!.id, columnStatus: 'in_progress' }).returning();
    const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, cardId: card!.id, source: 'dispatch', status: 'running' }).returning();
    const [run] = await db.insert(taskRuns).values({ companyId: company!.id, agentId: agent!.id, cardId: card!.id, heartbeatRunId: heartbeat!.id, kind: 'dispatch', status: 'running', lockedBy: 'dead-worker', lockedAt: new Date(Date.now() - 50_000), startedAt: new Date(Date.now() - 100_000) }).returning();
    await db.update(kanbanCards).set({ executionLockId: heartbeat!.id, activeHeartbeatRunId: heartbeat!.id }).where(eq(kanbanCards.id, card!.id));
    const key = `task-run:${run!.id}`;
    const record = { key, scope: JSON.stringify([agent!.id, 'task', card!.id, 'execution']), route: 'original-route', contextId: 'original-context', baselineTaskIds: [], phase: 'polling' as const, taskId: 'remote-task', deadlineAt: Date.now() + 300_000, outcome: null, lastError: null, revision: 2 };
    await db.insert(a2aExecutions).values({ key, companyId: company!.id, agentId: agent!.id, scope: record.scope, active: true, record });
    await db.insert(a2aExecutionAliases).values({ key, executionKey: key });
    const usageScope = cardUsageScope(card!, agent!, heartbeat!.id, run!.id, 'dispatch');
    await admitUsage(usageScope);
    return { company: company!, agent: agent!, card: card!, run: run!, heartbeat: heartbeat!, record, usageScope };
  }
  await t.test('restart claims the same run before old timeout and preserves remote deadline', async () => {
    const f = await fixture();
    const results = await Promise.all([claimRecoverableA2aTaskRun('new-one'), claimRecoverableA2aTaskRun('new-two')]);
    const claimed = results.find(Boolean)!;
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(claimed.id, f.run.id);
    assert.equal(claimed.heartbeatRunId, f.heartbeat.id);
    assert.equal(claimed.startedAt!.getTime(), f.run.startedAt!.getTime());
    assert.deepEqual((await db.select().from(a2aExecutions).where(eq(a2aExecutions.key, f.record.key)))[0]!.record, f.record);
    let adapterReads = 0;
    const result = await withA2aRecoveryRun(claimed, () => executeUsage(f.usageScope, async () => {
      adapterReads++;
      return { success: true, output: 'polled', sessionId: 'original-context', tokensUsed: 0, costUsd: 0.5, durationSeconds: 1, usage: { ...unknownUsage('fixture'), costStatus: 'actual', costUsd: '0.50000000' } };
    }));
    assert.equal(result.output, 'polled');
    assert.equal(adapterReads, 1);
    assert.equal((await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).length, 1);
    await withA2aRecoveryRun(claimed, () => executeUsage(f.usageScope, async () => result));
    assert.equal((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]!.spentThisMonth, '0.50000000');
  });
  await t.test('a live worker advisory lease excludes recovery even if its renewal is delayed', async () => {
    const f = await fixture();
    await withTaskRunWorkerLease(f.run, async () => {
      assert.equal(await claimRecoverableA2aTaskRun('another-worker'), null);
    });
    await db.update(taskRuns).set({ status: 'success' }).where(eq(taskRuns.id, f.run.id));
  });
  await t.test('cancellation and reassignment fence restart recovery', async () => {
    const f = await fixture();
    await db.update(taskRuns).set({ status: 'cancelled' }).where(eq(taskRuns.id, f.run.id));
    assert.equal(await claimRecoverableA2aTaskRun('another-worker'), null);
    await db.update(taskRuns).set({ status: 'running' }).where(eq(taskRuns.id, f.run.id));
    await db.update(kanbanCards).set({ assigneeId: null }).where(eq(kanbanCards.id, f.card.id));
    assert.equal(await claimRecoverableA2aTaskRun('another-worker'), null);
  });
});
