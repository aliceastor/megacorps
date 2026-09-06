import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL separate-process merge interleavings', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; separate-process PostgreSQL checks run in CI' : false, timeout: 180_000 }, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, projects, kanbanCards, externalWaits, mergeIntents, externalEvents } = await import('./db/schema.ts');
  const head = 'a'.repeat(40);
  async function fixture(parked = true) {
    const [company] = await db.insert(companies).values({ name: 'Contenders', slug: `contenders-${randomUUID()}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: 'Managed', repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo', managedRepoFullName: 'org/repo', defaultBranch: 'main', autoMergeAfterApproval: true, completionRequiresMerge: true }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, projectId: project!.id, title: 'Exact head', body: 'Evidence', columnStatus: parked ? 'waiting_on_external' : 'in_review' }).returning();
    if (!parked) return { card: card!, project: project!, wait: null, intent: null };
    const [wait] = await db.insert(externalWaits).values({ cardId: card!.id, companyId: company!.id, waitingFor: 'merge into main', provider: 'gitea', status: 'waiting', authorizedHeadSha: head, externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12', pollCount: 0, pollIntervalSeconds: 30 }).returning();
    const [fresh] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card!.id));
    const [intent] = await db.insert(mergeIntents).values({ cardId: card!.id, projectId: project!.id, waitId: wait!.id, headSha: head, repoFullName: 'org/repo', defaultBranch: 'main', gateVersion: fresh!.mergeGateVersion, state: 'prepared' }).returning();
    return { card: fresh!, project: project!, wait: wait!, intent: intent! };
  }
  function contender(input: Record<string, unknown>) {
    const name = `mc_contender_${randomUUID()}`;
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('application_name', name);
    const child = fork(new URL('./test-support/merge-contender.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, DATABASE_URL: url.toString(), GITEA_URL: 'https://gitea.test', GITEA_ADMIN_TOKEN: 'synthetic-test-only', MC_TEST_MERGE_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages: any[] = []; let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; }); child.on('message', message => messages.push(message));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const phase = async (wanted: string) => {
      for (let i = 0; i < 600; i++) {
        const failed = messages.find(message => message.phase === 'error'); if (failed) throw new Error(failed.error);
        const found = messages.find(message => message.phase === wanted); if (found) return found;
        if (child.exitCode !== null) throw new Error(`Contender exited before ${wanted}: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Contender timeout: ${wanted}: ${stderr}`);
    };
    return { child, name, phase, start: () => child.send('start') };
  }
  async function waitForBlocked(names: string[]) {
    for (let i = 0; i < 250; i++) {
      const rows = await sql`SELECT application_name FROM pg_stat_activity WHERE application_name IN ${sql(names)} AND wait_event_type = 'Lock'`;
      if (new Set(rows.map(row => row.application_name)).size === names.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Contenders did not reach PostgreSQL row locks');
  }
  async function holdCard(cardId: string, work: () => Promise<void>) {
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const transaction = sql.begin(async tx => { await tx`SELECT id FROM kanban_cards WHERE id=${cardId} FOR UPDATE`; locked(); await held; });
    await ready;
    try { await work(); } finally { release(); await transaction; }
  }
  await t.test('simultaneous park contenders create one logical wait and merge intent', async () => {
    const f = await fixture(false);
    const a = contender({ operation: 'park', cardId: f.card.id }), b = contender({ operation: 'park', cardId: f.card.id });
    await Promise.all([a.phase('ready'), b.phase('ready')]);
    await holdCard(f.card.id, async () => { a.start(); b.start(); await waitForBlocked([a.name, b.name]); });
    await Promise.all([a.phase('done'), b.phase('done')]);
    const waits = await db.select().from(externalWaits).where(eq(externalWaits.cardId, f.card.id));
    const intents = await db.select().from(mergeIntents).where(eq(mergeIntents.cardId, f.card.id));
    assert.equal(waits.length, 1); assert.equal(intents.length, 1); assert.equal(intents[0]!.waitId, waits[0]!.id);
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0]!.columnStatus, 'waiting_on_external');
  });
  await t.test('cancellation wins while an independent merge claimant waits on the card', async () => {
    const f = await fixture(); const a = contender({ operation: 'claim', cardId: f.card.id, waitId: f.wait!.id }); await a.phase('ready');
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const cancellation = sql.begin(async tx => { await tx`UPDATE kanban_cards SET column_status='cancelled' WHERE id=${f.card.id}`; started(); await held; });
    await ready;
    try { a.start(); await waitForBlocked([a.name]); } finally { release(); await cancellation; }
    assert.equal((await a.phase('done')).result, false);
    assert.equal((await db.select().from(mergeIntents).where(eq(mergeIntents.id, f.intent!.id)))[0]!.attemptCount, 0);
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0]!.columnStatus, 'cancelled');
    assert.equal((await db.select().from(externalWaits).where(eq(externalWaits.id, f.wait!.id)))[0]!.status, 'waiting');
  });
  await t.test('callback versus reconciliation on separate processes commits one closure', async () => {
    const f = await fixture();
    const a = contender({ operation: 'callback', cardId: f.card.id, waitId: f.wait!.id, merged: true }), b = contender({ operation: 'reconcile', cardId: f.card.id, waitId: f.wait!.id, merged: true });
    await Promise.all([a.phase('ready'), b.phase('ready')]);
    await holdCard(f.card.id, async () => { a.start(); b.start(); await waitForBlocked([a.name, b.name]); });
    await Promise.all([a.phase('done'), b.phase('done')]);
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.cardId, f.card.id))).length, 1);
    assert.equal((await db.select().from(externalWaits).where(eq(externalWaits.id, f.wait!.id)))[0]!.status, 'success');
    assert.equal((await db.select().from(mergeIntents).where(eq(mergeIntents.id, f.intent!.id)))[0]!.state, 'verified');
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0]!.columnStatus, 'done');
  });
  await t.test('process loss after committed claim retains the fence and fresh process reconciles provider truth', async () => {
    const f = await fixture(); const a = contender({ operation: 'crash', cardId: f.card.id, waitId: f.wait!.id }); await a.phase('ready'); a.start(); await a.phase('committed-claim-before-provider-return');
    a.child.kill(); await new Promise(resolve => a.child.once('exit', resolve));
    const [intent] = await db.select().from(mergeIntents).where(eq(mergeIntents.id, f.intent!.id));
    assert.equal(intent!.state, 'in_flight'); assert.equal(intent!.attemptCount, 1);
    await assert.rejects(sql`UPDATE kanban_cards SET column_status='cancelled' WHERE id=${f.card.id}`, (error: any) => error.code === 'MC409');
    const b = contender({ operation: 'reconcile', cardId: f.card.id, waitId: f.wait!.id, merged: true }); await b.phase('ready'); b.start(); await b.phase('done');
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.cardId, f.card.id))).length, 1);
    assert.equal((await db.select().from(mergeIntents).where(eq(mergeIntents.id, f.intent!.id)))[0]!.state, 'verified');
  });
});
