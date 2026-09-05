import assert from 'node:assert/strict';
import test from 'node:test';
import { agents, approvals, heartbeatRuns, kanbanCards, taskLogs, taskRuns } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { ensureHumanGate } from './review-rounds.ts';
import { reviewCard, webhookCompletionDecision } from './dispatch.ts';
import { memoryDb } from './test-support/memory-db.ts';

test('an in-flight ESCALATE with no manager cannot overwrite a later human gate', async (t) => {
  const card = { id: 'card', companyId: 'company', title: 'snake', body: 'Review the game', assigneeId: 'author', reviewerId: 'reviewer', columnStatus: 'needs_review', requiresApproval: false, deletedAt: null, tags: [], dependencyCardIds: [] };
  const reviewer = { id: 'reviewer', companyId: 'company', name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, bossId: null, adapterType: 'webhook', capabilities: [], deletedAt: null };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [reviewer]], [taskRuns, [{ id: 'late-run', cardId: card.id, kind: 'review', status: 'running' }]]]);
  let started!: () => void;
  const adapterStarted = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const finishAdapter = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    started();
    await finishAdapter;
    return { success: true, output: 'VERDICT: ESCALATE', sessionId: 'late-session', tokensUsed: 0, costUsd: 0, durationSeconds: 9 };
  });
  const inFlight = reviewCard(card.id, { taskRunId: 'late-run' });
  // Surface fixture/setup failures instead of waiting forever for the adapter.
  await Promise.race([adapterStarted, inFlight.then(() => { throw new Error('review finished before the adapter started'); })]);
  const guidance = webhookCompletionDecision({ requestedStatus: 'needs_review', text: 'need guidance', reviewerId: null, requiresApproval: false });
  assert.equal(guidance.humanGate, true);
  card.columnStatus = guidance.nextStatus;
  card.reviewerId = null as any;
  await ensureHumanGate(card as any, null, 'No reviewer; client approval required', { kind: 'client_approval' });
  const approvalBefore = structuredClone(state.rows(approvals)[0]);
  finish();
  await inFlight;
  assert.equal(card.columnStatus, 'in_review');
  assert.deepEqual(state.rows(approvals)[0], approvalBefore, 'late review must leave the human decision record untouched');
  assert.equal(state.rows(taskRuns)[0]?.status, 'success');
  assert.equal(state.rows(heartbeatRuns)[0]?.status, 'success');
  assert.ok(state.rows(taskLogs).some((row) => /humanGate already pending; late review escalation ignored/.test(row.message)));
});

for (const approval of [
  { status: 'pending', payload: {}, cardId: 'card' },
  { status: 'approved', payload: { humanGate: true }, cardId: 'card' },
  { status: 'pending', payload: { humanGate: true }, cardId: 'another-card' },
]) {
  test(`ordinary no-manager escalation still blocks without this card's pending human gate (${JSON.stringify(approval)})`, async (t) => {
    const card = { id: 'card', companyId: 'company', title: 'snake', body: 'Review the game', assigneeId: 'author', reviewerId: 'reviewer', columnStatus: 'needs_review', deletedAt: null, tags: [], dependencyCardIds: [] };
    const reviewer = { id: 'reviewer', companyId: 'company', name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, bossId: null, adapterType: 'webhook', capabilities: [], deletedAt: null };
    const state = memoryDb(t, [[kanbanCards, [card]], [agents, [reviewer]], [approvals, [{ id: 'approval', type: 'task_review', ...approval }]]]);
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'VERDICT: ESCALATE', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await reviewCard(card.id);
    assert.equal(card.columnStatus, 'blocked');
    assert.ok(!state.rows(taskLogs).some((row) => /late review escalation ignored/.test(row.message)));
  });
}
