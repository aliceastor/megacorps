import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInternals } from './dispatch.ts';

test('top-level guidance requests are accepted as done when no reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('needs_review: server callback is unreachable, final answer follows.', null);
  assert.equal(decision.needsHelpReview, true);
  assert.equal(decision.nextStatus, 'done');
  assert.equal(decision.topLevelGuidanceAccepted, true);
});

test('guidance requests still queue review when a reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('needs reviewer guidance on the blocker.', 'reviewer-1');
  assert.equal(decision.nextStatus, 'needs_review');
  assert.equal(decision.topLevelGuidanceAccepted, false);
});

test('delegation parser only accepts explicit delegation blocks', () => {
  assert.deepEqual(dispatchInternals.delegationItems('IDEA 1: Build a music app\n- not a company task'), []);
  assert.deepEqual(dispatchInternals.delegationItems('DELEGATE:\n- Build the UI shell\n- Wire the backend API\n\nSTATUS:\nwaiting'), ['Build the UI shell', 'Wire the backend API']);
});

test('delegation parser accepts webhook summary plus output payloads', () => {
  const webhookPayload = [
    'I will split this across direct reports.',
    '',
    'DELEGATE:',
    '- Ribel: Generate 20 raw product ideas',
    '- Score and cluster the strongest concepts',
    '',
    'Do not mark the parent done yet.',
  ].join('\n');
  assert.deepEqual(dispatchInternals.delegationItems(webhookPayload), [
    'Ribel: Generate 20 raw product ideas',
    'Score and cluster the strongest concepts',
  ]);
});
