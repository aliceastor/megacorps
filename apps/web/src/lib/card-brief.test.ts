import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRIEF_SECTIONS, acceptanceItems, acceptanceOf, briefGaps, briefTemplate, hasAcceptance, insertBriefTemplate, parseCardBrief } from './card-brief.ts';

// The client copy of apps/server/src/card-brief.ts. The server decides whether
// a child card may be split (hasAcceptance) and what reviewers judge against,
// so the two files must agree on the headings and the template; the last test
// reads the server file from disk and fails when they drift.

const SERVER_BRIEF = fileURLToPath(new URL('../../../server/src/card-brief.ts', import.meta.url));

const FULL = [
  '## Goal',
  'Ship the CSV export.',
  '',
  '## Background',
  'Support asks for it weekly.',
  '',
  '## Changes',
  '1. Add the export button',
  '2. Stream the rows',
  '',
  '## Out of scope',
  '- The scheduled email digest',
  '',
  '## Constraints',
  '- No new dependencies',
  '',
  '## Acceptance',
  '- [ ] the button downloads a file',
  '- [x] 10k rows stream without timing out',
].join('\n');

test('parses the six sections and reports what is missing', () => {
  const brief = parseCardBrief(FULL);
  assert.equal(brief.goal, 'Ship the CSV export.');
  assert.equal(brief.changes, '1. Add the export button\n2. Stream the rows');
  assert.deepEqual(brief.missing, []);
  assert.deepEqual(brief.present, ['goal', 'background', 'changes', 'outOfScope', 'constraints', 'acceptance']);

  const partial = parseCardBrief('## Goal\nDo the thing.\n\n## Acceptance\n- [ ] it works');
  assert.deepEqual(partial.missing, ['background', 'changes', 'outOfScope', 'constraints']);
  assert.equal(partial.background, null);
});

test('accepts Chinese headings, other heading levels and a trailing colon', () => {
  const brief = parseCardBrief('# 目標\n把報表做出來\n\n### 驗收條件:\n- [ ] 匯出成功\n\n## 範圍外\n- 排程寄送');
  assert.equal(brief.goal, '把報表做出來');
  assert.equal(brief.acceptance, '- [ ] 匯出成功');
  assert.equal(brief.outOfScope, '- 排程寄送');
});

test('a non-brief heading closes the current section instead of extending it', () => {
  const brief = parseCardBrief('## Goal\nkeep this\n\n## Notes\nnot the goal');
  assert.equal(brief.goal, 'keep this');
  assert.ok(!brief.missing.includes('goal'));
});

test('acceptance falls back to a checklist, then to a paragraph, and an empty heading counts as none', () => {
  assert.equal(acceptanceOf(FULL), '- [ ] the button downloads a file\n- [x] 10k rows stream without timing out');
  assert.equal(acceptanceOf('Build it.\n\n- [ ] tests pass\n- [x] docs updated'), '- [ ] tests pass\n- [x] docs updated');
  assert.equal(acceptanceOf('Do the work.\n\nAcceptance: the page renders under 200ms.'), 'Acceptance: the page renders under 200ms.');
  assert.equal(acceptanceOf('## Acceptance\n\n'), null);
  assert.equal(acceptanceOf('## Acceptance\n- [ ]   '), null, 'an empty checkbox states nothing');
  assert.equal(acceptanceOf('Just a description with no criteria.'), null);
  assert.equal(hasAcceptance(FULL), true);
  assert.equal(hasAcceptance(''), false);
});

test('briefGaps flags an Acceptance heading that states nothing', () => {
  assert.deepEqual(briefGaps(FULL), []);
  assert.deepEqual(briefGaps('## Goal\nx\n\n## Acceptance\n'), ['background', 'changes', 'outOfScope', 'constraints', 'acceptance']);
  assert.ok(briefGaps('## Acceptance\n- [ ] works').includes('goal'));
});

test('the template round-trips and never overwrites an existing body', () => {
  const parsed = parseCardBrief(briefTemplate());
  assert.deepEqual(parsed.missing, [], 'every section heading is in the template');
  assert.equal(hasAcceptance(briefTemplate()), false, 'the template ships empty criteria');
  assert.equal(insertBriefTemplate(''), briefTemplate());
  assert.equal(insertBriefTemplate('   '), briefTemplate());
  const appended = insertBriefTemplate('Existing notes.');
  assert.ok(appended.startsWith('Existing notes.\n\n## Goal'), appended.slice(0, 40));
});

test('acceptance items become a checklist and drop empty boxes', () => {
  assert.deepEqual(acceptanceItems('- [ ] first\n- [x] second\nplain line\n- [ ]   \n'), [
    { text: 'first', checked: false },
    { text: 'second', checked: true },
    { text: 'plain line', checked: null },
  ]);
  assert.deepEqual(acceptanceItems(null), []);
});

test('the heading table and the template match the server copy', () => {
  const server = readFileSync(SERVER_BRIEF, 'utf8');
  for (const section of BRIEF_SECTIONS) {
    for (const heading of section.headings) {
      assert.ok(server.includes(`'${heading}'`), `server card-brief.ts is missing the heading ${heading}`);
    }
  }
  const templateLine = /return \[([\s\S]*?)\]\.join\('\\n'\);/.exec(server.slice(server.indexOf('export function briefTemplate')));
  assert.ok(templateLine, 'server briefTemplate not found');
  const serverTemplate = [...(templateLine[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]).join('\n');
  assert.equal(serverTemplate, briefTemplate(), 'client and server brief templates drifted');
});
