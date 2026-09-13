import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskState, taskStateReference } from './task-state-context.ts';

test('fresh task state is readable and does not dump empty fields or an unknown delta', () => {
  const text = formatTaskState({ id: 'task-1', title: 'Build the board', status: 'todo', assignee: 'Alice', updatedAt: '2026-09-13T01:00:00Z', sections: [] });
  assert.match(text, /^## Task state\n/);
  assert.match(text, /- Task: Build the board\n- Card ID: task-1\n- Stage: todo/);
  assert.match(text, /- Assignee: Alice/);
  assert.equal((text.match(/2026-09-13T01:00:00Z/g) ?? []).length, 1);
  assert.doesNotMatch(text, /none|unknown|not set|Delta since|\|/);
  assert.ok(text.length < 240);
});

test('continuation keeps actual blockers, gates, required work and evidence', () => {
  const text = formatTaskState({ id: 'task-2', title: 'Fix the board', status: 'blocked', since: '2026-09-13T02:00:00Z', assignee: 'CTO', reviewer: 'Alice', priority: 2, decisionMode: 'review', requiresApproval: true,
    sections: [{ title: 'Last error', entries: ['Repository denied'] }, { title: 'Required children', entries: ['Child delivery pending'] }, { title: 'Dependencies', entries: ['Missing dependency: dependency-1'] }, { title: 'Review feedback', entries: ['Fix failing move test'] }, { title: 'Work products', entries: ['PR #4 / head abc'] }, { title: 'Messages', entries: [] }],
  });
  for (const marker of ['Changes since 2026-09-13T02:00:00Z', 'Repository denied', 'Child delivery pending', 'dependency-1', 'Fix failing move test', 'PR #4 / head abc', 'Approval required: yes', 'Reviewer: Alice']) assert.ok(text.includes(marker), marker);
  assert.doesNotMatch(text, /### Messages/);
});

test('task references put identity and state on separate readable lines', () => {
  assert.equal(taskStateReference({id:'child-1',title:'Review\nchanges',columnStatus:'in_review'}, 'Ribel'), '- Review changes [in_review]\n  Card ID: child-1; assignee: Ribel');
});
