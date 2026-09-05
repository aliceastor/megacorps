import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanySchema, createDepartmentSchema, updateCompanySchema, updateDepartmentSchema } from '@megacorps/shared';
import { randomUUID } from 'node:crypto';
import { companies, departments, positions, agents, knowledgeDocs, kanbanCards } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { buildReviewPrompt } from './dispatch.ts';
import { CEO_PLAYBOOK, DEPARTMENT_HEAD_PLAYBOOK } from './role-playbooks.ts';
import { buildCompanyKnowledge } from './company-context.ts';
test('common knowledge stays within total and document budgets with explicit selection metadata', async t => {
  memoryDb(t, [[knowledgeDocs, Array.from({ length: 25 }, (_, i) => ({ id: `doc-${i}`, title: `Document ${i}`, companyId: 'company', tags: [], body: 'x'.repeat(8000), updatedAt: new Date() }))]]);
  const result = await buildCompanyKnowledge('company');
  assert.ok(result.text.length <= 20000, `${result.text.length} exceeds total budget`);
  assert.ok(result.selected.every(doc => doc.truncated));
  assert.equal(result.omitted, true); assert.match(result.text, /omitted by context budget/);
});

test('optional role prompts persist independently, bounded at 8000, and partial updates omit them', () => {
  assert.equal((createCompanySchema.parse({ name: 'Firm', slug: 'firm', bossRolePrompt: 'Focus on outcomes' }) as any).bossRolePrompt, 'Focus on outcomes');
  assert.equal((createDepartmentSchema.parse({ companyId: randomUUID(), name: 'Engineering', slug: 'engineering', headRolePrompt: 'Check the tests' }) as any).headRolePrompt, 'Check the tests');
  assert.equal(updateCompanySchema.safeParse({ bossRolePrompt: 'x'.repeat(8001) }).success, false);
  assert.equal(updateDepartmentSchema.safeParse({ headRolePrompt: 'x'.repeat(8001) }).success, false);
  assert.ok(!('bossRolePrompt' in updateCompanySchema.parse({ name: 'Changed' })));
  assert.ok(!('headRolePrompt' in updateDepartmentSchema.parse({ name: 'Changed' })));
});
test('built-in procedure makes Boss strategy-only and sole head execution explicit', () => {
  assert.doesNotMatch(CEO_PLAYBOOK, /Confirm direction with the client before|produce the deliverable|never mark a goal done that the client has not accepted/i);
  assert.match(CEO_PLAYBOOK, /reasonable assumptions/i);
  assert.match(DEPARTMENT_HEAD_PLAYBOOK, /sole head|no employees/i);
  assert.doesNotMatch(DEPARTMENT_HEAD_PLAYBOOK, /may do small items yourself/);
});
test('review continuation refreshes current role and bounded relevant knowledge despite newer unrelated docs', async (t) => {
  const card: any = { id: 'card', companyId: 'company', title: 'Review', body: 'Acceptance: works', reviewerId: 'head', tags: ['EnGiNeErInG'], columnStatus: 'in_review', dependencyCardIds: [] };
  const docs = [ ...Array.from({ length: 30 }, (_, i) => ({ id: `other-${i}`, companyId: 'company', title: 'Unrelated', tags: ['sales'], body: 'Unrelated content', updatedAt: new Date(2026, 8, 5) })), { id: 'relevant', companyId: 'company', title: 'Old engineering', tags: ['ENGINEERING'], body: 'Useful old instructions', updatedAt: new Date('2026-08-01T00:00:00Z') }, { id: 'general', companyId: 'company', title: 'General', tags: ['GENERAL'], body: 'General company rules', updatedAt: new Date('2026-08-01T00:00:00Z') }, { id: 'empty', companyId: 'company', title: 'Empty tags', tags: [], body: 'Untagged company rules', updatedAt: new Date('2026-08-01T00:00:00Z') }, { id: 'foreign', companyId: 'foreign', title: 'Foreign', tags: [], body: 'Cross-company forbidden', updatedAt: new Date() } ];
  const state = memoryDb(t, [[companies, [{ id: 'company', name: 'Acme' }]], [departments, [{ id: 'department', companyId: 'company', name: 'Engineering', headAgentId: 'head', headRolePrompt: 'Custom head responsibility' }]], [agents, [{ id: 'head', companyId: 'company', name: 'Head', departmentId: 'department' }]], [knowledgeDocs, docs], [kanbanCards, [card]]]);
  const prompt = await buildReviewPrompt(card, { continuation: true });
  assert.match(prompt, /Custom head responsibility/); assert.match(prompt, /Acme/); assert.match(prompt, /Engineering/);
  for (const expected of ['Useful old instructions', 'General company rules', 'Untagged company rules', 'relevant', '2026-08-01']) assert.ok(prompt.includes(expected), expected);
  assert.doesNotMatch(prompt, /Unrelated content|Cross-company forbidden/);
  state.rows(knowledgeDocs).find(d => d.id === 'relevant')!.body = 'Edited current instructions';
  assert.match(await buildReviewPrompt(card, { continuation: true }), /Edited current instructions/);
});
