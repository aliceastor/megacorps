import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL delivery acceptance invalidation and guarded parent completion', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false, timeout: 60_000 }, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, agents, kanbanCards, workProducts } = await import('./db/schema.ts');
  const { sealDeliveryAcceptance, acceptedDescendantEvidence } = await import('./delivery-acceptance.ts');
  const { guardedCompletionUpdate } = await import('./completion-guard.ts');
  const [company] = await db.insert(companies).values({ name: 'Acceptance fixture', slug: `accept-${randomUUID()}` }).returning();
  const [worker] = await db.insert(agents).values({ companyId: company!.id, name: 'Worker', slug: 'worker', role: 'worker', adapterType: 'webhook' }).returning();
  const [other] = await db.insert(agents).values({ companyId: company!.id, name: 'Other', slug: 'other', role: 'worker', adapterType: 'webhook' }).returning();
  async function fixture() {
    const [parent] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Goal', body: 'Acceptance: verified report', columnStatus: 'in_progress', assigneeId: worker!.id }).returning();
    const [child] = await db.insert(kanbanCards).values({ companyId: company!.id, parentCardId: parent!.id, title: 'Report', body: 'Acceptance: findings', columnStatus: 'done', assigneeId: worker!.id }).returning();
    const [product] = await db.insert(workProducts).values({ companyId: company!.id, cardId: child!.id, agentId: worker!.id, type: 'report', title: 'Verified findings', summary: 'Durable report evidence' }).returning();
    await sealDeliveryAcceptance(child!.id);
    return { parent: parent!, child: child!, product: product! };
  }
  for (const change of ['authority', 'evidence', 'evidence_delete', 'evidence_move', 'company_policy', 'reopen', 'coordination'] as const) await t.test(`${change} restoration cannot revive an accepted child`, async () => {
    const f = await fixture();
    assert.equal((await acceptedDescendantEvidence(f.parent)).ready, true);
    if (change === 'evidence_delete') {
      await db.delete(workProducts).where(eq(workProducts.id, f.product.id));
      await db.insert(workProducts).values(f.product);
    } else if (change === 'evidence_move') {
      await db.update(workProducts).set({ cardId: f.parent.id }).where(eq(workProducts.id, f.product.id));
      await db.update(workProducts).set({ cardId: f.child.id }).where(eq(workProducts.id, f.product.id));
    } else if (change === 'company_policy') {
      await db.update(companies).set({ panelReviewDefault: 'always' }).where(eq(companies.id, company!.id));
      await db.update(companies).set({ panelReviewDefault: 'critical_only' }).where(eq(companies.id, company!.id));
    } else if (change === 'coordination') {
      await db.update(kanbanCards).set({ coordinationOnly: true }).where(eq(kanbanCards.id, f.child.id));
      await db.update(kanbanCards).set({ coordinationOnly: false }).where(eq(kanbanCards.id, f.child.id));
    } else if (change === 'authority') {
      await db.update(kanbanCards).set({ assigneeId: other!.id }).where(eq(kanbanCards.id, f.child.id));
      await db.update(kanbanCards).set({ assigneeId: worker!.id }).where(eq(kanbanCards.id, f.child.id));
    } else if (change === 'reopen') {
      await db.update(kanbanCards).set({ columnStatus: 'todo' }).where(eq(kanbanCards.id, f.child.id));
      await db.update(kanbanCards).set({ columnStatus: 'done' }).where(eq(kanbanCards.id, f.child.id));
    } else {
      await db.update(workProducts).set({ summary: 'Replacement' }).where(eq(workProducts.id, f.product.id));
      await db.update(workProducts).set({ summary: f.product.summary }).where(eq(workProducts.id, f.product.id));
    }
    assert.equal((await acceptedDescendantEvidence(f.parent)).ready, false);
    assert.equal(await guardedCompletionUpdate(f.parent, { columnStatus: 'done' }), undefined);
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.parent.id)))[0]!.columnStatus, 'in_progress');
  });
  await t.test('child writer and parent completion cannot form a waiting lock cycle or commit stale Done', async () => {
    const f = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const barrier = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const writer = sql.begin(async tx => {
      await tx`SELECT id FROM kanban_cards WHERE id = ${f.child.id} FOR UPDATE`;
      locked(); await hold;
      await tx`UPDATE work_products SET summary = 'Concurrent replacement' WHERE id = ${f.product.id}`;
    });
    await barrier;
    const completion = guardedCompletionUpdate(f.parent, { columnStatus: 'done' });
    setTimeout(release, 60);
    await writer;
    assert.equal(await completion, undefined);
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.parent.id)))[0]!.columnStatus, 'in_progress');
  });
});
