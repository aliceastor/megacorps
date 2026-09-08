import assert from 'node:assert/strict';
import test from 'node:test';
import { blockDelegatedAssignment } from './delegated-help.ts';
import { runRetryReady } from './run-retry.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { agents, approvals, cardComments, kanbanCards, mergeIntents, taskRuns } from './db/schema.ts';
import { requestCardRecovery, applyRecoveryReport, finishHumanRecovery } from './card-recovery.ts';

const fixture = (t: any, extras: any[] = []) => {
  const card: any = {
    id: 'card',
    companyId: 'company',
    title: 'Deliver evidence',
    body: 'Original goal',
    columnStatus: 'blocked',
    assigneeId: 'worker',
    reviewerId: null,
  };
  const worker: any = { id: 'worker', companyId: 'company', bossId: 'head', isActive: true };
  const head: any = { id: 'head', companyId: 'company', slug: 'head', isActive: true, isBusy: true };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [worker, head]], ...extras]);
  return { card, worker, head, state };
};
const failure = { reason: 'Missing repository evidence', eventKey: 'failure-1', actorId: 'worker', stage: 'dispatch' as const };
test('busy manager owns durable recovery once across duplicate snapshots', async (t) => {
  const { card, state } = fixture(t);
  const stale = structuredClone(card);
  await requestCardRecovery(card, failure);
  await requestCardRecovery(stale, failure);
  assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.reviewerId, 'head');
  assert.equal(card.protocolRepairState.recovery.round, 1);
  assert.equal(state.rows(cardComments).length, 1);
});
test('no recipient creates exactly one human gate', async (t) => {
  const { card, worker, state } = fixture(t);
  worker.bossId = null;
  await requestCardRecovery(card, failure);
  await requestCardRecovery(structuredClone(card), failure);
  assert.equal(card.protocolRepairState.recovery.mode, 'awaiting_human');
  assert.equal(state.rows(approvals).length, 1);
  assert.equal(state.rows(approvals)[0]!.payload.humanGate, true);
});
for (const guard of ['done', 'human', 'merge'])
  test(`recovery preserves ${guard} authority`, async (t) => {
    const { card, state } = fixture(
      t,
      guard === 'human'
        ? [[approvals, [{ cardId: 'card', type: 'task_review', status: 'pending', payload: { humanGate: true } }]]]
        : guard === 'merge'
          ? [[mergeIntents, [{ cardId: 'card', state: 'accepted' }]]]
          : [],
    );
    if (guard === 'done') card.columnStatus = 'done';
    const before = structuredClone(card);
    await requestCardRecovery(card, failure);
    assert.deepEqual(card, before);
    assert.equal(state.rows(cardComments).length, 0);
  });
test('recovery rejects quality approval and wrong owner; rework restores original stage without completing', async (t) => {
  const { card } = fixture(t);
  await requestCardRecovery(card, failure);
  await assert.rejects(
    () =>
      applyRecoveryReport(card, 'head', { kind: 'megacorps-report', status: 'completed', summary: 'Approved', verdict: 'approved' } as any),
    /recovery/,
  );
  await assert.rejects(
    () =>
      applyRecoveryReport(card, 'worker', {
        kind: 'megacorps-report',
        status: 'completed',
        summary: 'Repair instructions',
        recovery: { action: 'rework', reason: 'Missing evidence', instructions: 'Produce the real project PR' },
      } as any),
    /authority/,
  );
  const result = await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Repair instructions',
    recovery: { action: 'rework', reason: 'Missing evidence', instructions: 'Produce the real project PR' },
  } as any);
  assert.equal(result?.continueKind, 'dispatch');
  assert.equal(card.columnStatus, 'todo');
  assert.equal(card.reviewerId, null);
  assert.equal(card.protocolRepairState.recovery.round, 1);
});

test('stale or foreign source run cannot claim recovery', async (t) => {
  const { card, state } = fixture(t);
  state
    .rows(taskRuns)
    .push({ id: 'foreign', cardId: 'other', companyId: 'company', agentId: 'worker', kind: 'dispatch', status: 'failed' });
  await requestCardRecovery(card, { ...failure, taskRunId: 'foreign' });
  assert.equal(card.protocolRepairState, undefined);
});
test('pending client checkpoint prevents recovery', async (t) => {
  const { card } = fixture(t, [[approvals, [{ cardId: 'card', type: 'client_checkpoint', status: 'pending', payload: {} }]]]);
  await requestCardRecovery(card, failure);
  assert.equal(card.protocolRepairState, undefined);
});
test('returning work resets only failed protocol kind and retains total rounds', async (t) => {
  const { card } = fixture(t);
  card.protocolRepairState = { dispatch: { failures: 3, mode: 'blocked' }, review: { failures: 2, mode: 'same_session' } };
  await requestCardRecovery(card, failure);
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Rework',
    recovery: { action: 'rework', reason: 'Missing real evidence', instructions: 'Produce exact project evidence' },
  } as any);
  assert.equal(card.protocolRepairState.dispatch.failures, 0);
  assert.equal(card.protocolRepairState.recovery.round, 1);
});

