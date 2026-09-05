import assert from 'node:assert/strict';
import test from 'node:test';
import { agents, companies, departments, positions, kanbanCards, cardComments } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { collaborationDelegationRequirement, completionBlockedByChildren, dispatchCard, buildReviewPrompt, processChildSplits } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { companyExecutionReadiness } from './company-workflow.ts';
import { dispatchInternals, createMessageDelegations } from './dispatch.ts';
test('staffed-head message reports are idempotent and agent-generated children cannot grant coordination exemption', async t => {
  const state = fixture(t, [{ id: 'employee', companyId: 'company', name: 'Employee', slug: 'employee', departmentId: 'department', isActive: true, adapterType: 'webhook' }]);
  const parent: any = { ...card, assigneeId: 'head' };
  const first = await createMessageDelegations(parent, head as any, ['employee: Deliver a verified report'], { sourceTaskRunId: 'same-run' });
  const second = await createMessageDelegations(parent, head as any, ['employee: Deliver a verified report'], { sourceTaskRunId: 'same-run' });
  assert.equal(first.length, 1); assert.equal(second[0]?.id, first[0]?.id);
  assert.equal(state.rows(cardComments).filter(row => row.action === 'delegate_request').length, 1);
  const split = await processChildSplits(card, boss as any, [{ title: 'Build', body: '## Acceptance\n- Works', assigneeSlug: 'head', coordinationOnly: true } as any]);
  assert.equal(split.created.length, 1); assert.notEqual(state.rows(kanbanCards).find(row => row.parentCardId === card.id)?.coordinationOnly, true);
});
test('coordination exemption affects delegation only and does not remove a pending required child', async t => {
  const state = fixture(t);
  assert.equal((await collaborationDelegationRequirement({ ...card, coordinationOnly: true }, 'boss')).required, false);
  state.rows(kanbanCards).push({ id: 'child', parentCardId: card.id, companyId: card.companyId, title: 'Required', columnStatus: 'todo', childRequirementLevel: 'required' });
  assert.ok(await completionBlockedByChildren({ ...card, coordinationOnly: true, requiresApproval: true }, 'done'));
});
test('automatic root assignment does not bypass an unavailable Boss for an idle employee', async t => {
  const state = fixture(t, [{ id: 'employee', companyId: 'company', name: 'Employee', slug: 'employee', departmentId: 'department', isActive: true, adapterType: 'webhook' }]);
  state.rows(agents).find(a => a.id === 'boss')!.isBusy = true;
  t.after(() => { state.rows(agents).find(a => a.id === 'boss')!.isBusy = false; });
  const unassigned = state.rows(kanbanCards)[0]!; unassigned.assigneeId = null;
  assert.equal(await dispatchInternals.ensureAssigned(unassigned as any, 'loop'), null);
  assert.equal(unassigned.assigneeId, null);
});

