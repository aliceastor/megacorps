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
