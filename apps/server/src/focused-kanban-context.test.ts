import assert from 'node:assert/strict';
import test from 'node:test';
import { companies, projects, kanbanCards, goals, cardComments, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { buildCompanyKanbanContext } from './dispatch.ts';

function fixture(t: Parameters<typeof memoryDb>[0]) {
  const focus: any = { id: 'focus', companyId: 'c', projectId: 'p', title: 'Research APK', body: 'CURRENT_OBJECTIVE\n## Acceptance\nKEEP_EXACT_ACCEPTANCE', columnStatus: 'todo', parentCardId: 'parent', dependencyCardIds: ['dependency'], tags: [], lastError: 'CURRENT_BLOCKER', reviewFeedback: 'CURRENT_REVIEW_FEEDBACK' };
  const state = memoryDb(t, [
    [companies, [{ id: 'c', name: 'Firm' }]],
    [projects, [{ id: 'p', companyId: 'c', name: 'Research', repoUrl: 'https://git.example/firm/research' }, { id: 'other-project', companyId: 'c', name: 'Other project' }]],
    [goals, [{ id: 'other-goal', companyId: 'c', projectId: 'other-project', title: 'Other goal', body: 'UNRELATED_GOAL_BODY'.repeat(200) }]],
    [kanbanCards, [
      focus,
      { ...focus, id: 'parent', parentCardId: null, title: 'PARENT_OBJECTIVE', body: 'Parent scope', dependencyCardIds: [] },
      { ...focus, id: 'dependency', parentCardId: null, title: 'REQUIRED_DEPENDENCY', body: 'Dependency scope', columnStatus: 'done', dependencyCardIds: [] },
      { ...focus, id: 'child', parentCardId: 'focus', title: 'REQUIRED_CHILD', body: 'Child scope', dependencyCardIds: [] },
      ...Array.from({ length: 100 }, (_, i) => ({ ...focus, id: 'old-'+i, parentCardId: null, title: 'UNRELATED_HISTORY_'+i, body: 'OLD_INSTRUCTIONS'.repeat(200), columnStatus: 'done', dependencyCardIds: [] })),
      { ...focus, id: 'foreign', companyId: 'foreign', title: 'FOREIGN_SECRET' },
    ]],
    [cardComments, [{ id: 'human-note', cardId: 'focus', authorType: 'user', action: 'comment', body: 'CURRENT_HUMAN_INSTRUCTION', createdAt: new Date() }]],
    [workProducts, [{ id: 'artifact', cardId: 'focus', type: 'file', title: 'Current artifact', url: 'https://git.example/current-revision', summary: 'CURRENT_EVIDENCE', createdAt: new Date() }]],
  ]);
  return { state, focus };
}

test('focused injection preserves current scope, blockers and evidence without unrelated board rows', async t => {
  fixture(t);
  const prompt = await buildCompanyKanbanContext('c', { focusCardId: 'focus' });
  for (const required of ['CURRENT_OBJECTIVE', 'KEEP_EXACT_ACCEPTANCE', 'CURRENT_BLOCKER', 'CURRENT_REVIEW_FEEDBACK', 'CURRENT_HUMAN_INSTRUCTION', 'CURRENT_EVIDENCE', 'PARENT_OBJECTIVE', 'REQUIRED_DEPENDENCY', 'REQUIRED_CHILD', 'Other project', 'Other goal']) assert.ok(prompt.includes(required), required);
  assert.doesNotMatch(prompt, /UNRELATED_HISTORY_|OLD_INSTRUCTIONS|UNRELATED_GOAL_BODY|FOREIGN_SECRET/);
  assert.match(prompt, /\/api\/cards\/focus\/context/);
  assert.match(prompt, /authenticated.*(?:session|user)/i);
  assert.ok(prompt.length < 12000, `focused prompt ${prompt.length} characters`);
});

test('current acceptance is not crowded out by company history under the minimum context budget', async t => {
  fixture(t);
  const prompt = await buildCompanyKanbanContext('c', { focusCardId: 'focus', budgetChars: 8000 });
  assert.match(prompt, /KEEP_EXACT_ACCEPTANCE/);
  assert.match(prompt, /CURRENT_BLOCKER/);
  assert.match(prompt, /REQUIRED_DEPENDENCY/);
});