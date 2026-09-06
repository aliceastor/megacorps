import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL guarded review approval effects', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real approval transaction checks run in CI' : false, timeout: 60_000 }, async t => {
  const { db } = await isolatedPostgres(t);
  const { companies, kanbanCards, approvals } = await import('./db/schema.ts');
  const { guardedCompletionUpdate } = await import('./completion-guard.ts');
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Approval transaction fixture', slug: `pg-${randomUUID()}` }).returning();
    const [created] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Reviewed deliverable', body: 'Verify atomic review approval effects.', columnStatus: 'in_review' }).returning();
    const [approval] = await db.insert(approvals).values({ companyId: company!.id, cardId: created!.id, type: 'task_review', status: 'pending', payload: { reason: 'Quality review' } }).returning();
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, created!.id));
    return { card: card!, approval: approval! };
  }
  await t.test('transient callback failure rolls back and retries the whole completion with final gate version', async () => {
    const f = await fixture(); let attempts = 0;
    const updated = await guardedCompletionUpdate(f.card, { columnStatus: 'waiting_on_external' }, null, { afterUpdate: async tx => {
      attempts++;
      const [before] = await tx.select().from(approvals).where(eq(approvals.id, f.approval.id));
      assert.equal(before!.status, 'pending', 'Failed prior attempt must not persist the approval write.');
      await tx.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, f.approval.id));
      if (attempts < 3) throw Object.assign(new Error('Synthetic retryable SQL contention after approval write'), { code: '55P03' });
    } });
    assert.equal(attempts, 3);
    const [persisted] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id));
    assert.deepEqual(updated, persisted); assert.ok(updated!.mergeGateVersion > f.card.mergeGateVersion);
    assert.equal((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status, 'approved');
  });
  await t.test('nonretryable callback failure rolls back the entire card and approval', async () => {
    const f = await fixture();
    await assert.rejects(guardedCompletionUpdate(f.card, { columnStatus: 'waiting_on_external' }, null, { afterUpdate: async tx => {
      await tx.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, f.approval.id));
      throw new Error('Synthetic terminal callback failure');
    } }), /Synthetic terminal callback failure/);
    assert.deepEqual((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0], f.card);
    assert.deepEqual((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0], f.approval);
  });
  await t.test('stale completion never invokes its approval effect', async () => {
    const f = await fixture(); let called = false;
    await db.update(kanbanCards).set({ columnStatus: 'todo' }).where(eq(kanbanCards.id, f.card.id));
    const updated = await guardedCompletionUpdate(f.card, { columnStatus: 'waiting_on_external' }, null, { afterUpdate: async () => { called = true; } });
    assert.equal(updated, undefined); assert.equal(called, false);
    assert.deepEqual((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0], f.approval);
  });
});
