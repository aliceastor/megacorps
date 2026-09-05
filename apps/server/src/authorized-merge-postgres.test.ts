import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL 16 durable authorized merge fence', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real merge transaction tests run in CI' : false, timeout: 60_000 }, async (t) => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, projects, kanbanCards, approvals, externalWaits, mergeIntents, reviewRounds, taskRuns, workProducts } = await import('./db/schema.ts');
  const { reviewCard } = await import('./dispatch.ts');
  const { executeAuthorizedMerge } = await import('./authorized-merge.ts');
  const { ensureHumanGate } = await import('./review-rounds.ts');
  const { reconcileMergeWait, parkForMerge } = await import('./merge-gate.ts');
  const oldUrl = process.env.GITEA_URL, oldToken = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-test-only';
  t.after(() => { if (oldUrl === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = oldUrl; if (oldToken === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = oldToken; });
  const head = 'a'.repeat(40);
  let posts = 0, merged = false;
  let onPost: (() => Promise<void>) | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') { posts++; assert.equal(JSON.parse(String(init.body)).head_commit_id, head); await onPost?.(); return new Response(null, { status: 204 }); }
    const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: 'admin' } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [{ rule_name: '[m]ain', created_at: '2026-09-05T00:00:00Z', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] }, { rule_name: '**', created_at: '2026-09-05T00:00:02Z', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [] }] : path.endsWith('/pulls/12') ? { number: 12, state: merged ? 'closed' : 'open', merged, head: { sha: head }, base: { ref: 'main' } } : { default_branch: 'main' };
    return new Response(JSON.stringify(value));
  };
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Merge fixture', slug: `merge-${randomUUID()}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: 'Managed', repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo', managedRepoFullName: 'org/repo', defaultBranch: 'main', autoMergeAfterApproval: true, completionRequiresMerge: true }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, projectId: project!.id, title: 'Exact head', body: 'Evidence', columnStatus: 'waiting_on_external' }).returning();
    const [wait] = await db.insert(externalWaits).values({ cardId: card!.id, companyId: company!.id, waitingFor: 'merge into main', provider: 'gitea', status: 'waiting', authorizedHeadSha: head, externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12', pollCount: 0, pollIntervalSeconds: 30 }).returning();
    const [fresh] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card!.id));
    const [intent] = await db.insert(mergeIntents).values({ cardId: card!.id, projectId: project!.id, waitId: wait!.id, headSha: head, repoFullName: 'org/repo', defaultBranch: 'main', gateVersion: fresh!.mergeGateVersion, state: 'prepared' }).returning();
    return { card: fresh!, project: project!, wait: wait!, intent: intent! };
  }
  function conflict(error: any): boolean { return error?.code === 'MC409' || (error?.cause && conflict(error.cause)); }
  await t.test('claim wins: human gate, review, child, move, wait and project policy cannot silently cancel in-flight merge; unrelated cards remain writable', async () => {
    const f = await fixture(), unrelated = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    onPost = async () => { entered(); await held; };
    const running = executeAuthorizedMerge(f.wait.id, { fetchImpl });
    await started;
    try {
      await assert.rejects(ensureHumanGate(f.card, null, 'New human gate'), conflict);
      await assert.rejects(db.insert(reviewRounds).values({ cardId: f.card.id, companyId: f.card.companyId, round: 1, status: 'open' }), conflict);
      await assert.rejects(db.insert(taskRuns).values({ cardId: f.card.id, companyId: f.card.companyId, kind: 'review', status: 'queued' }), conflict);
      await assert.rejects(db.insert(kanbanCards).values({ companyId: f.card.companyId, parentCardId: f.card.id, title: 'Required child', body: 'Gate' }), conflict);
      await assert.rejects(db.update(kanbanCards).set({ columnStatus: 'cancelled' }).where(eq(kanbanCards.id, f.card.id)), conflict);
      await assert.rejects(db.update(externalWaits).set({ status: 'superseded' }).where(eq(externalWaits.id, f.wait.id)), conflict);
      await assert.rejects(db.update(projects).set({ autoMergeAfterApproval: false }).where(eq(projects.id, f.project.id)), conflict);
      await ensureHumanGate(unrelated.card, null, 'Unrelated writes must proceed');
      assert.equal((await db.select().from(approvals).where(eq(approvals.cardId, unrelated.card.id))).length, 1);
      assert.equal(await executeAuthorizedMerge(f.wait.id, { fetchImpl }), false, 'duplicate claim cannot send another POST');
    } finally { release(); await running; onPost = undefined; }
    merged = true;
    await reconcileMergeWait(f.wait.id, { immediate: true, fetchImpl });
    merged = false;
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0]!.columnStatus, 'done');
    assert.equal((await db.select().from(mergeIntents).where(eq(mergeIntents.id, f.intent.id)))[0]!.state, 'verified');
  });
  for (const mutation of ['human', 'child', 'project'] as const) await t.test(`${mutation} wins on another connection: claim rechecks after waiting, with no POST`, async () => {
    const f = await fixture(); const before = posts;
    let locked!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { locked = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const writer = sql.begin(async (connection) => {
      await connection`SELECT id FROM kanban_cards WHERE id = ${f.card.id} FOR UPDATE`;
      if (mutation === 'human') await connection`INSERT INTO approvals(company_id,card_id,status,payload) VALUES (${f.card.companyId},${f.card.id},'pending','{"humanGate":true}')`;
      if (mutation === 'child') await connection`INSERT INTO kanban_cards(company_id,parent_card_id,title,body) VALUES (${f.card.companyId},${f.card.id},'Child','Required')`;
      if (mutation === 'project') await connection`UPDATE projects SET auto_merge_after_approval = false WHERE id = ${f.project.id}`;
      locked(); await held;
    });
    await entered;
    const claim = executeAuthorizedMerge(f.wait.id, { fetchImpl });
    // Let the second connection reach the lock while the first is uncommitted.
    await new Promise((resolve) => setTimeout(resolve, 60));
    release(); await writer;
    assert.equal(await claim, false); assert.equal(posts, before);
  });
  await t.test('real park transaction persists authorization and completes using provider reconciliation', async () => {
    const f = await fixture();
    await db.update(externalWaits).set({ status: 'superseded' }).where(eq(externalWaits.id, f.wait.id));
    const [card] = await db.update(kanbanCards).set({ columnStatus: 'in_review' }).where(eq(kanbanCards.id, f.card.id)).returning();
    onPost = async () => { merged = true; };
    try {
      await parkForMerge(card!, { disposition: 'wait', project: f.project, candidate: { kind: 'pull_request', pullRequestNumber: 12, pullRequestUrl: f.wait.externalUrl, branch: 'feature', headSha: head, workProductId: null }, headSha: head, defaultBranch: 'main', waitingFor: 'merge into main', externalId: '12', externalUrl: f.wait.externalUrl }, { fetchImpl });
      assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, card!.id)))[0]!.columnStatus, 'done');
    } finally { onPost = undefined; merged = false; }
  });
  await t.test('review entrypoint settles its original running task and old retry streak while provider acceptance awaits verification', async (t) => {
    const f = await fixture();
    await db.update(externalWaits).set({ status: 'superseded' }).where(eq(externalWaits.id, f.wait.id));
    await db.update(kanbanCards).set({ columnStatus: 'in_review', runRetryState: { review: { failures: 1, nextRunAt: null } } }).where(eq(kanbanCards.id, f.card.id));
    await db.insert(workProducts).values({ companyId: f.card.companyId, cardId: f.card.id, projectId: f.project.id, type: 'pull_request', title: 'Reviewed PR', pullRequestUrl: f.wait.externalUrl, commitSha: head });
    const [run] = await db.insert(taskRuns).values({ cardId: f.card.id, companyId: f.card.companyId, kind: 'review', status: 'running' }).returning();
    t.mock.method(globalThis, 'fetch', fetchImpl);
    await reviewCard(f.card.id, { taskRunId: run!.id });
    assert.equal((await db.select().from(taskRuns).where(eq(taskRuns.id, run!.id)))[0]!.status, 'success');
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id));
    assert.equal(card!.columnStatus, 'waiting_on_external'); assert.equal(card!.executionLockId, null); assert.equal(card!.activeHeartbeatRunId, null);
    const intents = await db.select().from(mergeIntents).where(eq(mergeIntents.cardId, f.card.id));
    assert.ok(intents.some((intent) => intent.state === 'accepted'));
  });
});