test('permission recovery cannot authorize automatic execution', async (t) => {
  const { card } = fixture(t);
  await requestCardRecovery(card, { ...failure, permissionBlocked: true } as any);
  await assert.rejects(
    () =>
      applyRecoveryReport(card, 'head', {
        kind: 'megacorps-report',
        status: 'completed',
        summary: 'Retry',
        recovery: { action: 'rework', reason: 'Retry blocked operation', instructions: 'Retry forbidden action' },
      } as any),
    /permission/,
  );
  assert.equal(card.columnStatus, 'needs_review');
});
test('recovery rework never cancels independent panel or human approvals', async (t) => {
  const { card, state } = fixture(t, [
    [
      approvals,
      [
        { id: 'ordinary', cardId: 'card', type: 'task_review', status: 'pending', payload: {} },
        { id: 'panel', cardId: 'card', type: 'task_review', status: 'pending', payload: { roundId: 'round' } },
      ],
    ],
  ]);
  await requestCardRecovery(card, failure);
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Rework',
    recovery: { action: 'rework', reason: 'Missing evidence', instructions: 'Produce exact project PR' },
  } as any);
  assert.equal(state.rows(approvals).find((a) => a.id === 'ordinary')!.status, 'cancelled');
  assert.equal(state.rows(approvals).find((a) => a.id === 'panel')!.status, 'pending');
});

test('new failure stage keeps shared rounds but updates original stage', async (t) => {
  const { card, head, state } = fixture(t);
  head.bossId = 'boss';
  state.rows(agents).push({ id: 'boss', companyId: 'company', isActive: true });
  await requestCardRecovery(card, failure);
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Repair',
    recovery: { action: 'rework', reason: 'Need real evidence', instructions: 'Produce exact project PR' },
  } as any);
  card.reviewerId = 'worker';
  card.columnStatus = 'in_review';
  await requestCardRecovery(card, { ...failure, eventKey: 'review-failure', stage: 'review', actorId: 'head' });
  assert.equal(card.protocolRepairState.recovery.stage, 'review');
  assert.equal(card.protocolRepairState.recovery.round, 2);
});
test('three manager rounds share one total ceiling across failures', async (t) => {
  const { card, head, state } = fixture(t);
  head.bossId = 'second';
  state
    .rows(agents)
    .push(
      { id: 'second', companyId: 'company', bossId: 'third', isActive: true },
      { id: 'third', companyId: 'company', bossId: 'fourth', isActive: true },
      { id: 'fourth', companyId: 'company', isActive: true },
    );
  await requestCardRecovery(card, failure);
  for (const [actor, n] of [
    ['head', 2],
    ['second', 3],
    ['third', 4],
  ] as const)
    await requestCardRecovery(structuredClone(card), { ...failure, eventKey: `failure-${n}`, actorId: actor, stage: 'review' });
  assert.equal(card.protocolRepairState.recovery.mode, 'awaiting_human');
  assert.equal(card.protocolRepairState.recovery.round, 3);
  assert.equal(state.rows(approvals).length, 1);
});
test('message rework resumes exact request and leaves whole card execution queued nowhere', async (t) => {
  const { card, state } = fixture(t, [
    [
      cardComments,
      [
        { id: 'request', cardId: 'card', assigneeAgentId: 'worker', delegationStatus: 'failed', body: 'Exact request' },
        { id: 'other', cardId: 'card', assigneeAgentId: 'worker', delegationStatus: 'waiting' },
      ],
    ],
  ]);
  await requestCardRecovery(card, { ...failure, stage: 'message', sourceMessageId: 'request' });
  const result = await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Repair',
    recovery: { action: 'rework', reason: 'Need evidence', instructions: 'Complete exact delegated task' },
  } as any);
  assert.equal(result?.sourceMessageId, 'request');
  assert.equal(result?.continueKind, 'message');
  assert.equal(card.columnStatus, 'in_progress');
  assert.equal(state.rows(cardComments).find((r) => r.id === 'request')!.delegationStatus, 'queued');
  assert.equal(state.rows(cardComments).find((r) => r.id === 'other')!.delegationStatus, 'waiting');
  assert.equal(state.rows(taskRuns).length, 0);
});

