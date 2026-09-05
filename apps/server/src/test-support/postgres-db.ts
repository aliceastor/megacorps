import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import postgres from 'postgres';

/** Call before importing any application module that imports db/client.ts.
 * node --test gives the dedicated PostgreSQL file its own process. Never use
 * DATABASE_URL as a fixture input: cleanup is restricted to our random schema.
 */
export async function isolatedPostgres(t: TestContext) {
  const explicit = process.env.TEST_DATABASE_URL;
  if (!explicit) throw new Error('TEST_DATABASE_URL is required for real PostgreSQL tests; DATABASE_URL is never a fallback.');
  const target = new URL(explicit);
  const database = decodeURIComponent(target.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !/^(?:megacorps_test|test_megacorps)(?:_[a-z0-9_]+)?$/.test(database)) throw new Error('TEST_DATABASE_URL must name a dedicated megacorps_test database.');
  const schemaName = `mc_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^mc_test_[a-f0-9]{32}$/.test(schemaName)) throw new Error('Invalid isolated test schema identifier.');
  const control = postgres(explicit, { max: 1, connect_timeout: 5, connection: { statement_timeout: 5000, lock_timeout: 1200 } });
  let created = false;
  let appSql: (typeof import('../db/client.ts'))['sql'] | undefined;
  const previous = process.env.DATABASE_URL;
  t.after(async () => {
    try {
      await appSql?.end({ timeout: 2 });
      if (created) await control.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await control.end({ timeout: 2 });
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
  const [version] = await control`SHOW server_version_num`;
  assert.ok(Number(version!.server_version_num) >= 160000 && Number(version!.server_version_num) < 170000, 'The integration harness requires PostgreSQL 16.');
  await control.unsafe(`CREATE SCHEMA "${schemaName}"`);
  created = true;
  target.searchParams.set('options', `-c search_path=${schemaName},public -c lock_timeout=1200 -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000`);
  process.env.DATABASE_URL = target.toString();
  const client = await import('../db/client.ts');
  assert.equal(client.sql.options.database, database, 'Application DB must be imported after installing the isolated test URL.');
  appSql = client.sql;
  const [scope] = await appSql`SELECT current_schema() AS name`;
  assert.equal(scope!.name, schemaName, 'All application SQL must target the isolated schema.');
  const { migrate, appliedMigrations } = await import('../db/migrate.ts');
  await migrate();
  assert.ok((await appliedMigrations()).some((migration) => migration.version === 21), 'Actual application migrations must initialize the fixture.');
  // Verify session settings on several independently reserved app connections.
  const connections = await Promise.all([appSql.reserve(), appSql.reserve(), appSql.reserve()]);
  try {
    for (const connection of connections) {
      const [settings] = await connection`SELECT current_schema() AS name, current_setting('lock_timeout') AS lock_timeout`;
      assert.equal(settings!.name, schemaName);
      assert.equal(settings!.lock_timeout, '1200ms');
    }
  } finally { for (const connection of connections) connection.release(); }
  return { ...client, schemaName };
}
