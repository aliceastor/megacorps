import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isolatedPostgres } from './test-support/postgres-db.ts';

function signal() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('PostgreSQL concurrent organization edits cannot create a reporting cycle', {
  skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real PostgreSQL regression runs in CI' : false,
  timeout: 60_000,
}, async t => {
  const { db, sql } = await isolatedPostgres(t);
  const { companies, agents, users, companyMemberships } = await import('./db/schema.ts');
  const { registerRoutes } = await import('./routes.ts');
  const { signSession } = await import('./auth.ts');
  const [company] = await db.insert(companies).values({ name: 'Organization fixture', slug: `org-${randomUUID()}` }).returning();
  const [user] = await db.insert(users).values({ email: `org-${randomUUID()}@example.test`, name: 'Operator', role: 'admin' }).returning();
  await db.insert(companyMemberships).values({ companyId: company!.id, userId: user!.id, role: 'admin', status: 'active' });
  const [a, b] = await db.insert(agents).values(['a', 'b'].map(slug => ({ companyId: company!.id, slug, name: slug, role: 'worker' }))).returning();
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession({ ...user!, role: 'admin' })}` };
  const held = signal(), release = signal(); let barrierPid = 0;
  const barrier = sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    barrierPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await tx`SELECT pg_advisory_xact_lock(738081)`;
    held.resolve(); await release.promise;
  });
  await held.promise;
  // The isolated trigger pauses A exactly at its relationship write. B then
  // either waits behind the company transaction or exposes the old race.
  await sql.unsafe(`CREATE FUNCTION test_pause_org_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${a!.id}'::uuid AND NEW.boss_id IS DISTINCT FROM OLD.boss_id THEN
      PERFORM pg_advisory_xact_lock(738081);
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER aaa_test_pause_org_write BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION test_pause_org_write();`);
  async function blockedBy(pid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) LIMIT 1`;
      if (rows[0]) return Number(rows[0].pid);
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Expected the first relationship write to reach its SQL barrier');
  }
  const first = app.inject({ method: 'PUT', url: `/api/agents/${a!.id}`, headers, payload: { bossId: b!.id } });
  let second: typeof first | undefined;
  try {
    const firstPid = await blockedBy(barrierPid);
    let secondSettled = false;
    second = app.inject({ method: 'PUT', url: `/api/agents/${b!.id}`, headers, payload: { bossId: a!.id } });
    void second.then(() => { secondSettled = true; });
    const deadline = Date.now() + 3000;
    let secondBlocked = false;
    while (!secondSettled && Date.now() < deadline) {
      secondBlocked = (await sql`SELECT pid FROM pg_stat_activity WHERE ${firstPid} = ANY(pg_blocking_pids(pid))`).length > 0;
      if (secondBlocked) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(secondSettled || secondBlocked, 'The inverse request must reach its write or the company lock before releasing A');
    release.resolve(); await barrier;
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 400], 'Only one inverse relationship update may commit');
    assert.equal(responses.find(r => r.statusCode === 400)!.json().error, 'agent_reporting_cycle');
    const rows = await sql`SELECT id, boss_id FROM agents WHERE company_id = ${company!.id}`;
    assert.equal(rows.filter(r => r.boss_id != null).length, 1, 'The committed company graph must remain acyclic');
  } finally {
    release.resolve(); await barrier;
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});
