import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isolatedPostgres } from './test-support/postgres-db.ts';

function signal() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
test('PostgreSQL deterministic merge-fence lock cycles', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real lock-cycle regression runs in CI' : false, timeout: 60_000 }, async (t) => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, projects, kanbanCards, taskRuns, users, companyMemberships, agents } = await import('./db/schema.ts');
  const { registerRoutes } = await import('./routes.ts');
  const { signSession } = await import('./auth.ts');
  const { guardedCompletionUpdate } = await import('./completion-guard.ts');
  const { reviewCard } = await import('./dispatch.ts');
  const [company] = await db.insert(companies).values({ name: 'Lock-cycle fixture', slug: `cycles-${randomUUID()}` }).returning();
  async function blockedBy(blocker: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await sql`SELECT pid FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid)) LIMIT 1`;
      if (row) return Number(row.pid);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected a deterministic blocked connection behind PID ${blocker}`);
  }
  async function holdBarrier(key: number) {
    const held = signal(), release = signal(); let pid = 0;
    const finished = sql.begin(async (connection) => {
      await connection`SET LOCAL lock_timeout = '5s'`;
      const [row] = await connection`SELECT pg_backend_pid() AS pid`;
      pid = Number(row!.pid);
      await connection`SELECT pg_advisory_xact_lock(${key})`;
      held.resolve(); await release.promise;
    });
    await held.promise;
    return { pid, release: async () => { release.resolve(); await finished; } };
  }
  await t.test('project edit and child update both commit despite the reported parent/child cycle', async () => {
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: 'Legacy opt-out', autoMergeAfterApproval: false }).returning();
    const parentId = '10000000-0000-4000-8000-000000000001', childId = '20000000-0000-4000-8000-000000000002';
    await db.insert(kanbanCards).values({ id: parentId, companyId: company!.id, projectId: project!.id, title: 'Parent', body: 'Fixture' });
    await db.insert(kanbanCards).values({ id: childId, companyId: company!.id, projectId: project!.id, parentCardId: parentId, title: 'Child', body: 'Fixture' });
    const [user] = await db.insert(users).values({ email: `cycles-${randomUUID()}@example.test`, name: 'Operator', role: 'admin' }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, userId: user!.id, role: 'admin', status: 'active' });
    const app = Fastify(); await app.register(cookie); await registerRoutes(app);
    const barrier = await holdBarrier(737241);
    // Pause exactly after the project's first parent target is locked. This
    // test-only trigger mirrors the reported ordering, without timing guesses.
    await sql.unsafe(`CREATE FUNCTION test_pause_project_cycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${project!.id}'::uuid THEN
        PERFORM id FROM kanban_cards WHERE id = '${parentId}'::uuid FOR UPDATE;
        PERFORM pg_advisory_xact_lock(737241);
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER aaa_test_pause_project_cycle BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION test_pause_project_cycle();`);
    const childHeld = signal(), changeChild = signal(); let childPid = 0;
    const childWrite = sql.begin(async (connection) => {
      await connection`SET LOCAL lock_timeout = '5s'`;
      const [row] = await connection`SELECT pg_backend_pid() AS pid`; childPid = Number(row!.pid);
      await connection`SELECT id FROM kanban_cards WHERE id = ${childId} FOR UPDATE`;
      childHeld.resolve(); await changeChild.promise;
      await connection`UPDATE kanban_cards SET title = 'Child committed' WHERE id = ${childId}`;
    }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await childHeld.promise;
    const projectWrite = app.inject({ method: 'PUT', url: `/api/projects/${project!.id}`, headers: { cookie: `session=${await signSession({ ...user!, role: 'admin' })}` }, payload: { defaultBranch: 'release' } });
    try {
      const projectPid = await blockedBy(barrier.pid);
      changeChild.resolve(); assert.equal(await blockedBy(projectPid), childPid);
      await barrier.release();
      const [childResult, response] = await Promise.all([childWrite, projectWrite]);
      assert.equal(childResult.ok, true, JSON.stringify(childResult));
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await db.select().from(projects).where(eq(projects.id, project!.id)))[0]!.defaultBranch, 'release');
      assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, childId)))[0]!.title, 'Child committed');
    } finally { changeChild.resolve(); await barrier.release(); await Promise.allSettled([childWrite, projectWrite]); await app.close(); }
  });
  await t.test('reviewer assignment retries its complete task-row write while guarded completion holds the card', async () => {
    const [agent] = await db.insert(agents).values({ companyId: company!.id, slug: 'busy-reviewer', name: 'Busy fixture reviewer', role: 'reviewer', isBusy: true }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, title: 'Parent integration', body: 'Fixture', columnStatus: 'in_review', assigneeId: agent!.id }).returning();
    await db.insert(kanbanCards).values({ companyId: company!.id, parentCardId: card!.id, title: 'Completed child', body: 'Fixture', columnStatus: 'done' });
    const [run] = await db.insert(taskRuns).values({ companyId: company!.id, cardId: card!.id, kind: 'review', status: 'running' }).returning();
    const barrier = await holdBarrier(737242);
    // A row trigger runs after PostgreSQL takes the task-row lock, before the
    // production authority trigger tries the card lock.
    await sql.unsafe(`CREATE FUNCTION test_pause_run_cycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${run!.id}'::uuid AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN PERFORM pg_advisory_xact_lock(737242); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aaa_test_pause_run_cycle BEFORE UPDATE ON task_runs FOR EACH ROW EXECUTE FUNCTION test_pause_run_cycle();`);
    const assignment = reviewCard(card!.id, { taskRunId: run!.id }).then(() => 'unexpected_success', (error: Error) => error.message);
    try {
      const assignmentPid = await blockedBy(barrier.pid);
      const [fresh] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card!.id));
      const completion = guardedCompletionUpdate(fresh!, { lastError: 'Completion committed' }, run!.id).then((row) => ({ row }), (error) => ({ error }));
      await blockedBy(assignmentPid);
      await barrier.release();
      const [assigned, completed] = await Promise.all([assignment, completion]);
      assert.equal(assigned, 'reviewer_busy', 'Actual review entrypoint must finish identity assignment before its expected busy check, not fail with deadlock.');
      assert.ok('row' in completed && completed.row, JSON.stringify(completed));
      assert.equal((await db.select().from(taskRuns).where(eq(taskRuns.id, run!.id)))[0]!.agentId, agent!.id);
    } finally { await barrier.release(); await assignment; }
  });
});
