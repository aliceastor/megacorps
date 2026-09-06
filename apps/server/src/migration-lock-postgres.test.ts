import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL migrator retains and releases its own session lock under pool activity', {
  skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real PostgreSQL regression runs in CI' : false,
  timeout: 60_000,
}, async t => {
  const { sql } = await isolatedPostgres(t);
  const { migrate } = await import('./db/migrate.ts');
  const originalReserve = sql.reserve.bind(sql);
  const reservePool = (count = 10) => Promise.all(Array.from({ length: count }, () => originalReserve()));
  // Restrict observations/cleanup to this fixture's application sessions. Other
  // test processes intentionally share the database-wide migration lock key.
  const initial = await reservePool();
  const pids: number[] = [];
  try {
    for (const connection of initial) {
      pids.push(Number((await connection`SELECT pg_backend_pid() AS pid`)[0]!.pid));
      await connection`SELECT pg_advisory_unlock_all()`;
    }
  } finally { for (const connection of initial) connection.release(); }

  for (const fail of [false, true]) await t.test(fail ? 'failure releases lock' : 'success releases lock', async st => {
    await sql`DELETE FROM schema_migrations WHERE version = 29`;
    const originalUnsafe = sql.unsafe.bind(sql);
    let retained: Awaited<ReturnType<typeof sql.reserve>> | undefined;
    let reservedByMigrator = 0;
    // Pause after the actual migration DDL has run, before its bookkeeping and
    // finally/unlock. Steal an unreserved lock owner deterministically, rather
    // than relying on random pool scheduling to send unlock to another PID.
    let bodyReached = false;
    function instrumentUnsafe(original: typeof sql.unsafe, available: number): typeof sql.unsafe { return ((statement: string, ...args: any[]) => {
      const result = (original as any)(statement, ...args);
      if (!statement.startsWith('CREATE INDEX IF NOT EXISTS api_events_user_created_id_idx')) return result;
      return Promise.resolve(result).then(async value => {
        bodyReached = true;
        const connections = await reservePool(Math.min(available, 10 - reservedByMigrator));
        try {
          for (const connection of connections) {
            const [row] = await connection`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 727274001 AND pid = pg_backend_pid() AND granted) AS owns`;
            if (row!.owns) retained = connection;
          }
        } finally { for (const connection of connections) if (connection !== retained) connection.release(); }
        if (fail) throw new Error('synthetic migration body failure');
        return value;
      });
    }) as typeof sql.unsafe; }
    const instrument = st.mock.method(sql, 'unsafe', instrumentUnsafe(originalUnsafe, 10));
    const reservationInstrument = st.mock.method(sql, 'reserve', async () => {
      const connection = await originalReserve();
      reservedByMigrator++;
      const release = connection.release.bind(connection);
      st.mock.method(connection, 'release', () => { reservedByMigrator--; release(); });
      st.mock.method(connection, 'unsafe', instrumentUnsafe(connection.unsafe.bind(connection), 9));
      return connection;
    });
    try {
      if (fail) await assert.rejects(migrate(), /synthetic migration body failure/);
      else await migrate();
      assert.ok(bodyReached, 'The actual version 29 migration body must reach the pool activity checkpoint');
      const locks = await sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 727274001 AND granted AND pid = ANY(${pids})`;
      assert.equal(locks.length, 0, 'A finished migrator must release its session advisory lock even when its former pooled connection is occupied');
    } finally {
      instrument.mock.restore();
      reservationInstrument.mock.restore();
      if (retained) {
        await retained`SELECT pg_advisory_unlock_all()`;
        retained.release();
      }
    }
  });

  await t.test('concurrent migrators run each unapplied body once while other pool sessions stay usable', async st => {
    await sql`DELETE FROM schema_migrations WHERE version = 29`;
    const originalUnsafe = sql.unsafe.bind(sql);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let executions = 0;
    st.mock.method(sql, 'unsafe', ((statement: string, ...args: any[]) => {
      const query = (originalUnsafe as any)(statement, ...args);
      if (!statement.startsWith('CREATE INDEX IF NOT EXISTS api_events_user_created_id_idx')) return query;
      return Promise.resolve(query).then(async value => { executions++; entered(); await barrier; return value; });
    }) as typeof sql.unsafe);
    const first = migrate();
    await reached;
    const second = migrate();
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 727274001 AND NOT granted AND pid = ANY(${pids})`;
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, 'The second real migrator must wait on the first migration session lock');
      assert.equal(Number((await sql`SELECT 1 AS usable`)[0]!.usable), 1);
    } finally { release(); await Promise.all([first, second]); }
    assert.equal(executions, 1, 'Concurrent migrators must not run an unapplied body twice');
    assert.equal((await sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 727274001 AND granted AND pid = ANY(${pids})`).length, 0);
  });

  await t.test('more same-process migrators than pool slots cannot starve migration bodies', async () => {
    // Every invocation begins by reserving a holder. With max=10, twelve
    // simultaneous calls can occupy all slots with lock holders/waiters before
    // the first can execute its pooled body. The harness bounds any SQL wait.
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => migrate()));
    assert.deepEqual(results.map(result => result.status), Array(12).fill('fulfilled'),
      `Every bounded same-process migration must finish: ${results.filter(result => result.status === 'rejected').map(result => String(result.reason)).join('; ')}`);
  });
});
