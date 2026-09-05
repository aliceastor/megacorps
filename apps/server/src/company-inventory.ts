/** Complete inbound row traversal. Catalog FKs are augmented only for logical IDs. */
export type CompanyLink = { table: string; column: string; target: string; array?: boolean };
export type Inventory = Record<string, { count: number; ids: string[]; foreignCount: number }>;
type RelatedRow = { id: string; company_id?: string | null };
export type InventorySql = { unsafe: (query: string, parameters?: any[]) => PromiseLike<any[]> };
const housekeeping = new Set(['positions', 'company_memberships', 'activity_log']);

export async function collectCompanyRows(companyId: string, links: CompanyLink[], read: (link: CompanyLink, ids: string[]) => Promise<RelatedRow[]>): Promise<Inventory> {
  const found = new Map<string, Map<string, RelatedRow>>([['companies', new Map([[companyId, { id: companyId }]])]]);
  const visited = new Map<CompanyLink, Set<string>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      const seen = visited.get(link) ?? new Set<string>(); visited.set(link, seen);
      const ids = [...(found.get(link.target)?.keys() ?? [])].filter(id => !seen.has(id));
      if (!ids.length) continue;
      ids.forEach(id => seen.add(id));
      const selected = await read(link, ids);
      const rows = found.get(link.table) ?? new Map<string, RelatedRow>(); found.set(link.table, rows);
      for (const row of selected) if (!rows.has(row.id)) { rows.set(row.id, row); changed = true; }
    }
  }
  return Object.fromEntries([...found].filter(([table]) => table !== 'companies').map(([table, rows]) => [table, {
    count: rows.size, ids: [...rows.keys()].sort(), foreignCount: [...rows.values()].filter(row => row.company_id != null && row.company_id !== companyId).length,
  }]));
}

export function deletionBlockers(inventory: Inventory): Record<string, number> {
  return Object.fromEntries(Object.entries(inventory).map(([table, rows]) => [table, housekeeping.has(table) ? rows.foreignCount : rows.count] as const).filter(([, count]) => count > 0));
}

const logicalLinks: CompanyLink[] = [
  { table: 'departments', column: 'head_agent_id', target: 'agents' },
  { table: 'positions', column: 'manager_position_id', target: 'positions' },
  { table: 'agents', column: 'runtime_id', target: 'agent_runtimes' },
  { table: 'agents', column: 'boss_id', target: 'agents' },
  { table: 'kanban_cards', column: 'parent_card_id', target: 'kanban_cards' },
  { table: 'kanban_cards', column: 'scheduled_from_card_id', target: 'kanban_cards' },
  { table: 'kanban_cards', column: 'active_heartbeat_run_id', target: 'heartbeat_runs' },
  { table: 'kanban_cards', column: 'dependency_card_ids', target: 'kanban_cards', array: true },
  { table: 'kanban_cards', column: 'reviewer_ids', target: 'agents', array: true },
  { table: 'task_runs', column: 'message_comment_id', target: 'card_comments' },
  { table: 'card_comments', column: 'parent_comment_id', target: 'card_comments' },
  { table: 'merge_intents', column: 'project_id', target: 'projects' },
  { table: 'merge_intents', column: 'wait_id', target: 'external_waits' },
  { table: 'merge_intents', column: 'originating_task_run_id', target: 'task_runs' },
  { table: 'card_actions', column: 'actor_id', target: 'agents' },
  { table: 'activity_log', column: 'actor_id', target: 'agents' },
  ...['companies','agents','departments','positions','agent_runtimes','projects','goals','kanban_cards','task_runs','chat_sessions','card_comments','work_products'].flatMap(target => [
    { table: 'activity_log', column: 'entity_id', target }, { table: 'notifications', column: 'entity_id', target },
    { table: 'adapter_sessions', column: 'scope_id', target },
  ]),
];
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';

/** Uses the transaction's current schema; never interpolates request identifiers. */
export async function companyInventoryCatalog(tx: InventorySql) {
  const columns: Array<{ table_name: string; column_name: string }> = await tx.unsafe(`SELECT c.relname AS table_name, a.attname AS column_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')`);
  const fields = new Map<string, Set<string>>();
  for (const row of columns) { const set = fields.get(row.table_name) ?? new Set(); set.add(row.column_name); fields.set(row.table_name, set); }
  const primaryKeys = new Map<string,string[]>();
  const keys = await tx.unsafe(`SELECT c.relname AS table_name,a.attname AS column_name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE i.indisprimary AND n.nspname=current_schema() ORDER BY c.relname,k.ord`);
  for(const key of keys) { const list=primaryKeys.get(key.table_name)??[];list.push(key.column_name);primaryKeys.set(key.table_name,list); }
  const rows = await tx.unsafe(`SELECT child.relname AS table_name, ca.attname AS column_name, parent.relname AS target_name, pa.attname AS target_column, cardinality(f.conkey) AS key_count FROM pg_constraint f JOIN pg_class child ON child.oid=f.conrelid JOIN pg_class parent ON parent.oid=f.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace JOIN pg_namespace pn ON pn.oid=parent.relnamespace JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=f.conkey[1] JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=f.confkey[1] WHERE f.contype='f' AND n.nspname=current_schema() AND pn.nspname=current_schema()`);
  const links: CompanyLink[] = rows.map(row => {
    if (Number(row.key_count) !== 1 || row.target_column !== 'id' || !primaryKeys.get(row.table_name)?.length) throw new Error('company_inventory_unsupported_reference');
    return { table: row.table_name, column: row.column_name, target: row.target_name };
  });
  links.push(...logicalLinks.filter(link => fields.get(link.table)?.has(link.column) && fields.has(link.target)));
  // Closure by tables is also the lock set. Sorting yields one order across removals.
  const related = new Set(['companies']);
  let size = 0;
  while (size !== related.size) { size = related.size; for (const link of links) if (related.has(link.target)) related.add(link.table); }
  const [[scope]] = await Promise.all([tx.unsafe('SELECT current_schema() AS name')]);
  return { links: links.filter(link => related.has(link.target)), fields, primaryKeys, tables: [...related].sort(), schema: String(scope.name) };
}

export async function companyDeletionInventory(tx: InventorySql, companyId: string, catalog?: Awaited<ReturnType<typeof companyInventoryCatalog>>) {
  const source = catalog ?? await companyInventoryCatalog(tx);
  return collectCompanyRows(companyId, source.links, async (link, ids) => {
    const column = quote(link.column);
    const predicate = link.array ? `${column}::text[] && ARRAY(SELECT jsonb_array_elements_text($1::jsonb))` : `${column}::text IN (SELECT jsonb_array_elements_text($1::jsonb))`;
    const keys=source.primaryKeys.get(link.table)!;
    const identity=keys.length===1&&keys[0]==='id'?'id::text':`jsonb_build_array(${keys.map(key=>`${quote(key)}::text`).join(',')})::text`;
    return tx.unsafe(`SELECT ${identity} AS id, ${source.fields.get(link.table)?.has('company_id') ? 'company_id::text' : 'NULL::text AS company_id'} FROM ${quote(source.schema)}.${quote(link.table)} WHERE ${predicate}`, [JSON.stringify(ids)]);
  });
}

export async function lockCompanyInventory(tx: InventorySql) {
  await tx.unsafe("SET LOCAL lock_timeout='1500ms'");
  await tx.unsafe("SET LOCAL statement_timeout='5000ms'");
  const catalog = await companyInventoryCatalog(tx);
  await tx.unsafe(`LOCK TABLE ${catalog.tables.map(table => `${quote(catalog.schema)}.${quote(table)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
  return catalog;
}
