import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL remote drainage preserves submission fences, claim fairness, and usage lease ownership', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI, timeout: 60_000 }, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, agents, kanbanCards, taskRuns, heartbeatRuns, costEvents, a2aExecutions, a2aExecutionAliases } = await import('./db/schema.ts');
  const { createA2aExecutionStore, acknowledgeA2aExecution } = await import('./a2a-executions.ts');
  const { claimA2aRemoteReconciliation, finishA2aRemoteReconciliation } = await import('./a2a-remote-reconciliation.ts');
  const { admitUsage, cardUsageScope } = await import('./usage-ledger.ts');
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Remote drainage', slug: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: 'Worker', slug: 'worker', role: 'worker', adapterType: 'a2a' }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Original', body: '', assigneeId: agent!.id, columnStatus: 'in_progress' }).returning();
    const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, cardId: card!.id, source: 'dispatch', status: 'running' }).returning();
    const [run] = await db.insert(taskRuns).values({ companyId: company!.id, agentId: agent!.id, cardId: card!.id, heartbeatRunId: heartbeat!.id, kind: 'dispatch', status: 'running' }).returning();
    await admitUsage(cardUsageScope(card!, agent!, heartbeat!.id, run!.id, 'dispatch'));
    const key = `task-run:${run!.id}`;
    const record = { key, scope: JSON.stringify([agent!.id, 'task', card!.id, 'execution']), route: 'route', contextId: 'context', baselineTaskIds: null, phase: 'preparing' as const, taskId: null, deadlineAt: Date.now() + 900_000, outcome: null, lastError: null, revision: 0 };
    await db.insert(a2aExecutions).values({ key, companyId: company!.id, agentId: agent!.id, scope: record.scope, active: true, record });
    await db.insert(a2aExecutionAliases).values({ key, executionKey: key });
    return { company: company!, agent: agent!, card: card!, run: run!, heartbeat: heartbeat!, record };
  }
  await t.test('cancellation locks original run before journal while submission waits, without lock inversion', async () => {
    const f = await fixture();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const cancel = db.transaction(async tx => {
      await tx.select().from(taskRuns).where(eq(taskRuns.id, f.run.id)).for('update');
      locked(); await proceed;
      await tx.update(taskRuns).set({ status: 'cancelled' }).where(eq(taskRuns.id, f.run.id));
      await acknowledgeA2aExecution(f.record.key, tx);
    });
    await ready;
    const sending = assert.rejects(createA2aExecutionStore(f.agent.id).compareAndSet(f.record.key, 0, { phase: 'sending' }), /a2a_local_execution_stopped/);
    // Observe the actual database wait before allowing cancellation to acquire
    // the journal. A journal-first writer would now produce a lock cycle.
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%task_runs%'`;
        if (rows.length) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'submission must wait on original local owner');
    } finally { release(); }
    await cancel;
    await sending;
    assert.equal((await createA2aExecutionStore(f.agent.id).get(f.record.key))!.phase, 'preparing');
    // Keep later fixture claims isolated from this unresolved row.
    await db.update(a2aExecutions).set({ active: false }).where(eq(a2aExecutions.key, f.record.key));
  });
  await t.test('eligible canceled task is not starved behind 32 running future-deadline journals', async () => {
    const f = await fixture();
    const older = new Date(Date.now() - 60_000);
    for (let index = 0; index < 32; index++) {
      const [run] = await db.insert(taskRuns).values({ companyId: f.company.id, agentId: f.agent.id, cardId: f.card.id, heartbeatRunId: f.heartbeat.id, kind: 'dispatch', status: 'running' }).returning();
      const key = `task-run:${run!.id}`;
      await db.insert(a2aExecutions).values({ key, companyId: f.company.id, agentId: f.agent.id, scope: key, active: true, updatedAt: older, record: { ...f.record, key, scope: key } });
    }
    await db.update(taskRuns).set({ status: 'cancelled' }).where(eq(taskRuns.id, f.run.id));
    await db.update(heartbeatRuns).set({ status: 'cancelled' }).where(eq(heartbeatRuns.id, f.heartbeat.id));
    const claims = await Promise.all([claimA2aRemoteReconciliation(), claimA2aRemoteReconciliation()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean)!;
    assert.equal(claim.key, f.record.key);
    await finishA2aRemoteReconciliation(claim, { state: 'resolved', reason: 'a2a_never_submitted' });
    const [closed] = await db.select().from(a2aExecutions).where(eq(a2aExecutions.key, claim.key));
    assert.equal(closed!.active, false);
    assert.equal(closed!.record.outcome, null);
    assert.equal(closed!.record.phase, 'reconciliation_required');
  });
  await t.test('an expired finisher cannot replace a newer lease settlement', async () => {
    const f = await fixture();
    await db.update(taskRuns).set({ status: 'cancelled' }).where(eq(taskRuns.id, f.run.id));
    await db.update(heartbeatRuns).set({ status: 'cancelled' }).where(eq(heartbeatRuns.id, f.heartbeat.id));
    await db.update(a2aExecutions).set({ record: { ...f.record, phase: 'reconciliation_required', taskId: 'task', baselineTaskIds: [] } }).where(eq(a2aExecutions.key, f.record.key));
    const first = (await claimA2aRemoteReconciliation())!;
    const next = (await claimA2aRemoteReconciliation(Date.now() + 31_000))!;
    assert.equal(first.key, f.record.key); assert.equal(next.key, f.record.key);
    const outcome = (costUsd: string) => ({ state: 'completed' as const, contextId: 'context', taskId: 'task', text: '', report: null, artifacts: [], usage: { costUsd, costStatus: 'actual' as const, tokenStatus: 'unknown' as const } as any });
    await finishA2aRemoteReconciliation(next, { state: 'resolved', reason: 'natural', outcome: outcome('10') });
    await finishA2aRemoteReconciliation(first, { state: 'resolved', reason: 'natural', outcome: outcome('5') });
    const [entry] = await db.select().from(costEvents).where(eq(costEvents.attemptKey, f.record.key));
    assert.equal(Number(entry!.costUsd), 10);
  });
});
