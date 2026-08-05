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

test('needsInput routes to help review with a reviewer, blocks without one', () => {
  const { needsInputCompletionDecision } = dispatchInternals;
  assert.deepEqual(needsInputCompletionDecision('reviewer-1'), { needsHelpReview: true, nextStatus: 'needs_review', topLevelGuidanceAccepted: false });
  assert.deepEqual(needsInputCompletionDecision(null), { needsHelpReview: true, nextStatus: 'blocked', topLevelGuidanceAccepted: false });
});

test('delegationBoundsError enforces depth and fanout limits', () => {
  const { delegationBoundsError } = dispatchInternals;
  assert.equal(delegationBoundsError({ depth: 0, existingInScope: 0, adding: 3, maxDepth: 3, maxFanout: 16 }), null);
  assert.match(delegationBoundsError({ depth: 3, existingInScope: 0, adding: 1, maxDepth: 3, maxFanout: 16 }) ?? '', /^delegation_depth_exceeded/);
  assert.match(delegationBoundsError({ depth: 1, existingInScope: 15, adding: 2, maxDepth: 3, maxFanout: 16 }) ?? '', /^delegation_fanout_exceeded/);
  assert.equal(delegationBoundsError({ depth: 2, existingInScope: 14, adding: 2, maxDepth: 3, maxFanout: 16 }), null);
});

test('workProductRowsFromArtifacts maps uri artifacts and skips text-only ones', () => {
  const { workProductRowsFromArtifacts } = dispatchInternals;
  const card = { id: 'card-1', companyId: 'co-1', projectId: 'proj-1' };
  const rows = workProductRowsFromArtifacts(card as any, 'agent-1', 'run-1', [
    { artifactId: 'a1', name: 'PR', uri: 'https://github.com/x/y/pull/3' },
    { artifactId: 'a2', text: 'inline only' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.url, 'https://github.com/x/y/pull/3');
  assert.equal(rows[0]?.title, 'PR');
  assert.deepEqual(rows[0]?.metadata, { a2aArtifactId: 'a1' });
});
