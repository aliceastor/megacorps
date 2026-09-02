import test from 'node:test';
import assert from 'node:assert/strict';
import { CEO_PLAYBOOK, CEO_POSITION_PROMPT, DEPARTMENT_HEAD_PLAYBOOK, LEGACY_CEO_POSITION_PROMPT, MEMBER_PLAYBOOK, POSITION_TEMPLATES, REVIEWER_PLAYBOOK, playbookFor, positionTemplate, structuralRole } from './role-playbooks.ts';

test('structural role: boss wins over head, head over member', () => {
  assert.equal(structuralRole({ isCompanyBoss: true, isDepartmentHead: true }), 'ceo');
  assert.equal(structuralRole({ isCompanyBoss: false, isDepartmentHead: true }), 'department_head');
  assert.equal(structuralRole({ isCompanyBoss: false, isDepartmentHead: false }), 'member');
});

test('each playbook teaches the moves the pipeline depends on', () => {
  assert.equal(playbookFor('ceo'), CEO_PLAYBOOK);
  assert.equal(playbookFor('department_head'), DEPARTMENT_HEAD_PLAYBOOK);
  assert.equal(playbookFor('member'), MEMBER_PLAYBOOK);
  // CEO: brainstorm, direction checkpoint, split by department, integrate.
  for (const phrase of ['report.broadcast', 'kind=direction', 'one child card per involved department', 'integrate']) assert.ok(CEO_PLAYBOOK.includes(phrase), phrase);
  // Head: resource view, reviewer not the assignee, rubric.
  for (const phrase of ['resource view', 'reviewer who is not that member', '0-10']) assert.ok(DEPARTMENT_HEAD_PLAYBOOK.includes(phrase), phrase);
  // Member: no client contact, no unsanctioned splits.
  assert.ok(MEMBER_PLAYBOOK.includes('Do not ask the client'));
  assert.ok(MEMBER_PLAYBOOK.includes('Do not split or delegate unless'));
  // Reviewer: quality gate only, goal judgement belongs upstream.
  assert.ok(REVIEWER_PLAYBOOK.includes('acceptance criteria'));
  assert.ok(REVIEWER_PLAYBOOK.includes('not yours'));
  const distinct = new Set([CEO_PLAYBOOK, DEPARTMENT_HEAD_PLAYBOOK, MEMBER_PLAYBOOK, REVIEWER_PLAYBOOK]);
  assert.equal(distinct.size, 4);
});

test('position templates: unique keys and slugs, exactly one boss, reviewers carry a domain', () => {
  assert.equal(new Set(POSITION_TEMPLATES.map((template) => template.key)).size, POSITION_TEMPLATES.length);
  assert.equal(new Set(POSITION_TEMPLATES.map((template) => template.slug)).size, POSITION_TEMPLATES.length);
  assert.equal(POSITION_TEMPLATES.filter((template) => template.isCompanyBoss).length, 1);
  for (const template of POSITION_TEMPLATES) {
    assert.ok(template.prompt.length > 80, `${template.key} prompt too thin`);
    assert.match(template.slug, /^[a-z0-9-]+$/);
    if (template.key.endsWith('_reviewer')) assert.ok(template.reviewDomain, `${template.key} needs a review domain`);
  }
  assert.equal(positionTemplate('ceo')?.isCompanyBoss, true);
  assert.equal(positionTemplate('nope'), undefined);
});

test('CEO seed prompt comes from the template and differs from the legacy placeholder', () => {
  assert.equal(CEO_POSITION_PROMPT, positionTemplate('ceo')?.prompt);
  assert.notEqual(CEO_POSITION_PROMPT, LEGACY_CEO_POSITION_PROMPT);
  assert.equal(LEGACY_CEO_POSITION_PROMPT, 'Own final company-level task confirmation, decomposition, escalation, and integration.');
});
