import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExternalEvent, externalEventNextStatus, sweepExternalWaitTimeouts } from './external-events.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { externalEvents, externalWaits, kanbanCards, notifications } from './db/schema.ts';

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

for (const outcome of ['success', 'timeout', 'timeout_sweep'] as const) test(`moved wait ${outcome} rejects before mutating card or wait`, async (t) => {
  const card: any = { id: 'card', companyId: 'company', title: 'Moved card', columnStatus: 'in_progress', updatedAt: new Date(42), runRetryState: { review: { failures: 2, nextRunAt: null } }, protocolRepairState: {} };
  const wait: any = { id: 'wait', cardId: card.id, companyId: card.companyId, provider: 'test', waitingFor: 'External outcome', status: 'waiting', timeoutAt: new Date(0) };
  const state = memoryDb(t, [[kanbanCards, [card]], [externalWaits, [wait]]]);
  const before = structuredClone({ card, wait });
  if (outcome === 'timeout_sweep') assert.equal(await sweepExternalWaitTimeouts({ log: { info() {}, warn() {} } } as any), 0);
  else assert.equal((await applyExternalEvent({ card, input: { provider: 'test', eventType: outcome, status: outcome, waitId: wait.id }, actor: { type: 'system', id: 'test' } })).event, null);
  assert.deepEqual({ card, wait }, before);
  assert.equal(state.rows(externalEvents).length, 0);
  assert.equal(state.rows(notifications).length, 0);
});