test('awaiting recovery blocks unrelated dispatch/message attempts', async (t) => {
  const { card } = fixture(t);
  await requestCardRecovery(card, failure);
  assert.equal(runRetryReady(card, 'dispatch'), false);
  assert.equal(runRetryReady(card, 'message'), false);
  assert.equal(runRetryReady(card, 'review'), true);
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Human decision',
    recovery: { action: 'raise_to_human', reason: 'Need authorization' },
  } as any);
  assert.equal(runRetryReady(card, 'review'), false);
});

test('human recovery approval resumes failed stage without approving artifact and retains ceiling', async (t) => {
  const { card, worker, state } = fixture(t);
  worker.bossId = null;
  await requestCardRecovery(card, failure);
  const gate = state.rows(approvals)[0]!;
  await assert.rejects(() => finishHumanRecovery(card, gate.id, 'human', { status: 'approved' }), /instructions/);
  const result = await finishHumanRecovery(card, gate.id, 'human', {
    status: 'approved',
    instructions: 'Corrected the missing project configuration; retry with the current project.',
  });
  assert.equal(card.columnStatus, 'todo');
  assert.equal(result?.continueKind, 'dispatch');
  assert.equal(card.protocolRepairState.recovery.round, 0);
  assert.equal(gate.status, 'answered');
  assert.equal(card.completedAt, null);
  assert.equal(await finishHumanRecovery(card, gate.id, 'human', { status: 'approved', instructions: 'Duplicate' }), null);
});

test('message reviewer recovery restores submitted state and preserves exact reviewer authority', async (t) => {
  const { card, state } = fixture(t, [
    [
      cardComments,
      [
        {
          id: 'report',
          cardId: 'card',
          assigneeAgentId: null,
          reviewerAgentId: 'worker',
          delegationStatus: 'submitted',
          body: 'Original report',
        },
      ],
    ],
  ]);
  await requestCardRecovery(card, { ...failure, stage: 'message_review', sourceMessageId: 'report' });
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Repair',
    recovery: { action: 'rework', reason: 'Need review', instructions: 'Inspect the exact evidence again' },
  } as any);
  const source = state.rows(cardComments).find((r) => r.id === 'report')!;
  assert.equal(source.delegationStatus, 'submitted');
  assert.match(source.body, /Inspect the exact evidence again/);
});

test('recovery action rejects conflicting execution or help intent', async (t) => {
  const { card } = fixture(t);
  await requestCardRecovery(card, failure);
  for (const extra of [
    { status: 'input_required', request: { kind: 'help', question: 'Proceed?' } },
    { children: [{ title: 'New unrelated work', body: 'Execute additional work' }] },
    { delegations: [{ mode: 'handoff', to: 'other', task: 'Transfer execution' }] },
  ]) {
    await assert.rejects(
      () =>
        applyRecoveryReport(card, 'head', {
          kind: 'megacorps-report',
          status: 'completed',
          summary: 'Repair',
          recovery: { action: 'rework', reason: 'Missing real evidence', instructions: 'Produce exact project PR' },
          ...extra,
        } as any),
      /recovery/,
    );
  }
  assert.equal(card.columnStatus, 'needs_review');
});

test('delegated permission failure remains decision-only and same request failures have attempt identity', async (t) => {
  const { card, state } = fixture(t, [
    [
      cardComments,
      [{ id: 'request', cardId: 'card', assigneeAgentId: 'worker', delegationStatus: 'running', body: 'Exact delegated task' }],
    ],
  ]);
  await blockDelegatedAssignment(card, 'request', 'Permission denied', { eventKey: 'attempt-1', permissionBlocked: true });
  assert.equal(card.protocolRepairState.recovery.permissionBlocked, true);
  await assert.rejects(
    () =>
      applyRecoveryReport(card, 'head', {
        kind: 'megacorps-report',
        status: 'completed',
        summary: 'Retry',
        recovery: { action: 'rework', reason: 'Retry', instructions: 'Try again' },
      } as any),
    /permission/,
  );
});
test('later failure of same delegated request advances shared recovery after rework', async (t) => {
  const { card, state } = fixture(t, [
    [
      cardComments,
      [{ id: 'request', cardId: 'card', assigneeAgentId: 'worker', delegationStatus: 'running', body: 'Exact delegated task' }],
    ],
  ]);
  await blockDelegatedAssignment(card, 'request', 'No answer', { eventKey: 'attempt-1' });
  await applyRecoveryReport(card, 'head', {
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Retry',
    recovery: { action: 'rework', reason: 'Correct instructions', instructions: 'Try the correct project' },
  } as any);
  await blockDelegatedAssignment(card, 'request', 'Still no answer', { eventKey: 'attempt-2' });
  assert.equal(card.protocolRepairState.recovery.mode, 'awaiting_human');
  assert.equal(state.rows(approvals).length, 1);
});
