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

test('normal dispatch completion enters quality review when a reviewer exists', () => {
  const decision = dispatchInternals.dispatchCompletionDecision('Completed the requested implementation.', 'reviewer-1');
  assert.equal(decision.needsHelpReview, false);
  assert.equal(decision.nextStatus, 'in_review');
});

test('external completion reports respect the quality review gate', () => {
  assert.equal(dispatchInternals.completionStatusForQualityGate('done', 'reviewer-1'), 'in_review');
  assert.equal(dispatchInternals.completionStatusForQualityGate('success', 'reviewer-1'), 'in_review');
  assert.equal(dispatchInternals.completionStatusForQualityGate('in_review', null), 'done');
  assert.equal(dispatchInternals.completionStatusForQualityGate('done', null), 'done');
});

test('parent completion policy blocks incomplete required child cards', () => {
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_required_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'in_progress', childRequirementLevel: 'required', estimatedWeight: null },
    ],
  ), false);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_required_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'todo', childRequirementLevel: 'optional', estimatedWeight: null },
    ],
  ), true);
});

test('parent completion policy supports non-cancelled and threshold rules', () => {
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'all_non_cancelled_accepted' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: null },
      { columnStatus: 'cancelled', childRequirementLevel: 'required', estimatedWeight: null },
    ],
  ), true);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'threshold' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: '8' },
      { columnStatus: 'todo', childRequirementLevel: 'required', estimatedWeight: '2' },
    ],
  ), true);
  assert.equal(dispatchInternals.childCompletionPolicySatisfied(
    { requiredChildPolicy: 'threshold' },
    [
      { columnStatus: 'done', childRequirementLevel: 'required', estimatedWeight: '7' },
      { columnStatus: 'todo', childRequirementLevel: 'required', estimatedWeight: '3' },
    ],
  ), false);
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