const boss = { id: 'boss', companyId: 'company', name: 'Boss', slug: 'boss', positionId: 'boss-position', adapterType: 'webhook', isActive: true };
const head = { id: 'head', companyId: 'company', name: 'Head', slug: 'head', departmentId: 'department', adapterType: 'webhook', isActive: true };
const card: any = { id: 'card', companyId: 'company', title: 'Build the requested product', body: 'Acceptance: A working deliverable', assigneeId: 'boss', columnStatus: 'in_progress', collaborationMode: false };
function fixture(t: Parameters<typeof memoryDb>[0], staff: any[] = []) {
  return memoryDb(t, [[companies, [{ id: 'company', name: 'Acme' }]], [positions, [{ id: 'boss-position', companyId: 'company', isCompanyBoss: true }]], [departments, [{ id: 'department', companyId: 'company', name: 'Engineering', headAgentId: 'head' }]], [agents, [boss, head, ...staff]], [kanbanCards, [{ ...card }]]]);
}
test('Boss must delegate to structural department heads without numeric rank or bossId', async (t) => {
  fixture(t);
  const requirement = await collaborationDelegationRequirement(card, 'boss');
  assert.equal(requirement.required, true); assert.deepEqual(requirement.reports.map(r => r.id), ['head']);
});
test('sole head executes but staffed head delegates even when staff are unavailable', async (t) => {
  const state = fixture(t);
  assert.equal((await collaborationDelegationRequirement(card, 'head')).required, false);
  state.rows(agents).push({ id: 'member', companyId: 'company', name: 'Employee', slug: 'employee', departmentId: 'department', isActive: false, adapterType: 'webhook' });
  assert.equal((await collaborationDelegationRequirement(card, 'head')).required, true);
});
test('failed or empty delegation cannot satisfy structural completion', async (t) => {
  const state = fixture(t);
  state.rows(cardComments).push({ id: 'request', cardId: 'card', agentId: 'boss', action: 'delegate_request', body: 'Deliver requested work', assigneeAgentId: 'head', delegationStatus: 'failed' });
  assert.equal((await collaborationDelegationRequirement(card, 'boss')).required, true);
  assert.ok(await completionBlockedByChildren(card, 'done'));
});
test('draft company remains editable but execution requires distinct Boss and head', async (t) => {
  const state = fixture(t);
  state.rows(departments)[0]!.headAgentId = 'boss';
  await assert.rejects(dispatchCard('card'), /company_structure_unready.*distinct/i);
});
test('Boss review is goal assessment and does not instruct professional review or repository execution', async (t) => {
  fixture(t);
  const prompt = await buildReviewPrompt({ ...card, assigneeId: 'head', reviewerId: 'boss', columnStatus: 'in_review' }, { continuation: true });
  assert.match(prompt, /goal assessment/i); assert.doesNotMatch(prompt, /You are the professional gate|Score the work 0-10|APPROVE\/DONE if you can finish/);
});
test('failed child insert reports an error and never parks a zero-child parent', async (t) => {
  const state = fixture(t);
  const { db } = await import('./db/client.ts');
  const original = db.insert.bind(db);
  t.mock.method(db, 'insert', ((table: any) => table === kanbanCards ? { values: () => ({ returning: async () => [] }) } : original(table)) as any);
  const result = await processChildSplits(card, boss as any, [{ title: 'Build', body: '## Acceptance\n- Works', assigneeSlug: 'head' }]);
  assert.equal(result.created.length, 0); assert.ok(result.errors.length > 0);
  assert.notEqual(state.rows(kanbanCards)[0]!.rollupStatus, 'waiting_on_children');
});
test('mutable Done children without server acceptance cannot complete a structural parent', async (t) => {
  const state = fixture(t);
  state.rows(kanbanCards).push({ id: 'child', companyId: 'company', parentCardId: 'card', assigneeId: 'head', title: 'Deliver', body: 'Acceptance: works', columnStatus: 'done', childRequirementLevel: 'required' });
  assert.ok(await completionBlockedByChildren(card, 'done'));
});
test('unused headless draft department is actionable without blocking a ready department', async (t) => {
  const state = fixture(t);
  state.rows(departments).push({ id: 'draft', companyId: 'company', name: 'Draft', headAgentId: null });
  assert.equal((await companyExecutionReadiness('company', 'head', 'department')).ready, true);
  assert.equal((await companyExecutionReadiness('company', 'boss', 'draft')).ready, false);
});
test('repeated identical child report returns the original children without duplicate work', async (t) => {
  const state = fixture(t);
  const children: any = [{ title: 'Build', body: '## Acceptance\n- Works', assigneeSlug: 'head' }];
  const first = await processChildSplits(card, boss as any, children);
  assert.equal(first.created.length, 1);
  const repeated = await processChildSplits(card, boss as any, children);
  assert.deepEqual(repeated.errors, []); assert.deepEqual(repeated.created, first.created);
  assert.equal(state.rows(kanbanCards).filter(c => c.parentCardId === 'card').length, 1);
});
test('failure after one child insert rolls back the entire split and leaves parent assignment intact', async t => {
  const state = fixture(t, ['one', 'two'].map(id => ({ id, companyId: 'company', name: id, slug: id, departmentId: 'department', isActive: true, adapterType: 'webhook' })));
  const parent: any = state.rows(kanbanCards)[0]!; parent.assigneeId = 'head';
  const { db } = await import('./db/client.ts');
  const original = db.insert.bind(db); let inserts = 0;
  t.mock.method(db, 'insert', ((table: any) => table === kanbanCards && ++inserts === 2 ? { values: () => ({ returning: async () => [] }) } : original(table)) as any);
  const result = await processChildSplits(parent, head as any, ['one', 'two'].map(assigneeSlug => ({ title: `Work ${assigneeSlug}`, body: '## Acceptance\n- Verified result', assigneeSlug })));
  assert.equal(result.created.length, 0); assert.ok(result.errors.length);
  assert.equal(state.rows(kanbanCards).filter(row => row.parentCardId === parent.id).length, 0);
  assert.equal(parent.assigneeId, 'head'); assert.notEqual(parent.rollupStatus, 'waiting_on_children');
});
