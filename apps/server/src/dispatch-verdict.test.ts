import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInternals } from './dispatch.ts';

const { reviewDecision, resolveReviewVerdict } = dispatchInternals;

test('reviewDecision returns null when no verdict is present in either mode', () => {
  const chatty = 'I looked over the changes and the general direction is quite interesting.';
  assert.equal(reviewDecision(chatty, 'quality'), null);
  assert.equal(reviewDecision(chatty, 'help'), null);
});

test('explicit verdict lines are still recognized', () => {
  assert.equal(reviewDecision('VERDICT: APPROVED', 'quality'), 'approved');
  assert.equal(reviewDecision('REJECT - REVISION_REQUESTED: missing artifact', 'quality'), 'revision_requested');
});

test('keyword-tier verdicts are still recognized', () => {
  assert.equal(reviewDecision('PASS', 'quality'), 'approved');
  assert.equal(reviewDecision('This needs rework before merging.', 'quality'), 'revision_requested');
  assert.equal(reviewDecision('I cannot resolve this, escalate to my manager.', 'help'), 'escalate');
});

test('structured report verdict wins over prose keywords', () => {
  const report = JSON.stringify({
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'review done',
    verdict: 'revision_requested',
  });
  const output = `The work is approved and done overall, but see the report.\n\`\`\`json\n${report}\n\`\`\``;
  assert.equal(resolveReviewVerdict(output, 'quality'), 'revision_requested');
});

test('resolveReviewVerdict returns null for chatty output without any verdict', () => {
  assert.equal(resolveReviewVerdict('Overall the direction is intriguing; let me summarize what I saw.', 'quality'), null);
});
