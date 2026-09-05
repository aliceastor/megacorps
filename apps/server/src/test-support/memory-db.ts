import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { getTableColumns, getTableName, SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/client.ts';

type Row = Record<string, any>;

// A database boundary double for orchestration tests. Real dispatch, adapters,
// approval handling and logging run against these rows; no service is started.
export function memoryDb(t: TestContext, fixtures: Array<[Table, Row[]]>) {
  const tables = new Map<Table, Row[]>(fixtures);
  const dialect = new PgDialect();
  const rows = (table: Table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  function matches(table: Table, row: Row, condition?: SQL): boolean {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    if (query.sql.includes('NOT EXISTS (SELECT 1 FROM "approvals"')) {
      const approvalTable = [...tables.keys()].find((item) => getTableName(item) === 'approvals');
      if (approvalTable && rows(approvalTable).some((approval) => approval.cardId === row.id && approval.status === 'pending' && approval.type === 'task_review' && approval.payload?.humanGate === true)) return false;
      // The subquery's approval columns do not describe the outer card row.
      query.sql = query.sql.slice(0, query.sql.indexOf('NOT EXISTS'));
    }
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      const prefix = `"${getTableName(table)}"."${column.name}"`;
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of query.sql.matchAll(new RegExp(`${escaped} = \\$(\\d+)`, 'g'))) {
        if (row[key] !== query.params[Number(match[1]) - 1]) return false;
      }
      if (query.sql.includes(`${prefix} is null`) && row[key] != null) return false;
      const inClause = new RegExp(`${escaped} in \\(([^)]+)\\)`).exec(query.sql);
      if (inClause && ![...inClause[1]!.matchAll(/\$(\d+)/g)].some((m) => row[key] === query.params[Number(m[1]) - 1])) return false;
    }
    if (query.sql.includes("->>'humanGate' = 'true'") && row.payload?.humanGate !== true) return false;
    return true;
  }
  function query(table: Table, mode: 'select' | 'update' | 'insert', values?: Row | Row[]) {
    let condition: SQL | undefined;
    let limit = Infinity;
    let executed: Row[] | undefined;
    const orders: Array<{ key: string; descending: boolean }> = [];
    const execute = () => {
      if (executed) return executed;
      let selected = rows(table).filter((row) => matches(table, row, condition));
      if (mode === 'insert') {
        selected = (Array.isArray(values) ? values : [values!]).map((row) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...row }));
        rows(table).push(...selected);
      } else if (mode === 'update') {
        for (const row of selected) for (const [key, value] of Object.entries(values!)) {
          if (value !== undefined && !(value instanceof SQL)) row[key] = value;
        }
      }
      selected = selected.slice().sort((a, b) => {
        for (const order of orders) {
          const delta = a[order.key] < b[order.key] ? -1 : a[order.key] > b[order.key] ? 1 : 0;
          if (delta) return order.descending ? -delta : delta;
        }
        return 0;
      }).slice(0, limit);
      return executed = selected.map((row) => ({ ...row }));
    };
    const chain: any = {
      where: (value: SQL) => { condition = value; return chain; },
      orderBy: (...columns: any[]) => {
        for (const order of columns) {
          const sql = order instanceof SQL ? dialect.sqlToQuery(order).sql : `"${order.name}"`;
          const entry = Object.entries(getTableColumns(table)).find(([, column]) => sql.includes(`"${column.name}"`));
          if (entry) orders.push({ key: entry[0], descending: / desc$/i.test(sql) });
        }
        return chain;
      },
      limit: (value: number) => { limit = value; return chain; },
      innerJoin: () => { if (rows(table).length) throw new Error('nonempty joins need an explicit fixture'); return chain; },
      for: () => chain,
      onConflictDoNothing: () => chain,
      returning: () => chain,
      then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(execute).then(resolve, reject),
    };
    return chain;
  }
  t.mock.method(db, 'select', () => ({ from: (table: Table) => query(table, 'select') }) as any);
  t.mock.method(db, 'update', (table: Table) => ({ set: (value: Row) => query(table, 'update', value) }) as any);
  t.mock.method(db, 'insert', (table: Table) => ({ values: (value: Row | Row[]) => query(table, 'insert', value) }) as any);
  t.mock.method(db, 'transaction', async (work: (tx: typeof db) => Promise<unknown>) => work(db));
  return { rows };
}
