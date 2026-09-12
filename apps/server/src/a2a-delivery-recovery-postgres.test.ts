import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql as query } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL missing A2A delivery receipt recovery is precise, atomic, and fenced by descendant edits', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI, timeout: 60_000 }, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, agents, kanbanCards, taskRuns, a2aExecutions, a2aExecutionAliases, workProducts, activityLog } = await import('./db/schema.ts');
  const { sealDeliveryAcceptance } = await import('./delivery-acceptance.ts');
  const { recoverMissingA2aDeliveryReceipt } = await import('./a2a-delivery-recovery.ts');
  const [company] = await db.insert(companies).values({ name: 'Receipt recovery', slug: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: 'Manager', slug: 'manager', role: 'manager', adapterType: 'a2a' }).returning();
  const output = JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Original accepted descendant delivery.' });
  async function fixture() {
    const [root] = await db.insert(kanbanCards).values({ companyId: company!.id, assigneeId: agent!.id, title: 'Original root', body: 'Accepted child required', columnStatus: 'done' }).returning();
    const [child] = await db.insert(kanbanCards).values({ companyId: company!.id, assigneeId: agent!.id, parentCardId: root!.id, title: 'Child evidence', body: '', columnStatus: 'done' }).returning();
    const [product] = await db.insert(workProducts).values({ companyId: company!.id, agentId: agent!.id, cardId: child!.id, type: 'report', title: 'Original report', summary: 'Verified durable findings' }).returning();
    await sealDeliveryAcceptance(child!.id);
    const run = await db.transaction(async tx => {
      await tx.execute(query`UPDATE ${kanbanCards} SET updated_at = date_trunc('second', statement_timestamp()) - interval '1 minute' + interval '0.540123 seconds', completed_at = date_trunc('second', statement_timestamp()) - interval '1 minute' + interval '0.540123 seconds' WHERE id = ${root!.id}`);
      const [run] = await tx.insert(taskRuns).values({ companyId: company!.id, agentId: agent!.id, cardId: root!.id, kind: 'dispatch', status: 'success', output, completedAt: new Date() }).returning();
      await tx.execute(query`UPDATE ${taskRuns} SET completed_at = (SELECT completed_at + interval '17 milliseconds' FROM ${kanbanCards} WHERE id = ${root!.id}) WHERE id = ${run!.id}`);
      const key = `task-run:${run!.id}`;
      const scope = JSON.stringify([agent!.id, 'task', root!.id, 'management']);
      await tx.insert(a2aExecutions).values({ key, companyId: company!.id, agentId: agent!.id, scope, active: false, record: { key, scope, route: 'original-route', contextId: 'original-context', taskId: 'original-task', baselineTaskIds: [], phase: 'terminal', deadlineAt: 1, revision: 3, lastError: null, outcome: { contextId: 'original-context', taskId: 'original-task', state: 'completed', text: output, artifacts: [], report: null } } });
      await tx.insert(a2aExecutionAliases).values({ key, executionKey: key });
      return run!;
    });
    return { root: root!, child: child!, product: product!, run };
  }
  await t.test('concurrent workers mint one receipt and audit while preserving microsecond timestamp and gate', async () => {
    const f = await fixture();
    const [before] = await sql`SELECT updated_at::text AS stamp, merge_gate_version FROM kanban_cards WHERE id = ${f.root.id}`;
    const [origins] = await sql`SELECT c.xmin = r.xmin AND r.xmin = j.xmin AS same FROM kanban_cards c JOIN task_runs r ON r.card_id = c.id JOIN a2a_executions j ON j.key = 'task-run:' || r.id::text WHERE c.id = ${f.root.id}`;
    assert.equal(origins!.same, true);
    const results = await Promise.all([recoverMissingA2aDeliveryReceipt(f.root.id), recoverMissingA2aDeliveryReceipt(f.root.id)]);
    assert.equal(results.filter(Boolean).length, 1);
    const [after] = await sql`SELECT updated_at::text AS stamp, merge_gate_version, delivery_acceptance FROM kanban_cards WHERE id = ${f.root.id}`;
    assert.equal(after!.stamp, before!.stamp);
    assert.equal(after!.merge_gate_version, before!.merge_gate_version);
    assert.equal(after!.delivery_acceptance.inherited, true);
    assert.equal((await db.select().from(activityLog).where(eq(activityLog.entityId, f.root.id))).length, 1);
  });
  await t.test('a revoked receipt stays revoked after descendant evidence is reaccepted', async () => {
    const f = await fixture();
    await sealDeliveryAcceptance(f.root.id);
    const [sealed] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.root.id));
    assert.ok(sealed!.deliveryAcceptance);
    await db.update(workProducts).set({ summary: 'Changed and reaccepted evidence' }).where(eq(workProducts.id, f.product.id));
    await sealDeliveryAcceptance(f.child.id);
    const { acceptedDescendantEvidence } = await import('./delivery-acceptance.ts');
    const [revoked] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.root.id));
    assert.equal(revoked!.deliveryAcceptance, null);
    assert.equal((await acceptedDescendantEvidence(revoked!)).ready, true);
    assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
    assert.equal((await db.select().from(activityLog).where(eq(activityLog.entityId, f.root.id))).length, 0);
  });
  await t.test('an edit only one microsecond after completion cannot be repaired', async () => {
    const f = await fixture();
    await sql`UPDATE kanban_cards SET updated_at = completed_at + interval '1 microsecond' WHERE id = ${f.root.id}`;
    assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
  });
  await t.test('a concurrent child evidence writer cannot be bypassed or form a lock cycle', async () => {
    const f = await fixture();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const writer = sql.begin(async tx => {
      await tx`SELECT id FROM kanban_cards WHERE id = ${f.child.id} FOR UPDATE`;
      locked(); await hold;
      await tx`UPDATE work_products SET summary = 'Changed evidence' WHERE id = ${f.product.id}`;
    });
    await ready;
    try { await assert.rejects(recoverMissingA2aDeliveryReceipt(f.root.id), (error: any) => (error.cause?.code ?? error.code) === '55P03'); }
    finally { release(); }
    await writer;
    assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
    const [root] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.root.id));
    assert.equal(root!.deliveryAcceptance, null);
    assert.equal((await db.select().from(activityLog).where(eq(activityLog.entityId, f.root.id))).length, 0);
  });
});
