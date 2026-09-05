import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL 16 completion transactions', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false, timeout: 60_000 }, async (t) => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, users, companyMemberships, kanbanCards, approvals, taskLogs, notifications, externalWaits, externalEvents } = await import('./db/schema.ts');
  const { ensureHumanGate } = await import('./review-rounds.ts');
  const { applyExternalEvent } = await import('./external-events.ts');
  const { registerLiveRoutes } = await import('./live.ts');
  async function fixture(status = 'in_review') {
    const [company] = await db.insert(companies).values({ name: 'PostgreSQL fixture', slug: `pg-${randomUUID()}` }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Transactional completion', body: 'Verify completion transaction boundaries.', columnStatus: status }).returning();
    return { company: company!, card: card! };
  }

  await t.test('fresh human gate commits approval and log before notification/live events', { timeout: 15_000 }, async (t) => {
    const { company, card } = await fixture();
    const [user] = await db.insert(users).values({ email: `pg-${randomUUID()}@example.test`, name: 'Test observer' }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, userId: user!.id, role: 'admin' });
    let transactionOpen = false;
    const realTransaction = db.transaction.bind(db);
    t.mock.method(db, 'transaction', (async (operation: any, config: any) => {
      transactionOpen = true;
      try { return await realTransaction(operation, config); }
      finally { transactionOpen = false; }
    }) as typeof db.transaction);
    const premature: string[] = [];
    const emitted: string[] = [];
    const insert = db.insert.bind(db);
    t.mock.method(db, 'insert', ((table: any) => {
      if (table === notifications && transactionOpen) premature.push('notification insert');
      return insert(table);
    }) as typeof db.insert);
    // Register a synchronous socket boundary with the real live publisher.
    // This observes publication time, rather than racing a network delivery.
    let connect!: (socket: any, request: any) => Promise<void>;
    const transport: any = { register: async () => {}, get(_url: string, _options: unknown, handler: typeof connect) { connect = handler; } };
    await registerLiveRoutes(transport);
    const handlers = new Map<string, () => void>();
    await connect({ readyState: 1, close() {}, on(name: string, fn: () => void) { handlers.set(name, fn); }, send(payload: string) {
      const event = JSON.parse(payload);
      if (event.type === 'live.connected') return;
      emitted.push(event.type);
      if (transactionOpen) premature.push(event.type);
    } }, { authUser: { id: user!.id, email: user!.email, role: 'admin' } });
    t.after(() => handlers.get('close')?.());
    await ensureHumanGate(card, null, 'Client must approve the completed deliverable.');
    const [approval] = await db.select().from(approvals).where(eq(approvals.cardId, card.id));
    assert.equal((approval?.payload as any)?.humanGate, true);
    assert.equal((await db.select().from(taskLogs).where(eq(taskLogs.cardId, card.id))).filter((log) => log.type === 'approval').length, 1);
    assert.equal((await db.select().from(notifications).where(eq(notifications.cardId, card.id))).length, 1);
    assert.deepEqual(premature, [], 'Notifications and live events must be published only after commit.');
    assert.ok(emitted.includes('task_log.created'));
    assert.ok(emitted.includes('notification.created'));
    const [visible] = await sql`SELECT count(*)::int AS count FROM approvals WHERE card_id = ${card.id} AND payload->>'humanGate' = 'true'`;
    assert.equal(visible!.count, 1);
  });

  for (const outcome of ['success', 'timeout'] as const) await t.test(`${outcome} on a moved wait preserves the entire card and wait`, async () => {
    const { card } = await fixture('in_progress');
    const [wait] = await db.insert(externalWaits).values({ cardId: card.id, companyId: card.companyId, waitingFor: 'External result', provider: 'test', status: 'waiting' }).returning();
    // Wait creation is a gate mutation from migration 22 onward. Capture the
    // complete committed fixture after all writes; the event must preserve it.
    const [baseline] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id));
    const result = await applyExternalEvent({ card, input: { provider: 'test', eventType: outcome, status: outcome, waitId: wait!.id }, actor: { type: 'system', id: 'postgres-test' } });
    assert.equal(result.event, null);
    assert.deepEqual((await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)))[0], baseline);
    assert.deepEqual((await db.select().from(externalWaits).where(eq(externalWaits.id, wait!.id)))[0], wait);
  });

  await t.test('active closure and replay commit one event', async () => {
    const { card } = await fixture('waiting_on_external');
    const [wait] = await db.insert(externalWaits).values({ cardId: card.id, companyId: card.companyId, waitingFor: 'External result', provider: 'test', status: 'waiting' }).returning();
    const input = { provider: 'test', eventType: 'success', status: 'success' as const, waitId: wait!.id };
    const actor = { type: 'system' as const, id: 'postgres-test' };
    assert.ok((await applyExternalEvent({ card, input, actor })).event);
    assert.equal((await applyExternalEvent({ card, input, actor })).event, null);
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.cardId, card.id))).length, 1);
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)))[0]?.columnStatus, 'done');
  });
});
