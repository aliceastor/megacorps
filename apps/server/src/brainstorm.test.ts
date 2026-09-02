import assert from 'node:assert/strict';
import test from 'node:test';
import { brainstormFromOutput, brainstormRoundComplete, formatBrainstormClosed, formatBrainstormOpened, planBrainstormTargets, type BrainstormDepartment } from './brainstorm.ts';

const it: BrainstormDepartment = { id: 'd-it', slug: 'it', name: 'IT', headAgentId: 'cto', description: 'Software and infrastructure' };
const content: BrainstormDepartment = { id: 'd-content', slug: 'content', name: 'Content', headAgentId: 'editor', description: 'Writing and media' };
const civil: BrainstormDepartment = { id: 'd-civil', slug: 'civil', name: 'Civil Engineering', headAgentId: null, description: 'Slopes and structures' };

const base = {
  departments: [it, content, civil],
  askerId: 'ceo',
  askerIsCompanyBoss: true,
  askerIsDepartmentHead: false,
  isOwner: true,
  alreadyPending: false,
  clientMinimumIds: [] as string[],
};

test('brainstormFromOutput normalizes slugs and reads fenced reports', () => {
  assert.deepEqual(brainstormFromOutput('', { broadcast: { departments: [' IT ', 'content', 'it'], question: ' How would you approach a new site? ' } }), { departments: ['it', 'content'], question: 'How would you approach a new site?' });
  const fenced = '```json\n{ "kind": "megacorps-report", "status": "completed", "summary": "x", "broadcast": { "departments": ["content"], "question": "Ideas?" } }\n```';
  assert.equal(brainstormFromOutput(fenced)?.departments[0], 'content');
  assert.equal(brainstormFromOutput('nothing here'), null);
});

test('targets are the named departments that have a head other than the asker', () => {
  const plan = planBrainstormTargets({ ...base, request: { departments: ['it', 'content'], question: 'Ideas?' } });
  assert.ok(plan.ok);
  assert.deepEqual(plan.targets.map((target) => target.headAgentId), ['cto', 'editor']);
});

test('unknown or headless departments and ineligible askers are rejected with reasons', () => {
  const unknown = planBrainstormTargets({ ...base, request: { departments: ['marketing'], question: 'Ideas?' } });
  assert.ok(!unknown.ok && /brainstorm_department_unknown/.test(unknown.errors.join()));
  const headless = planBrainstormTargets({ ...base, request: { departments: ['civil'], question: 'Ideas?' } });
  assert.ok(!headless.ok && /brainstorm_department_headless/.test(headless.errors.join()));
  const member = planBrainstormTargets({ ...base, askerIsCompanyBoss: false, request: { departments: ['it'], question: 'Ideas?' } });
  assert.ok(!member.ok && /brainstorm_not_allowed/.test(member.errors.join()));
  const pending = planBrainstormTargets({ ...base, alreadyPending: true, request: { departments: ['it'], question: 'Ideas?' } });
  assert.ok(!pending.ok && /brainstorm_round_in_progress/.test(pending.errors.join()));
});

test('the client pre-selection is a floor the asker cannot go below', () => {
  const plan = planBrainstormTargets({ ...base, clientMinimumIds: ['d-content'], request: { departments: ['it'], question: 'Ideas?' } });
  assert.ok(!plan.ok && /brainstorm_client_minimum: .*Content/.test(plan.errors.join()));
  const ok = planBrainstormTargets({ ...base, clientMinimumIds: ['d-content'], request: { departments: ['it', 'content'], question: 'Ideas?' } });
  assert.ok(ok.ok);
});

test('asking your own department is skipped rather than failed', () => {
  const plan = planBrainstormTargets({ ...base, askerId: 'cto', askerIsCompanyBoss: false, askerIsDepartmentHead: true, request: { departments: ['it', 'content'], question: 'Ideas?' } });
  assert.ok(plan.ok && plan.targets.length === 1 && plan.targets[0]?.department.slug === 'content');
});

test('a round closes when all answered or when the timeout passes', () => {
  const opened = new Date('2026-09-02T09:00:00Z');
  const minutes = (n: number) => new Date(opened.getTime() + n * 60_000);
  assert.deepEqual(brainstormRoundComplete({ statuses: ['done', 'failed'], openedAt: opened, now: minutes(5), timeoutMinutes: 30 }), { complete: true, reason: 'all_answered' });
  assert.deepEqual(brainstormRoundComplete({ statuses: ['done', 'queued'], openedAt: opened, now: minutes(10), timeoutMinutes: 30 }), { complete: false, reason: null });
  assert.deepEqual(brainstormRoundComplete({ statuses: ['done', 'running'], openedAt: opened, now: minutes(31), timeoutMinutes: 30 }), { complete: true, reason: 'timeout' });
});

test('board messages list who was consulted and who stayed silent', () => {
  const opened = formatBrainstormOpened(1, 'Ideas?', [{ departmentName: 'IT', headName: 'CTO' }]);
  assert.match(opened, /Brainstorm round 1 opened/);
  assert.match(opened, /- IT \(head: CTO\)/);
  const closed = formatBrainstormClosed(1, 'timeout', ['IT'], ['Content']);
  assert.match(closed, /timed out/);
  assert.match(closed, /Consulted but silent: Content/);
});
