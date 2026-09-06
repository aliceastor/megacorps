import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL whole-branch completion authority and review provenance', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false, timeout: 120_000 }, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const s = await import('./db/schema.ts');
  const { dispatchCard, reviewCard } = await import('./dispatch.ts');
  const { getAdapter } = await import('./adapters/registry.ts');
  const { sealDeliveryAcceptance } = await import('./delivery-acceptance.ts');
  const { registerRunnerRoutes } = await import('./runner-routes.ts');
  const { hashRunnerApiKey } = await import('./runner-auth.ts');
  const { default: Fastify } = await import('fastify');
  const answer = (extra: object = {}) => ({ kind: 'megacorps-report', status: 'completed', summary: 'Accepted department evidence satisfies the goal.', ...extra });
  const result = (report: object) => ({ success: true, output: JSON.stringify(report), sessionId: 'whole-branch-result', tokensUsed: 0, costUsd: 0, durationSeconds: 1 });
  async function fixture() {
    const [company] = await db.insert(s.companies).values({ name: 'Whole branch fixture', slug: `whole-${randomUUID()}` }).returning();
    const [position] = await db.insert(s.positions).values({ companyId: company!.id, name: 'Boss', slug: 'boss', isCompanyBoss: true }).returning();
    const [boss] = await db.insert(s.agents).values({ companyId: company!.id, name: 'Boss', slug: 'boss', role: 'worker', positionId: position!.id, adapterType: 'webhook' }).returning();
    const [department] = await db.insert(s.departments).values({ companyId: company!.id, name: 'Engineering', slug: 'engineering' }).returning();
    const [head] = await db.insert(s.agents).values({ companyId: company!.id, name: 'Head', slug: 'head', role: 'worker', departmentId: department!.id, adapterType: 'webhook' }).returning();
    await db.update(s.departments).set({ headAgentId: head!.id }).where(eq(s.departments.id, department!.id));
    const [card] = await db.insert(s.kanbanCards).values({ companyId: company!.id, title: 'Assess goal', body: 'Acceptance: accepted department report.', assigneeId: boss!.id, columnStatus: 'in_progress', requiresApproval: false }).returning();
    const [run] = await db.insert(s.taskRuns).values({ companyId: company!.id, cardId: card!.id, agentId: boss!.id, kind: 'dispatch', status: 'running' }).returning();
    return { company: company!, boss: boss!, head: head!, card: card!, run: run! };
  }
  // Intercept a returned production read, after PostgreSQL materializes its
  // snapshot but before the caller resumes. The independent connection commits
  // the winning write; no timer or in-memory mutation establishes ordering.
  function afterCardRead(ctx: typeof t, armed: () => boolean, change: () => Promise<void>, skipReads = 0) {
    let reached = false;
    const select = db.select.bind(db);
    ctx.mock.method(db, 'select', ((...args: any[]) => {
      const query = (select as any)(...args); const from = query.from.bind(query);
      query.from = (table: any) => {
        const q = from(table);
        if (table === s.kanbanCards) {
          const limit = q.limit.bind(q);
          q.limit = (count: number) => {
            const pending = limit(count);
            if (!armed() || reached) return pending;
            if (skipReads-- > 0) return pending;
            reached = true;
            return Promise.resolve(pending).then(async rows => { await change(); return rows; });
          };
        }
        return q;
      };
      return query;
    }) as any);
    return () => reached;
  }

  for (const reopen of [true, false]) await t.test(`direct Done rechecks required child at final transaction: reopen=${reopen}`, async ctx => {
    const f = await fixture();
    const [child] = await db.insert(s.kanbanCards).values({ companyId: f.company.id, parentCardId: f.card.id, assigneeId: f.head.id, title: 'Accepted report', body: 'Verified findings', columnStatus: 'done' }).returning();
    await db.insert(s.workProducts).values({ companyId: f.company.id, cardId: child!.id, agentId: f.head.id, type: 'report', title: 'Verified findings', summary: 'Evidence for the goal' });
    await sealDeliveryAcceptance(child!.id);
    assert.ok((await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.id, child!.id)))[0]!.deliveryAcceptance, 'fixture receipt must exist');
    ctx.mock.method(getAdapter('webhook'), 'dispatch', async () => result(answer()));
    let reached = false;
    const transaction = db.transaction.bind(db);
    ctx.mock.method(db, 'transaction', ((operation: any, config: any) => transaction(async tx => {
      let completion = false;
      const update = tx.update.bind(tx);
      (tx as any).update = (table: any) => {
        const q = update(table); const set = q.set.bind(q);
        q.set = (values: any) => { if (table === s.agents && values.currentSessionId === 'whole-branch-result' && values.isBusy === false) completion = true; return set(values); };
        return q;
      };
      const select = tx.select.bind(tx);
      (tx as any).select = (...args: any[]) => {
        const q = (select as any)(...args); const from = q.from.bind(q);
        q.from = (table: any) => {
          const query = from(table); const limit = query.limit.bind(query);
          query.limit = (count: number) => {
            const pending = limit(count);
            if (!completion || reached || table !== s.kanbanCards) return pending;
            reached = true;
            return (async () => {
              if (reopen) await sql.begin(async writer => { await writer`UPDATE kanban_cards SET column_status='todo', delivery_acceptance=NULL WHERE id=${child!.id}`; });
              return await pending;
            })();
          }; return query;
        }; return q;
      };
      return operation(tx);
    }, config)) as any);
    await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
    assert.ok(reached, 'actual pre-parent-lock boundary must be reached');
    const [current] = await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.id, f.card.id));
    if (reopen) {
      assert.notEqual(current!.columnStatus, 'done'); assert.equal(current!.deliveryAcceptance, null);
      const logs = await db.select().from(s.taskLogs).where(eq(s.taskLogs.cardId, f.card.id));
      assert.equal(logs.filter(log => /marked done|→ done/.test(log.message ?? '')).length, 0);
      const activity = await db.select().from(s.activityLog).where(eq(s.activityLog.entityId, f.card.id));
      assert.equal(activity.filter(row => row.action === 'dispatch.completed').length, 0);
    } else { assert.equal(current!.columnStatus, 'done'); assert.ok(current!.deliveryAcceptance); }
  });

  for (const via of ['direct', 'runner'] as const) for (const effect of ['permission', 'split'] as const) for (const change of ['cancelled', 'reassigned', 'new_lock'] as const) await t.test(`${via} ${effect} preserves ${change} after initial authority read`, async ctx => {
    const f = await fixture(); let armed = via === 'runner'; let winning: any;
    const newerLock = randomUUID();
    const reached = afterCardRead(ctx, () => armed, async () => {
      await sql.begin(async writer => {
        if (change === 'cancelled') {
          await writer`UPDATE kanban_cards SET column_status='cancelled', execution_lock_id=NULL, active_heartbeat_run_id=NULL WHERE id=${f.card.id}`;
          await writer`UPDATE task_runs SET status='cancelled' WHERE id=${f.run.id}`;
        } else if (change === 'reassigned') await writer`UPDATE kanban_cards SET assignee_id=${f.head.id} WHERE id=${f.card.id}`;
        else await writer`UPDATE kanban_cards SET execution_lock_id=${newerLock}, execution_locked_by_agent_id=${f.boss.id} WHERE id=${f.card.id}`;
      });
      winning = (await sql`SELECT column_status,assignee_id,execution_lock_id,active_heartbeat_run_id FROM kanban_cards WHERE id=${f.card.id}`)[0];
    }, via === 'runner' ? 1 : 0);
    const report = effect === 'permission' ? answer({ status: 'input_required', request: { kind: 'permission', question: 'Allow repository read?' }, workProducts: [{ type: 'report', title: 'Partial evidence' }] }) : answer({ children: [{ title: 'Implement parser', body: 'Implement the parser and verify all supported records.\n\nAcceptance:\n- Regression tests cover valid and invalid input.', assigneeSlug: 'head' }] });
    if (via === 'direct') {
      ctx.mock.method(getAdapter('webhook'), 'dispatch', async () => { armed = true; return result(report); });
      await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
    } else {
      const runnerKey = `synthetic-runner-${randomUUID()}`;
      const [runner] = await db.insert(s.machineRunners).values({ companyId: f.company.id, name: 'Synthetic runner', slug: 'runner', apiKeyHash: hashRunnerApiKey(runnerKey) }).returning();
      await db.update(s.taskRuns).set({ lockedBy: runner!.id }).where(eq(s.taskRuns.id, f.run.id));
      const app = Fastify(); ctx.after(() => app.close()); await registerRunnerRoutes(app);
      const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status: 'success', report } });
      assert.ok(response.statusCode < 500, response.body);
    }
    assert.ok(reached(), 'initial production card snapshot must be returned before winning commit');
    assert.deepEqual((await sql`SELECT column_status,assignee_id,execution_lock_id,active_heartbeat_run_id FROM kanban_cards WHERE id=${f.card.id}`)[0], winning);
    assert.equal((await db.select().from(s.workProducts).where(eq(s.workProducts.cardId, f.card.id))).length, 0);
    assert.equal((await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.parentCardId, f.card.id))).length, 0);
  });

  for (const drift of [true, false]) await t.test(`URL-only review binds durable identity before reviewer starts: drift=${drift}`, async ctx => {
    const f = await fixture();
    const [project] = await db.insert(s.projects).values({ companyId: f.company.id, name: 'Review repository', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: false }).returning();
    await db.update(s.kanbanCards).set({ projectId: project!.id, assigneeId: f.head.id, reviewerId: f.boss.id, columnStatus: 'in_review' }).where(eq(s.kanbanCards.id, f.card.id));
    await db.update(s.taskRuns).set({ kind: 'review' }).where(eq(s.taskRuns.id, f.run.id));
    await db.insert(s.workProducts).values({ companyId: f.company.id, projectId: project!.id, cardId: f.card.id, agentId: f.head.id, type: 'pull_request', title: 'Change', url: 'https://gitea.test/org/repo/pulls/12' });
    const old = { url: process.env.GITEA_URL, token: process.env.GITEA_ADMIN_TOKEN };
    process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-provenance-token';
    ctx.after(() => { if (old.url === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = old.url; if (old.token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = old.token; });
    const headA = 'a'.repeat(40), headB = 'b'.repeat(40); let head = headA, reads = 0, posts = 0, readsBeforeReview = 0, prompt = '', persisted = '';
    ctx.mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
      const url = String(input); if (init?.method === 'POST') posts++;
      assert.match(url, /\/api\/v1\/repos\/org\/repo\/pulls\/12(?:\/commits)?$/);
      reads++;
      return new Response(JSON.stringify({ state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' }, html_url: 'https://gitea.test/org/repo/pulls/12' }));
    });
    ctx.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: any, task: any) => {
      readsBeforeReview = reads; prompt = task.body;
      // Independent connection sees the committed identity while review is held.
      persisted = JSON.stringify((await sql`SELECT row_to_json(c) AS card FROM kanban_cards c WHERE id=${f.card.id}`)[0]) + JSON.stringify(await sql`SELECT row_to_json(r) AS run FROM task_runs r WHERE card_id=${f.card.id}`) + JSON.stringify(await sql`SELECT row_to_json(w) AS product FROM work_products w WHERE card_id=${f.card.id}`);
      if (drift) head = headB;
      return result(answer({ verdict: 'approved' }));
    });
    await reviewCard(f.card.id, { taskRunId: f.run.id });
    const waits = await db.select().from(s.externalWaits).where(eq(s.externalWaits.cardId, f.card.id));
    assert.equal(waits.some(wait => wait.authorizedHeadSha === headB), false, 'never authorize a head first observed after approval');
    assert.ok(readsBeforeReview > 0, 'provider identity must be resolved before reviewer starts');
    assert.ok(prompt.includes(headA), 'review prompt must present the full reviewed head');
    assert.ok(persisted.includes(headA), 'review identity must survive a process restart');
    assert.equal(posts, 0);
    if (!drift) assert.ok(waits.some(wait => wait.authorizedHeadSha === headA));
  });
});
