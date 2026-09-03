import assert from 'node:assert/strict';
import test from 'node:test';
import { externalEventNextStatus } from './external-events.ts';

// The status table the session route, the Gitea receiver and the timeout
// sweep now share. It used to be inline in POST /api/external-events.
const reviewed = { columnStatus: 'waiting_on_external', reviewerId: 'reviewer-uuid', assigneeId: 'assignee-uuid' };
const unreviewed = { columnStatus: 'waiting_on_external', reviewerId: null, assigneeId: 'assignee-uuid' };
const orphan = { columnStatus: 'waiting_on_external', reviewerId: null, assigneeId: null };

test('success wakes a card into review when it has a reviewer, otherwise done', () => {
  assert.equal(externalEventNextStatus(reviewed, 'success'), 'in_review');
  assert.equal(externalEventNextStatus(unreviewed, 'success'), 'done');
});

test('the merge gate can override success straight to done', () => {
  assert.equal(externalEventNextStatus(reviewed, 'success', 'done'), 'done');
  assert.equal(externalEventNextStatus(unreviewed, 'success', 'done'), 'done');
});

test('failure and cancellation return the card to its assignee, or block it', () => {
  assert.equal(externalEventNextStatus(reviewed, 'failure'), 'in_progress');
  assert.equal(externalEventNextStatus(reviewed, 'cancelled'), 'in_progress');
  assert.equal(externalEventNextStatus(orphan, 'failure'), 'blocked');
});

test('timeout always blocks, and waiting/info leave the card where it is', () => {
  assert.equal(externalEventNextStatus(reviewed, 'timeout'), 'blocked');
  assert.equal(externalEventNextStatus(reviewed, 'waiting'), 'waiting_on_external');
  assert.equal(externalEventNextStatus(reviewed, 'info'), 'waiting_on_external');
});
