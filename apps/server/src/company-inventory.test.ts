import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCompanyRows, deletionBlockers } from './company-inventory.ts';

test('company inventory follows every direct/indirect/logical link including archived and foreign-company rows', async () => {
  const records: Record<string, any[]> = {
    projects: [{ id: 'archived', company_id: 'company', deleted_at: new Date() }],
    positions: [{ id: 'boss-position', company_id: 'company' }, { id: 'foreign-position', company_id: 'other', manager_position_id: 'boss-position' }],
    agents: [{ id: 'foreign-agent', company_id: 'other', position_id: 'boss-position' }],
    task_logs: [{ id: 'log', card_id: 'card' }],
    kanban_cards: [{ id: 'card', project_id: 'archived', company_id: 'company' }],
    company_memberships: [{ id: 'member', company_id: 'company' }],
    activity_log: [{ id: 'audit', company_id: 'company' }],
  };
  const links = [
    ...['projects','positions','agents','kanban_cards','company_memberships','activity_log'].map(table => ({ table, column: 'company_id', target: 'companies' })),
    { table: 'positions', column: 'manager_position_id', target: 'positions' },
    { table: 'agents', column: 'position_id', target: 'positions' },
    { table: 'kanban_cards', column: 'project_id', target: 'projects' },
    { table: 'task_logs', column: 'card_id', target: 'kanban_cards' },
  ];
  const inventory = await collectCompanyRows('company', links, async (link, ids) => (records[link.table] ?? []).filter(row => ids.includes(row[link.column])));
  assert.equal(inventory.projects?.count, 1);
  assert.deepEqual(inventory.task_logs?.ids, ['log']);
  assert.deepEqual(inventory.agents?.ids, ['foreign-agent']);
  assert.equal(inventory.positions?.foreignCount, 1);
  assert.deepEqual(deletionBlockers(inventory), { projects: 1, positions: 1, agents: 1, kanban_cards: 1, task_logs: 1 });
});

test('empty-company housekeeping is reported without blocking and cycles terminate', async () => {
  const links = [{ table: 'positions', column: 'company_id', target: 'companies' }, { table: 'positions', column: 'manager_position_id', target: 'positions' }];
  const rows = [{ id: 'position', company_id: 'company', manager_position_id: 'position' }];
  const inventory = await collectCompanyRows('company', links, async (link, ids) => rows.filter(row => ids.includes((row as any)[link.column])));
  assert.equal(inventory.positions?.count, 1);
  assert.deepEqual(deletionBlockers(inventory), {});
});

test('catalog retains FK link tables identified by composite primary keys', async () => {
  const { companyInventoryCatalog } = await import('./company-inventory.ts');
  const tables: Record<string,string[]> = {companies:['id'],kanban_cards:['id','company_id'],card_dependencies:['card_id','depends_on_card_id'],agents:['id','company_id'],tool_registry:['id','company_id'],agent_tool_bindings:['agent_id','tool_id'],card_tool_bindings:['card_id','tool_id'],notifications:['id','company_id'],notification_recipients:['notification_id','user_id']};
  const relations=[['kanban_cards','company_id','companies'],['agents','company_id','companies'],['tool_registry','company_id','companies'],['notifications','company_id','companies'],['card_dependencies','card_id','kanban_cards'],['card_dependencies','depends_on_card_id','kanban_cards'],['agent_tool_bindings','agent_id','agents'],['agent_tool_bindings','tool_id','tool_registry'],['card_tool_bindings','card_id','kanban_cards'],['card_tool_bindings','tool_id','tool_registry'],['notification_recipients','notification_id','notifications']];
  const catalog=await companyInventoryCatalog({unsafe:async query=>{
    if(query.includes('pg_constraint'))return relations.map(([table_name,column_name,target_name])=>({table_name,column_name,target_name,target_column:'id',key_count:1}));
    if(query.includes('pg_index'))return Object.entries(tables).flatMap(([table_name,columns])=>(columns.includes('id')?['id']:columns).map(column_name=>({table_name,column_name})));
    if(query.includes('pg_class'))return Object.entries(tables).flatMap(([table_name,columns])=>columns.map(column_name=>({table_name,column_name})));
    return [{name:'test_schema'}];
  }});
  for(const table of ['card_dependencies','agent_tool_bindings','card_tool_bindings','notification_recipients'])assert.ok(catalog.tables.includes(table),table);
});
