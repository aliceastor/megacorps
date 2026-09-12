import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const { registerLiveRoutes } = await import('./live.ts');
  const { default: Fastify } = await import('fastify');
  const answer = (extra: object = {}) => ({ kind: 'megacorps-report', status: 'completed', summary: 'Accepted department evidence satisfies the goal.', ...extra });
  const result = (report: object) => ({ success: true, output: JSON.stringify(report), sessionId: 'whole-branch-result', tokensUsed: 0, costUsd: 0, durationSeconds: 1 });
  async function fixture() {
    const [company] = await db.insert(s.companies).values({ name: 'Whole branch fixture', slug: `whole-${randomUUID()}` }).returning();
    const [position] = await db.insert(s.positions).values({ companyId: company!.id, name: 'Boss', slug: 'boss', isCompanyBoss: true }).returning();
    const [boss] = await db.insert(s.agents).values({ companyId: company!.id, name: 'Boss', slug: 'boss', role: 'worker', positionId: position!.id, adapterType: 'webhook' }).returning();
    const [department] = await db.insert(s.departments).values({ companyId: company!.id, name: 'Engineering', slug: 'engineering' }).returning();
    const [headPosition] = await db.insert(s.positions).values({companyId:company!.id,name:'Head',slug:'head',rank:1,isDepartmentHead:true,defaultDepartmentId:department!.id}).returning();
    const [head] = await db.insert(s.agents).values({ companyId: company!.id, name: 'Head', slug: 'head', role: 'worker', positionId:headPosition!.id, departmentId: department!.id, adapterType: 'webhook' }).returning();
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
    const [observer] = await db.insert(s.users).values({ email: `${randomUUID()}@example.test`, name: 'Completion observer' }).returning();
    await db.insert(s.companyMemberships).values({ companyId: f.company.id, userId: observer!.id, role: 'viewer' });
    const publications: any[] = []; let connect: any; const handlers = new Map<string, () => void>();
    await registerLiveRoutes({ register: async () => {}, get(_url: string, _options: any, handler: any) { connect = handler; } } as any);
    await connect({ readyState: 1, close() {}, on(name: string, handler: () => void) { handlers.set(name, handler); }, send(payload: string) { publications.push(JSON.parse(payload)); } }, { authUser: { id: observer!.id, email: observer!.email, role: 'viewer' } });
    ctx.after(() => handlers.get('close')?.());
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
      assert.equal(publications.filter(event => event.cardId === f.card.id && ['complete', 'dispatch.completed'].includes(event.action)).length, 0, 'no completion publication is permitted');
    } else { assert.equal(current!.columnStatus, 'done'); assert.ok(current!.deliveryAcceptance); }
  });

  for (const via of ['direct', 'runner'] as const) for (const effect of ['permission', 'split'] as const) for (const change of ['cancelled', 'reassigned', 'new_lock', 'unchanged'] as const) await t.test(`${via} ${effect} preserves ${change} after initial authority read`, async ctx => {
    const f = await fixture(); let armed = via === 'runner'; let winning: any; let response: any;
    const newerLock = randomUUID();
    const reached = afterCardRead(ctx, () => armed, async () => {
      await sql.begin(async writer => {
        if (change === 'cancelled') {
          await writer`UPDATE kanban_cards SET column_status='cancelled', execution_lock_id=NULL, active_heartbeat_run_id=NULL WHERE id=${f.card.id}`;
          await writer`UPDATE task_runs SET status='cancelled' WHERE id=${f.run.id}`;
        } else if (change === 'reassigned') await writer`UPDATE kanban_cards SET assignee_id=${f.head.id} WHERE id=${f.card.id}`;
        else if (change === 'new_lock') {
          await writer`INSERT INTO heartbeat_runs(id,company_id,card_id,agent_id,source,status) VALUES (${newerLock},${f.company.id},${f.card.id},${f.boss.id},'manual','running')`;
          await writer`UPDATE kanban_cards SET execution_lock_id=${newerLock}, active_heartbeat_run_id=${newerLock}, execution_locked_by_agent_id=${f.boss.id} WHERE id=${f.card.id}`;
          await writer`UPDATE agents SET is_busy=true WHERE id=${f.boss.id}`;
        }
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
      response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run.id}/complete`, headers: { 'x-megacorps-runner-key': runnerKey }, payload: { status: 'success', report } });
    }
    assert.ok(reached(), 'initial production card snapshot must be returned before winning commit');
    if (change !== 'unchanged') assert.deepEqual((await sql`SELECT column_status,assignee_id,execution_lock_id,active_heartbeat_run_id FROM kanban_cards WHERE id=${f.card.id}`)[0], winning);
    else if (effect === 'permission') {
      const [recovery] = await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.id, f.card.id));
      assert.equal(recovery!.columnStatus, 'in_review');
      assert.equal(recovery!.protocolRepairState.recovery!.mode, 'awaiting_human');
      assert.equal(recovery!.protocolRepairState.recovery!.permissionBlocked, true);
      const gates = await db.select().from(s.approvals).where(eq(s.approvals.cardId, f.card.id));
      assert.equal(gates.filter(gate => gate.status === 'pending' && (gate.payload as any)?.humanGate === true).length, 1);
    }
    assert.equal((await db.select().from(s.workProducts).where(eq(s.workProducts.cardId, f.card.id))).length, 0, 'permission requests never persist partial evidence');
    assert.equal((await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.parentCardId, f.card.id))).length, change === 'unchanged' && effect === 'split' ? 1 : 0);
    if (change === 'new_lock') assert.equal((await db.select().from(s.agents).where(eq(s.agents.id, f.boss.id)))[0]!.isBusy, true, 'new execution keeps its agent capacity');
    if (change === 'new_lock') assert.equal((await db.select().from(s.heartbeatRuns).where(eq(s.heartbeatRuns.id, newerLock)))[0]!.status, 'running', 'new heartbeat remains owned and running');
    const usage = await db.select().from(s.costEvents).where(eq(s.costEvents.taskRunId, f.run.id));
    assert.equal(usage.length, 1); assert.equal(usage[0]!.agentId, f.boss.id, 'original accounting survives ignored result effects');
    if (response) assert.ok(response.statusCode < 500, response.body);
  });

  for (const path of ['review_products', 'direct_permission', 'review_permission', 'runner_products', 'runner_permission'] as const) for (const change of ['reassigned', 'new_heartbeat', 'cancelled'] as const) await t.test(`superseded ${path} settles original heartbeat after ${change} committed at helper entry`, async ctx => {
    const f = await fixture(); const reviewing = path.startsWith('review'), runner = path.startsWith('runner'), permission = path.endsWith('permission');
    if (reviewing) {
      await db.update(s.kanbanCards).set({ columnStatus: 'in_review', assigneeId: f.head.id, reviewerId: f.boss.id }).where(eq(s.kanbanCards.id, f.card.id));
      await db.update(s.taskRuns).set({ kind: 'review' }).where(eq(s.taskRuns.id, f.run.id));
    }
    if (runner) {
      const [heartbeat] = await db.insert(s.heartbeatRuns).values({ companyId: f.company.id, cardId: f.card.id, agentId: f.boss.id, source: 'manual', status: 'running' }).returning();
      await db.update(s.taskRuns).set({ heartbeatRunId: heartbeat!.id }).where(eq(s.taskRuns.id, f.run.id));
      await db.update(s.kanbanCards).set({ executionLockId: f.run.id, activeHeartbeatRunId: heartbeat!.id }).where(eq(s.kanbanCards.id, f.card.id));
      await db.update(s.agents).set({ isBusy: true }).where(eq(s.agents.id, f.boss.id));
    }
    const boundary = permission ? 'parkPermissionBlockedResult' : 'persistAgentWorkProducts';
    const newerHeartbeat = randomUUID(); let reached = false, originalHeartbeat = '', winning: any;
    const transaction = db.transaction.bind(db);
    // The selected production helper has been entered, but owns no lock yet.
    // Commit from another PG connection before admitting its transaction.
    ctx.mock.method(db, 'transaction', (async (callback: any, ...args: any[]) => {
      if (!reached && new Error().stack?.includes(boundary)) {
        reached = true;
        const [old] = await sql`SELECT id FROM heartbeat_runs WHERE card_id=${f.card.id} AND agent_id=${f.boss.id} AND status='running'`;
        assert.ok(old, 'actual handler owns a non-null original heartbeat'); originalHeartbeat = old!.id;
        await sql.begin(async writer => {
          if (change === 'reassigned') await writer`UPDATE kanban_cards SET assignee_id=${reviewing ? f.boss.id : f.head.id} WHERE id=${f.card.id}`;
          if (change === 'cancelled') {
            await writer`UPDATE kanban_cards SET column_status='cancelled', execution_lock_id=NULL, active_heartbeat_run_id=NULL WHERE id=${f.card.id}`;
            await writer`UPDATE task_runs SET status='cancelled' WHERE id=${f.run.id}`;
          }
          if (change === 'new_heartbeat') {
            await writer`INSERT INTO heartbeat_runs(id,company_id,card_id,agent_id,source,status) VALUES(${newerHeartbeat},${f.company.id},${f.card.id},${f.boss.id},'manual','running')`;
            await writer`UPDATE kanban_cards SET execution_lock_id=${newerHeartbeat},active_heartbeat_run_id=${newerHeartbeat} WHERE id=${f.card.id}`;
          }
        });
        winning = (await sql`SELECT column_status,assignee_id,reviewer_id,execution_lock_id,active_heartbeat_run_id FROM kanban_cards WHERE id=${f.card.id}`)[0];
      }
      return transaction(callback, ...args);
    }) as typeof db.transaction);
    const report = answer(permission ? { status: 'input_required', request: { kind: 'permission', question: 'Allow repository read?' } } : { verdict: 'approved', workProducts: [{ type: 'report', title: 'Reviewed evidence' }] });
    ctx.mock.method(getAdapter('webhook'), 'dispatch', async () => result(report));
    if (runner) {
      const key = `synthetic-round2-${randomUUID()}`;
      const [machine] = await db.insert(s.machineRunners).values({ companyId: f.company.id, name: 'Round2 runner', slug: 'round2', apiKeyHash: hashRunnerApiKey(key) }).returning();
      await db.update(s.taskRuns).set({ lockedBy: machine!.id }).where(eq(s.taskRuns.id, f.run.id));
      const app = Fastify(); ctx.after(() => app.close()); await registerRunnerRoutes(app);
      const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run.id}/complete`, headers: { 'x-megacorps-runner-key': key }, payload: { status: 'success', report } });
      assert.equal(response.statusCode, 200, response.body);
    } else if (reviewing) await reviewCard(f.card.id, { taskRunId: f.run.id });
    else await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
    assert.ok(reached);
    assert.deepEqual((await sql`SELECT column_status,assignee_id,reviewer_id,execution_lock_id,active_heartbeat_run_id FROM kanban_cards WHERE id=${f.card.id}`)[0], winning);
    assert.equal((await db.select().from(s.workProducts).where(eq(s.workProducts.cardId, f.card.id))).length, 0);
    assert.equal((await db.select().from(s.kanbanCards).where(eq(s.kanbanCards.parentCardId, f.card.id))).length, 0);
    const [run] = await db.select().from(s.taskRuns).where(eq(s.taskRuns.id, f.run.id)); assert.notEqual(run!.status, 'running');
    const usage = await db.select().from(s.costEvents).where(eq(s.costEvents.taskRunId, f.run.id)); assert.equal(usage.length, 1); assert.equal(usage[0]!.agentId, f.boss.id);
    const [old] = await db.select().from(s.heartbeatRuns).where(eq(s.heartbeatRuns.id, originalHeartbeat)); assert.notEqual(old!.status, 'running');
    assert.equal((await db.select().from(s.agents).where(eq(s.agents.id, f.boss.id)))[0]!.isBusy, change === 'new_heartbeat');
    if (change === 'new_heartbeat') assert.equal((await db.select().from(s.heartbeatRuns).where(eq(s.heartbeatRuns.id, newerHeartbeat)))[0]!.status, 'running');
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
      const childScript = `
        import { eq } from 'drizzle-orm';
        import { db, sql } from './src/db/client.ts';
        import { kanbanCards } from './src/db/schema.ts';
        import { beginReviewIdentity } from './src/review-identity.ts';
        import { planMergeGate } from './src/merge-gate.ts';
        globalThis.fetch = async () => new Response(JSON.stringify({state:'open',merged:false,head:{sha:'${drift ? headB : headA}'},base:{ref:'main'}}));
        const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id,'${f.card.id}'));
        const identity = await beginReviewIdentity(card,'${f.run.id}',{taskRunId:'${f.run.id}'});
        const plan = await planMergeGate(card,{taskRunId:'${f.run.id}'});
        process.stdout.write(JSON.stringify({head:identity?.headSha,disposition:plan.disposition}));
        await sql.end({timeout:2});
      `;
      const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], { timeout: 15_000, env: process.env });
      assert.deepEqual(JSON.parse(restarted.stdout), { head: headA, disposition: drift ? 'blocked' : 'wait' }, 'a separate application process must consume the same durable review identity');
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
