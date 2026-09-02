import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOVER_CHAR_LIMIT, formatHandoverSection, type HandoverInput, type HandoverRun } from './card-handover.ts';

const at = (iso: string) => new Date(iso);

function input(overrides: Partial<HandoverInput> = {}): HandoverInput {
  return {
    assigneeId: 'agent-ben',
    runs: [],
    handoffs: [],
    reviewFeedback: null,
    latestReview: null,
    humanInstructions: [],
    openQuestions: [],
    products: [],
    ...overrides,
  };
}

const run = (overrides: Partial<HandoverRun> = {}): HandoverRun => ({
  agentId: 'agent-alice',
  agentName: 'Alice',
  kind: 'dispatch',
  status: 'success',
  completedAt: at('2026-09-02T10:12:00Z'),
  durationSeconds: 41,
  output: 'Built the\n\nlanding   page draft.',
  ...overrides,
});

test('formatHandoverSection returns an empty string when nothing happened yet', () => {
  assert.equal(formatHandoverSection(input()), '');
  assert.equal(formatHandoverSection(input({ reviewFeedback: '   ' })), '');
});

test('formatHandoverSection labels the current assignee as you and adapts the closing line', () => {
  const own = formatHandoverSection(input({ runs: [run({ agentId: 'agent-ben', agentName: 'Ben' })] }));
  assert.match(own, /^=== Handover: what happened on this card before this run ===/);
  assert.match(own, /- 2026-09-02 10:12 \| you \| dispatch\/success \| 41s \| Built the landing page draft\./);
  assert.match(own, /You worked this card before; continue from your last output\./);

  const other = formatHandoverSection(input({ runs: [run()] }));
  assert.match(other, /\| Alice \| dispatch\/success/);
  assert.doesNotMatch(other, /You worked this card before/);
  assert.match(other, /Do not redo finished work/);
});

test('formatHandoverSection orders runs newest first and applies the per-list limits', () => {
  const runs = [
    run({ completedAt: at('2026-09-02T08:00:00Z'), output: 'first' }),
    run({ completedAt: at('2026-09-02T11:00:00Z'), output: 'fourth' }),
    run({ completedAt: at('2026-09-02T09:00:00Z'), output: 'second' }),
    run({ completedAt: at('2026-09-02T10:00:00Z'), output: 'third' }),
  ];
  const text = formatHandoverSection(input({
    runs,
    handoffs: Array.from({ length: 5 }, (_, i) => ({ at: at('2026-09-02T09:50:00Z'), fromName: `Owner${i}`, body: `handoff ${i}` })),
    humanInstructions: Array.from({ length: 7 }, (_, i) => ({ at: at('2026-09-02T11:10:00Z'), authorName: 'Ricky', action: 'send_to_agent', body: `instruction ${i}` })),
    openQuestions: Array.from({ length: 7 }, (_, i) => ({ at: null, fromName: 'Alice', body: `question ${i}` })),
    products: Array.from({ length: 8 }, (_, i) => ({ type: 'pull_request', title: `PR #${i}`, url: i === 0 ? 'https://git.example/pr/0' : null })),
    latestReview: { at: at('2026-09-02T11:02:00Z'), reviewerName: 'Cara', action: 'review_rejected', body: 'Missing tests.' },
    reviewFeedback: 'Missing tests.',
  }));
  const runLines = text.split('\n').filter((line) => line.includes('| Alice | dispatch/success'));
  assert.equal(runLines.length, 3);
  assert.match(runLines[0] ?? '', /fourth$/);
  assert.match(runLines[1] ?? '', /third$/);
  assert.match(runLines[2] ?? '', /second$/);
  assert.equal(text.split('\n').filter((line) => line.includes('handed off:')).length, 3);
  assert.equal(text.split('\n').filter((line) => line.includes('Ricky (send_to_agent)')).length, 5);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- from Alice:')).length, 5);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- pull_request:')).length, 6);
  assert.match(text, /- pull_request: PR #0 \(https:\/\/git\.example\/pr\/0\)/);
  assert.match(text, /Latest review: Cara \(review_rejected, 2026-09-02 11:02\): Missing tests\./);
  // Identical review feedback is not repeated as a second line.
  assert.doesNotMatch(text, /Current review feedback on the card/);
});

test('formatHandoverSection shows card review feedback when it differs from the latest review comment', () => {
  const text = formatHandoverSection(input({ reviewFeedback: 'Please add the CSV export.', latestReview: { at: null, reviewerName: 'Cara', action: 'review_note', body: 'Looks fine otherwise.' } }));
  assert.match(text, /Latest review: Cara \(review_note, n\/a\): Looks fine otherwise\./);
  assert.match(text, /Current review feedback on the card: Please add the CSV export\./);
});

test('formatHandoverSection clips the whole section and marks the truncation', () => {
  const text = formatHandoverSection(input({
    runs: [run({ output: 'x'.repeat(5000) }), run({ output: 'y'.repeat(5000) }), run({ output: 'z'.repeat(5000) })],
  }));
  assert.ok(text.length <= HANDOVER_CHAR_LIMIT, `section is ${text.length} chars`);
  assert.match(text, /\[handover truncated\]$/);
});
