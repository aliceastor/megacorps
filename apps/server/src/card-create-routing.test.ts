import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, companyMemberships, departments, positions, kanbanCards, users, activityLog, cardActions, taskLogs } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';
import { dispatchInternals } from './dispatch.ts';
import { structuralAssignment, structuralReviewer, structuralCompletionIssue } from './company-workflow.ts';
import { normalizeAgentResult } from './agent-results.ts';

async function fixture(t: any) {
  const companyId = randomUUID(), foreignCompany = randomUUID(), bossId = randomUUID(), headId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const foreignAgent = randomUUID(), foreignDepartment = randomUUID();
  const user = { id: randomUUID(), email: 'operator@example.test', role: 'operator', status: 'active' };
  const parent = { id: randomUUID(), companyId: foreignCompany, title: 'Foreign completed parent', columnStatus: 'done', updatedAt: new Date() };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Alpha' }, { id: foreignCompany, name: 'Beta' }]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId, role: 'operator', status: 'active' }]], [positions, [{ id: positionId, companyId, isCompanyBoss: true }]], [departments, [{ id: departmentId, companyId, name: 'Engineering', headAgentId: headId }, { id: foreignDepartment, companyId: foreignCompany, name: 'Foreign' }]], [agents, [{ id: bossId, companyId, positionId, name: 'Boss', isActive: true, adapterType: 'webhook' }, { id: headId, companyId, departmentId, name: 'Head', isActive: true, adapterType: 'webhook' }, { id: foreignAgent, companyId: foreignCompany, name: 'Foreign', isActive: true, adapterType: 'webhook' }]], [kanbanCards, [parent]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  return { app, state, companyId, bossId, headId, departmentId, foreignAgent, foreignDepartment, parent, headers: { cookie: `session=${await signSession(user)}` } };
}

test('plain human goal creates without invented review gates and enters normal structural routing', async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: 'POST', url: '/api/cards', headers: f.headers, payload: { companyId: f.companyId, title: 'Make reports easier to read', body: 'People should find the results and the next step quickly.' } });
  assert.equal(response.statusCode, 201, response.body);
  const card = f.state.rows(kanbanCards).find(row => row.id === response.json().id)!;
  assert.equal(card.requiresApproval, false); assert.equal(card.reviewerId, null); assert.equal(card.assigneeId, null);
  const assigned = await dispatchInternals.ensureAssigned(card as any, 'manual');
  assert.equal(assigned?.assigneeId, f.bossId);
  const strategy = await structuralAssignment(f.companyId, f.bossId);
  assert.equal(strategy.delegationRequired, true); assert.deepEqual(strategy.available.map(a => a.id), [f.headId]);
  const head = await structuralAssignment(f.companyId, f.headId);
  assert.equal(head.delegationRequired, false);
  assert.equal(await structuralReviewer(f.companyId, f.headId), f.bossId);
  assert.match((await structuralCompletionIssue({ companyId: f.companyId }, f.headId, normalizeAgentResult({ report: { kind: 'megacorps-report', status: 'completed', summary: 'Done' } })))!, /sole_head_self_check_required/);
});

for (const [field, expected] of [['parentCardId', 'parent_card_company_mismatch'], ['reviewerIds', 'reviewer_company_mismatch'], ['brainstormDepartmentIds', 'department_company_mismatch']] as const) test(`POST rejects foreign ${field} before child insertion or parent/audit mutation`, async t => {
  const f = await fixture(t); const before = structuredClone(f.parent);
  const value = field === 'parentCardId' ? f.parent.id : field === 'reviewerIds' ? [f.foreignAgent] : [f.foreignDepartment];
  const response = await f.app.inject({ method: 'POST', url: '/api/cards', headers: f.headers, payload: { companyId: f.companyId, title: 'Attempt', body: 'Do work', requiresApproval: true, [field]: value } });
  assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error, expected);
  assert.deepEqual(f.parent, before); assert.equal(f.state.rows(kanbanCards).length, 1);
  for (const table of [activityLog, cardActions, taskLogs]) assert.equal(f.state.rows(table).length, 0);
});

for (const field of ['reviewerIds', 'brainstormDepartmentIds'] as const) test(`PUT validates supplied ${field} and preserves omitted arrays`, async t => {
  const f = await fixture(t); const value = field === 'reviewerIds' ? [f.headId] : [f.departmentId];
  const created = await f.app.inject({ method: 'POST', url: '/api/cards', headers: f.headers, payload: { companyId: f.companyId, title: 'Valid', body: 'Do work', requiresApproval: true, [field]: value } });
  assert.equal(created.statusCode, 201, created.body);
  const url = `/api/cards/${created.json().id}`;
  const rejected = await f.app.inject({ method: 'PUT', url, headers: f.headers, payload: { [field]: [field === 'reviewerIds' ? f.foreignAgent : f.foreignDepartment] } });
  assert.equal(rejected.statusCode, 400, rejected.body);
  const edited = await f.app.inject({ method: 'PUT', url, headers: f.headers, payload: { title: 'Unrelated edit' } });
  assert.equal(edited.statusCode, 200, edited.body); assert.deepEqual(edited.json()[field], value);
});
