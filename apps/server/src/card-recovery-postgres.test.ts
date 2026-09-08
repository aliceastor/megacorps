import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test(
  'PostgreSQL recovery claims and decisions are atomic',
  {
    skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false,
    timeout: 60000,
  },
  async (t) => {
    const { db, sql } = await isolatedPostgres(t);
    const { companies, agents, kanbanCards, approvals, cardComments } = await import('./db/schema.ts');
    const { requestCardRecovery, applyRecoveryReport } = await import('./card-recovery.ts');
    const [company] = await db
      .insert(companies)
      .values({ name: 'Recovery fixture', slug: `recovery-${randomUUID()}` })
      .returning();
    const [head] = await db
      .insert(agents)
      .values({ companyId: company!.id, slug: 'head', name: 'Head', role: 'head', isActive: true, isBusy: true, adapterType: 'webhook' })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        slug: 'worker',
        name: 'Worker',
        role: 'worker',
        bossId: head!.id,
        isActive: true,
        adapterType: 'webhook',
      })
      .returning();
    const makeCard = async () =>
      (
        await db
          .insert(kanbanCards)
          .values({
            companyId: company!.id,
            title: 'Recovery fixture',
            body: 'Original goal',
            assigneeId: worker!.id,
            columnStatus: 'blocked',
          })
          .returning()
      )[0]!;
    await t.test('concurrent duplicate failure claims exactly one owner and round', async () => {
      const card = await makeCard();
      const failure = { reason: 'Real evidence absent', eventKey: 'one-failure', actorId: worker!.id, stage: 'dispatch' as const };
      await Promise.all([requestCardRecovery(structuredClone(card), failure), requestCardRecovery(structuredClone(card), failure)]);
      const [fresh] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id));
      assert.equal(fresh!.protocolRepairState.recovery!.round, 1);
      assert.equal(fresh!.reviewerId, head!.id);
      assert.equal((await db.select().from(cardComments).where(eq(cardComments.cardId, card.id))).length, 1);
      const reply: any = {
        kind: 'megacorps-report',
        status: 'completed',
        summary: 'Repair instructions',
        recovery: { action: 'rework', reason: 'Need evidence', instructions: 'Produce the real repository PR' },
      };
      const results = await Promise.allSettled([
        applyRecoveryReport(structuredClone(fresh!), head!.id, reply),
        applyRecoveryReport(structuredClone(fresh!), head!.id, reply),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value).length, 1);
      const [resumed] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id));
      assert.equal(resumed!.columnStatus, 'todo');
      assert.equal(resumed!.protocolRepairState.recovery!.round, 1);
    });
    await t.test('failure while writing human approval rolls back recovery state', async () => {
      const card = await makeCard();
      await db.update(agents).set({ bossId: null }).where(eq(agents.id, worker!.id));
      await sql.unsafe(
        `CREATE FUNCTION reject_recovery_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'kind' = 'recovery' THEN RAISE EXCEPTION 'recovery_gate_fixture_failure'; END IF; RETURN NEW; END $$`,
      );
      await sql.unsafe(
        'CREATE TRIGGER reject_recovery_gate BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION reject_recovery_gate()',
      );
      try {
        await assert.rejects(
          () => requestCardRecovery(card, { reason: 'No owner', eventKey: 'gate-failure', actorId: worker!.id, stage: 'dispatch' }),
          /recovery_gate_fixture_failure/,
        );
      } finally {
        await sql.unsafe('DROP TRIGGER reject_recovery_gate ON approvals');
        await sql.unsafe('DROP FUNCTION reject_recovery_gate()');
      }
      const [fresh] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id));
      assert.deepEqual(fresh!.protocolRepairState, {});
      assert.equal(fresh!.columnStatus, 'blocked');
      assert.equal((await db.select().from(approvals).where(eq(approvals.cardId, card.id))).length, 0);
    });
  },
);
