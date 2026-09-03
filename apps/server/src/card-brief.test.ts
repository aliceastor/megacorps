import assert from 'node:assert/strict';
import test from 'node:test';
import { BRIEF_SECTIONS, acceptanceOf, briefTemplate, formatBriefCoverage, hasAcceptance, parseCardBrief } from './card-brief.ts';

const english = [
  '## Goal',
  'Ship the export button.',
  '',
  '## Changes',
  '- add the button',
  '- wire the endpoint',
  '',
  '### Acceptance',
  '- [ ] button visible on the report page',
  '- [ ] CSV downloads with all columns',
  '',
  '## Notes',
  'not part of the brief',
].join('\n');

test('English headings parse into sections and the absent ones are listed as missing', () => {
  const brief = parseCardBrief(english);
  assert.equal(brief.goal, 'Ship the export button.');
  assert.match(brief.changes ?? '', /wire the endpoint/);
  assert.match(brief.acceptance ?? '', /CSV downloads/);
  assert.doesNotMatch(brief.acceptance ?? '', /not part of the brief/);
  assert.deepEqual(brief.present, ['goal', 'changes', 'acceptance']);
  assert.deepEqual(brief.missing, ['background', 'outOfScope', 'constraints']);
});

test('Chinese headings, mixed case and trailing colons are recognized', () => {
  const brief = parseCardBrief(['# 目標:', '做出匯出鍵', '## 背景', '客戶要求', '## 變更', '- 加按鈕', '## 範圍外', '- 不做 PDF', '## 限制', '- 不改 schema', '## 驗收標準', '- [ ] 能下載 CSV'].join('\n'));
  assert.equal(brief.goal, '做出匯出鍵');
  assert.equal(brief.background, '客戶要求');
  assert.equal(brief.outOfScope, '- 不做 PDF');
  assert.equal(brief.constraints, '- 不改 schema');
  assert.match(brief.acceptance ?? '', /CSV/);
  assert.deepEqual(brief.missing, []);
  assert.equal(parseCardBrief('## ACCEPTANCE CRITERIA\n- [x] done').acceptance, '- [x] done');
});

test('acceptanceOf prefers the Acceptance section over checklists elsewhere in the body', () => {
  const body = ['## Changes', '- [ ] refactor first', '', '## Acceptance', 'All endpoints return 200 under the smoke test.'].join('\n');
  assert.equal(acceptanceOf(body), 'All endpoints return 200 under the smoke test.');
});

test('without a heading, checklist lines count as the acceptance criteria', () => {
  const body = 'Build the widget.\n\n- [ ] renders on mobile\n- [x] unit tests pass\n* [ ] docs updated';
  assert.equal(acceptanceOf(body), '- [ ] renders on mobile\n- [x] unit tests pass\n* [ ] docs updated');
  assert.equal(hasAcceptance(body), true);
});

test('without a heading or checklist, a paragraph that talks about acceptance is used', () => {
  assert.equal(acceptanceOf('Do the thing.\n\nAcceptance: tests green and the page renders the list.'), 'Acceptance: tests green and the page renders the list.');
  assert.equal(acceptanceOf('先做\n\n驗收:能跑通 smoke test'), '驗收:能跑通 smoke test');
});

test('plain prose without criteria has no acceptance, and an empty checkbox does not count', () => {
  assert.equal(acceptanceOf('Build the thing end to end and make it look nice, with tests and docs.'), null);
  assert.equal(hasAcceptance('## Acceptance\n- [ ] '), false);
  assert.equal(hasAcceptance(''), false);
  assert.equal(hasAcceptance(null), false);
});

test('the template round-trips through the parser with every section present', () => {
  const brief = parseCardBrief(briefTemplate());
  assert.deepEqual(brief.missing, []);
  assert.deepEqual(brief.present, BRIEF_SECTIONS.map((section) => section.key));
  const filled = briefTemplate().replace('- [ ] ', '- [ ] the export downloads');
  assert.equal(acceptanceOf(filled), '- [ ] the export downloads');
});

test('a foreign heading ends the previous section', () => {
  const brief = parseCardBrief('## Goal\nA\n## Something else\nB\n## Background\nC');
  assert.equal(brief.goal, 'A');
  assert.equal(brief.background, 'C');
});

test('formatBriefCoverage is a single readable line', () => {
  assert.equal(formatBriefCoverage(parseCardBrief(english)), 'Brief sections present: goal, changes, acceptance; missing: background, out of scope, constraints.');
  assert.equal(formatBriefCoverage(parseCardBrief('just prose')), 'Brief sections present: none; missing: goal, background, changes, out of scope, constraints, acceptance.');
});
