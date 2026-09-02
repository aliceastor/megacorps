import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card, CardAction, CardComment, TaskLog, WorkProduct } from '../components/kanban/card-types.ts';
import {
  assembleThreads,
  buildCommentPayload,
  buildConversation,
  classifyAction,
  classifyComment,
  classifyLog,
  dedupeByExactKeys,
  foldSystemRuns,
  highlightMentions,
  isDelegationReviewComment,
  mentionCandidates,
  type ConversationEvent,
  type ConversationInput,
  type ConversationItem,
  type ConversationView,
} from './card-conversation.ts';

// Fixtures follow what routes.ts / dispatch.ts actually write (see design
// §4.4): comment echo logs, recordStageAction pairs, metadata.commentId,
// escalation logs, delegation chains by parentCommentId, brainstorm / split /
// checkpoint metadata, and the mention rows the server is adding now.

const T0 = Date.parse('2026-09-01T08:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const agents = [
  { id: 'a-alice', name: 'Alice', role: 'CEO', slug: 'alice' },
  { id: 'a-ben', name: 'Ben', role: 'Engineer', slug: 'ben' },
  { id: 'a-cara', name: 'Cara', role: 'Reviewer', slug: 'cara' },
];
const ctx = { agents, you: { id: 'u-1', name: 'Ricky' } };

function comment(id: string, over: Partial<CardComment> = {}): CardComment {
  return { id, body: `body ${id}`, action: 'comment', authorType: 'user', agentId: null, authorId: 'u-1', createdAt: at(0), ...over };
}
function agentComment(id: string, agentId: string, action: string, over: Partial<CardComment> = {}): CardComment {
  return comment(id, { authorType: 'agent', authorId: null, agentId, action, ...over });
}
function systemComment(id: string, action: string, over: Partial<CardComment> = {}): CardComment {
  return comment(id, { authorType: 'system', authorId: null, agentId: null, action, ...over });
}
function log(id: string, over: Partial<TaskLog> = {}): TaskLog {
  return { id, type: 'dispatch', status: 'success', message: `log ${id}`, createdAt: at(0), ...over };
}
function action(id: string, over: Partial<CardAction> = {}): CardAction {
  return { id, actorType: 'system', actorId: 'system', action: 'stage.changed', createdAt: at(0), ...over };
}
function product(id: string, over: Partial<WorkProduct> = {}): WorkProduct {
  return { id, type: 'report', title: `product ${id}`, agentId: 'a-ben', createdAt: at(0), ...over };
}
function build(input: Partial<ConversationInput> = {}, view: Partial<ConversationView> = {}) {
  return buildConversation({ comments: [], logs: [], actions: [], workProducts: [], agents, you: ctx.you, ...input }, { sort: 'newest', filter: 'all', ...view });
}
function flatEvents(items: ConversationItem[]): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  for (const item of items) {
    if (item.type === 'event') out.push(item.event);
    else if (item.type === 'thread') out.push(item.root, ...item.children);
    else if (item.type === 'fold') out.push(...item.events);
  }
  return out;
}
function findEvent(items: ConversationItem[], id: string): ConversationEvent | undefined {
  return flatEvents(items).find((event) => event.id === id);
}
function ids(items: ConversationItem[]): string[] {
  return items.filter((item) => item.type === 'event' || item.type === 'thread').map((item) => (item.type === 'event' ? item.event.id : `thread:${item.root.id}`));
}
function threads(items: ConversationItem[]) {
  return items.filter((item): item is Extract<ConversationItem, { type: 'thread' }> => item.type === 'thread');
}
const card: Pick<Card, 'assigneeId' | 'reviewerId'> = { assigneeId: 'a-alice', reviewerId: 'a-cara' };

// --- ordering -----------------------------------------------------------------

test('same-second rows tie-break action < log < comment < product and missing createdAt sorts oldest', () => {
  const result = build({
    comments: [comment('c1', { createdAt: at(10) }), comment('c0', { createdAt: undefined })],
    logs: [log('l1', { type: 'weird_type', createdAt: at(10) })],
    actions: [action('a1', { action: 'claim', fromStatus: 'todo', toStatus: 'in_progress', createdAt: at(10) })],
    workProducts: [product('p1', { createdAt: at(10) })],
  }, { sort: 'oldest' });
  assert.deepEqual(ids(result.items), ['c-c0', 'a-a1', 'l-l1', 'c-c1', 'p-p1']);
  const newest = build({
    comments: [comment('c1', { createdAt: at(10) }), comment('c0', { createdAt: undefined })],
    logs: [log('l1', { type: 'weird_type', createdAt: at(10) })],
    actions: [action('a1', { action: 'claim', fromStatus: 'todo', toStatus: 'in_progress', createdAt: at(10) })],
    workProducts: [product('p1', { createdAt: at(10) })],
  }, { sort: 'newest' });
  assert.deepEqual(ids(newest.items), ['p-p1', 'c-c1', 'l-l1', 'a-a1', 'c-c0']);
  assert.equal(findEvent(result.items, 'c-c0')?.at, 0);
  assert.equal(newest.items[0]?.type, 'day');
  assert.equal(result.items[0]?.type, 'event', 'a row without a timestamp gets no day separator');
});

// --- exact-key de-duplication ---------------------------------------------------

test('the comment echo log is dropped and the queue notice becomes a chip on the send_to_agent comment', () => {
  const result = build({
    comments: [comment('c1', { action: 'send_to_agent', body: 'ship it', createdAt: at(0) })],
    logs: [
      log('l1', { type: 'comment', status: 'success', message: 'Ricky added a send_to_agent message.', output: 'ship it', createdAt: at(0) }),
      log('l2', { type: 'comment', status: 'queued', message: 'Comment queued for agent context on the next run.', output: 'ship it', createdAt: at(1) }),
    ],
  });
  const c1 = findEvent(result.items, 'c-c1');
  assert.ok(c1);
  assert.equal(c1.kind, 'message');
  assert.ok(c1.chips.some((chip) => chip.kind === 'queued'));
  assert.equal(findEvent(result.items, 'l-l1'), undefined);
  assert.equal(findEvent(result.items, 'l-l2'), undefined);
  assert.equal(result.counts.all, 1);
  const system = build({
    comments: [comment('c1', { action: 'send_to_agent', body: 'ship it', createdAt: at(0) })],
    logs: [log('l1', { type: 'comment', status: 'success', message: 'Ricky added a send_to_agent message.', output: 'ship it', createdAt: at(0) })],
  }, { filter: 'system' });
  assert.equal(findEvent(system.items, 'l-l1'), undefined, 'exact-key drops never come back under the system filter');
});

test('a stage log is dropped when its recordStageAction card_action exists within 3 seconds', () => {
  const result = build({
    logs: [
      log('l1', { type: 'stage', message: 'Stage changed from todo to in_progress by a-ben.', createdAt: at(5) }),
      log('l2', { type: 'stage', message: 'Stage changed from in_progress to in_review.', createdAt: at(100) }),
    ],
    actions: [action('a1', { action: 'claim', actorType: 'agent:worker', actorId: 'a-ben', fromStatus: 'todo', toStatus: 'in_progress', createdAt: at(6) })],
  }, { filter: 'system' });
  assert.equal(findEvent(result.items, 'l-l1'), undefined);
  const a1 = findEvent(result.items, 'a-a1');
  assert.equal(a1?.kind, 'status');
  assert.equal(a1?.actor.type, 'agent');
  assert.equal(a1?.actor.name, 'Ben');
  const l2 = findEvent(result.items, 'l-l2');
  assert.equal(l2?.kind, 'status');
  assert.equal(l2?.refs.to, 'in_review');
  assert.equal(l2?.labelKey, 'kanban.event.stage_changed');
});

test('a human pause folds its block card_action, stage log and echo into one message with a consequence chip', () => {
  const result = build({
    comments: [comment('c1', { action: 'pause_agent', body: 'stop', createdAt: at(0) })],
    actions: [action('a1', { action: 'block', actorType: 'user', actorId: 'u-1', fromStatus: 'in_progress', toStatus: 'blocked', metadata: { commentId: 'c1' }, createdAt: at(0) })],
    logs: [
      log('l1', { type: 'stage', status: 'warning', message: 'Stage changed from in_progress to blocked by Ricky.', createdAt: at(0) }),
      log('l2', { type: 'comment', message: 'Ricky added a pause_agent message.', output: 'stop', createdAt: at(0) }),
    ],
  });
  assert.deepEqual(ids(result.items), ['c-c1']);
  const c1 = findEvent(result.items, 'c-c1');
  assert.equal(c1?.kind, 'message');
  assert.equal(c1?.tone, 'danger');
  assert.equal(c1?.actor.type, 'you');
  assert.deepEqual(c1?.chips.map((chip) => [chip.kind, chip.status]), [['consequence', 'blocked']]);
  assert.equal(c1?.refs.to, 'blocked');
  assert.equal(result.counts.all, 1);
});

test('legacy data without metadata.commentId keeps the block action as a visible alert row', () => {
  const result = build({
    comments: [comment('c1', { action: 'pause_agent', body: 'stop', createdAt: at(0) })],
    actions: [action('a1', { action: 'block', actorType: 'user', actorId: 'u-1', fromStatus: 'in_progress', toStatus: 'blocked', createdAt: at(0) })],
  });
  assert.equal(findEvent(result.items, 'a-a1')?.kind, 'alert');
  assert.equal(findEvent(result.items, 'c-c1')?.chips.length, 0);
});

test('escalation: queued log becomes an escalated chip, failed log stays an alert', () => {
  const queued = build({
    comments: [comment('c1', { action: 'escalate_to_reviewer', body: 'need help', createdAt: at(0) })],
    actions: [action('a1', { action: 'request_help', actorType: 'user', actorId: 'u-1', fromStatus: 'in_progress', toStatus: 'needs_review', metadata: { commentId: 'c1', reviewerId: 'a-cara', reason: 'Escalated to reviewer by Ricky.' }, createdAt: at(0) })],
    logs: [log('l1', { type: 'escalation', status: 'queued', message: 'Escalated to reviewer by Ricky.', output: 'need help', createdAt: at(0) })],
  });
  const c1 = findEvent(queued.items, 'c-c1');
  assert.ok(c1?.chips.some((chip) => chip.kind === 'consequence' && chip.status === 'needs_review'));
  assert.ok(c1?.chips.some((chip) => chip.kind === 'escalated' && chip.text === 'Cara'));
  assert.equal(findEvent(queued.items, 'l-l1'), undefined);

  const failed = build({
    comments: [comment('c1', { action: 'escalate_to_reviewer', body: 'need help', createdAt: at(0) })],
    actions: [action('a1', { action: 'block', actorType: 'user', actorId: 'u-1', fromStatus: 'in_progress', toStatus: 'blocked', metadata: { commentId: 'c1', reviewerId: null }, createdAt: at(0) })],
    logs: [log('l1', { type: 'escalation', status: 'failed', message: 'Escalation requested by Ricky, but no independent reviewer or manager is available.', output: 'need help', createdAt: at(0) })],
  });
  const l1 = findEvent(failed.items, 'l-l1');
  assert.equal(l1?.kind, 'alert');
  assert.equal(l1?.hidden, false);
  assert.ok(findEvent(failed.items, 'c-c1')?.chips.some((chip) => chip.kind === 'consequence' && chip.status === 'blocked'));
  assert.ok(!findEvent(failed.items, 'c-c1')?.chips.some((chip) => chip.kind === 'escalated'));
});

// --- delegation threads ---------------------------------------------------------

function delegationFixture(): Partial<ConversationInput> {
  return {
    comments: [
      comment('c1', { action: 'delegate_to_agent', body: 'Delegated from Message Board by Ricky.\nPHASE REVIEWER\n\nlist CMS candidates', assigneeAgentId: 'a-ben', reviewerAgentId: 'a-cara', reviewerScope: 'phase', delegationStatus: 'approved', metadata: { requestedByUserId: 'u-1' }, createdAt: at(0) }),
      agentComment('c2', 'a-ben', 'agent_delegated', { parentCommentId: 'c1', delegationStatus: 'waiting', createdAt: at(10) }),
      agentComment('c3', 'a-ben', 'delegate_retry_queued', { parentCommentId: 'c1', delegationStatus: 'queued', createdAt: at(20) }),
      agentComment('c4', 'a-ben', 'delegate_retry_queued', { parentCommentId: 'c1', delegationStatus: 'queued', createdAt: at(30) }),
      agentComment('c5', 'a-ben', 'delegate_report', { parentCommentId: 'c1', assigneeAgentId: 'a-ben', reviewerAgentId: 'a-cara', reviewerScope: 'phase', delegationStatus: 'submitted', metadata: { requestCommentId: 'c1', taskRunId: 'run-1' }, createdAt: at(40) }),
      agentComment('c6', 'a-cara', 'phase_review_approved', { parentCommentId: 'c5', delegationStatus: 'approved', createdAt: at(50) }),
      comment('c7', { body: 'looks good', createdAt: at(45) }),
      comment('c0', { body: 'older note', createdAt: at(-100) }),
    ],
    logs: [
      log('l1', { type: 'message_delegation', status: 'success', message: 'Message Board delegation report submitted for review.', costUsd: '0.12', durationSeconds: 41, createdAt: at(40) }),
      log('l2', { type: 'message_review', status: 'success', message: 'Message Board delegation review approved.', costUsd: '0.05', durationSeconds: 9, createdAt: at(50) }),
    ],
  };
}

test('a delegation chain becomes one thread with retries folded, the latest report and the verdict visible', () => {
  const result = build(delegationFixture());
  const [thread] = threads(result.items);
  assert.ok(thread);
  assert.equal(thread.kind, 'delegation');
  assert.equal(thread.root.id, 'c-c1');
  assert.equal(thread.root.kind, 'delegation');
  assert.equal(thread.root.actor.type, 'you');
  assert.deepEqual(thread.children.map((child) => child.id), ['c-c2', 'c-c3', 'c-c4', 'c-c5', 'c-c6']);
  assert.equal(thread.children.find((child) => child.id === 'c-c6')?.depth, 2);
  assert.equal(thread.lastActivityAt, Date.parse(at(50)));
  assert.equal(thread.meta.kind, 'delegation');
  if (thread.meta.kind === 'delegation') {
    assert.equal(thread.meta.status, 'approved');
    assert.equal(thread.meta.assigneeAgentId, 'a-ben');
    assert.equal(thread.meta.reviewerAgentId, 'a-cara');
    assert.equal(thread.meta.reviewerScope, 'phase');
    assert.equal(thread.meta.retryCount, 2);
    assert.deepEqual(thread.meta.visibleIds, ['c-c5', 'c-c6']);
    assert.equal(thread.meta.processCount, 3);
  }
  const report = findEvent(result.items, 'c-c5');
  assert.deepEqual(report?.chips.filter((chip) => chip.kind === 'cost').map((chip) => chip.text), ['$0.12 · 41s']);
  const mergedLog = findEvent(result.items, 'l-l1');
  assert.equal(mergedLog?.kind, 'system');
  assert.equal(mergedLog?.hidden, true);
  assert.equal(mergedLog?.refs.mergedInto, 'c-c5');
  assert.equal(findEvent(result.items, 'c-c6')?.tone, 'success');
});

test('threads sort by last activity when newest-first and by root when oldest-first', () => {
  const newest = build(delegationFixture(), { sort: 'newest' });
  const newestOrder = ids(newest.items);
  assert.ok(newestOrder.indexOf('thread:c-c1') < newestOrder.indexOf('c-c7'));
  assert.equal(newestOrder.at(-1), 'c-c0');
  const oldest = build(delegationFixture(), { sort: 'oldest' });
  const oldestOrder = ids(oldest.items);
  assert.equal(oldestOrder[0], 'c-c0');
  assert.ok(oldestOrder.indexOf('thread:c-c1') < oldestOrder.indexOf('c-c7'));
});

test('nested requests cap the display depth at 3 and a parent cycle cannot loop or duplicate rows', () => {
  const nested = build({
    comments: [
      agentComment('c1', 'a-alice', 'delegate_request', { assigneeAgentId: 'a-ben', delegationStatus: 'queued', createdAt: at(0) }),
      agentComment('c2', 'a-ben', 'delegate_request', { parentCommentId: 'c1', assigneeAgentId: 'a-cara', delegationStatus: 'queued', createdAt: at(1) }),
      agentComment('c3', 'a-cara', 'delegate_request', { parentCommentId: 'c2', assigneeAgentId: 'a-alice', delegationStatus: 'queued', createdAt: at(2) }),
      agentComment('c4', 'a-alice', 'delegate_report', { parentCommentId: 'c3', delegationStatus: 'submitted', createdAt: at(3) }),
      agentComment('c5', 'a-ben', 'phase_review_approved', { parentCommentId: 'c4', delegationStatus: 'approved', createdAt: at(4) }),
    ],
  });
  const [thread] = threads(nested.items);
  assert.ok(thread);
  assert.deepEqual(thread.children.map((child) => [child.id, child.depth]), [['c-c2', 1], ['c-c3', 2], ['c-c4', 3], ['c-c5', 3]]);

  const cyclic = build({
    comments: [
      agentComment('x1', 'a-alice', 'delegate_request', { parentCommentId: 'x2', assigneeAgentId: 'a-ben', delegationStatus: 'queued', createdAt: at(0) }),
      agentComment('x2', 'a-ben', 'delegate_request', { parentCommentId: 'x1', assigneeAgentId: 'a-alice', delegationStatus: 'queued', createdAt: at(1) }),
      agentComment('x3', 'a-cara', 'delegate_report', { parentCommentId: 'missing-parent', delegationStatus: 'submitted', createdAt: at(2) }),
    ],
  });
  const seen = flatEvents(cyclic.items).map((event) => event.id).sort();
  assert.deepEqual(seen, ['c-x1', 'c-x2', 'c-x3']);
  assert.equal(cyclic.counts.all, 3);
});

// --- brainstorm / split / checkpoint containers --------------------------------

test('a brainstorm round collects its questions, proposals, closing row and decomposition logs with k/n answered', () => {
  const result = build({
    comments: [
      agentComment('c1', 'a-alice', 'brainstorm_opened', { metadata: { round: 1, departmentIds: ['d1', 'd2', 'd3'] }, createdAt: at(0) }),
      agentComment('q1', 'a-alice', 'peer_question', { assigneeAgentId: 'a-ben', delegationStatus: 'done', metadata: { peerQuestion: true, brainstorm: true, round: 1, departmentId: 'd1', departmentName: '設計部' }, createdAt: at(1) }),
      agentComment('q2', 'a-alice', 'peer_question', { assigneeAgentId: 'a-cara', delegationStatus: 'done', metadata: { peerQuestion: true, brainstorm: true, round: 1, departmentId: 'd2', departmentName: '內容部' }, createdAt: at(2) }),
      agentComment('q3', 'a-alice', 'peer_question', { assigneeAgentId: 'a-ben', delegationStatus: 'failed', metadata: { peerQuestion: true, brainstorm: true, round: 1, departmentId: 'd3', departmentName: '工程部' }, createdAt: at(3) }),
      agentComment('ans1', 'a-ben', 'peer_answer', { parentCommentId: 'q1', createdAt: at(100) }),
      agentComment('ans2', 'a-cara', 'peer_answer', { parentCommentId: 'q2', createdAt: at(110) }),
      systemComment('closed', 'brainstorm_closed', { metadata: { round: 1, reason: 'timeout' }, createdAt: at(200) }),
      comment('c9', { body: 'unrelated human comment', createdAt: at(150) }),
    ],
    logs: [
      log('l1', { type: 'decomposition', status: 'queued', message: 'Brainstorm round 1 opened with 3 department head(s).', createdAt: at(0) }),
      log('l2', { type: 'decomposition', status: 'warning', message: 'Brainstorm round 1 closed (timeout); owner resumes to synthesize.', createdAt: at(200) }),
    ],
  });
  const [thread] = threads(result.items);
  assert.ok(thread);
  assert.equal(thread.kind, 'brainstorm');
  assert.equal(thread.root.kind, 'milestone');
  assert.deepEqual(thread.meta, { kind: 'brainstorm', round: 1, answered: 2, total: 3, closed: true });
  assert.deepEqual(thread.children.map((child) => child.id).sort(), ['c-ans1', 'c-ans2', 'c-closed', 'c-q1', 'c-q2', 'c-q3', 'l-l1', 'l-l2']);
  const proposal = thread.children.find((child) => child.id === 'c-ans1');
  assert.equal(proposal?.labelKey, 'kanban.event.brainstorm_proposal');
  assert.equal(proposal?.refs.departmentName, '設計部');
  assert.equal(proposal?.depth, 1);
  assert.equal(thread.children.find((child) => child.id === 'l-l1')?.hidden, true);
  assert.ok(ids(result.items).includes('c-c9'));
});

test('a split round collects childIds, the round-complete row and the children / cascade logs', () => {
  const result = build({
    comments: [
      agentComment('c1', 'a-alice', 'split_opened', { metadata: { round: 1, childIds: ['k1', 'k2'] }, createdAt: at(0) }),
      systemComment('c2', 'split_round_complete', { metadata: { round: 1, childIds: ['k1', 'k2'] }, createdAt: at(500) }),
      agentComment('c3', 'a-alice', 'split_opened', { metadata: { round: 2, childIds: ['k3'] }, createdAt: at(900) }),
    ],
    logs: [
      log('l1', { type: 'children', message: 'Split round 1 created 2 child cards.', createdAt: at(0) }),
      log('l2', { type: 'cascade', message: 'All children done; parent ready for integration.', createdAt: at(500) }),
      log('l3', { type: 'children', message: 'Split round 2 created 1 child card.', createdAt: at(900) }),
    ],
  });
  const rounds = threads(result.items);
  assert.equal(rounds.length, 2);
  const round1 = rounds.find((thread) => thread.root.id === 'c-c1');
  assert.ok(round1);
  assert.deepEqual(round1.meta, { kind: 'split', round: 1, childIds: ['k1', 'k2'] });
  assert.deepEqual(round1.children.map((child) => child.id), ['l-l1', 'l-l2', 'c-c2'], 'same-second log sorts before the comment');
  const round2 = rounds.find((thread) => thread.root.id === 'c-c3');
  assert.deepEqual(round2?.children.map((child) => child.id), ['l-l3']);
});

test('checkpoint containers take their status from approvals, not from comments', () => {
  const comments = [
    agentComment('asked', 'a-alice', 'client_checkpoint_asked', { metadata: { approvalId: 'ap-1', kind: 'direction' }, createdAt: at(0) }),
    systemComment('answered', 'client_checkpoint_answered', { metadata: { approvalId: 'ap-1' }, createdAt: at(3600) }),
  ];
  const logs = [log('rem', { type: 'client_checkpoint_reminder', status: 'queued', message: 'Reminder sent.', createdAt: at(1800) })];
  const answered = build({ comments, logs, approvals: [{ id: 'ap-1', type: 'client_checkpoint', status: 'answered' }] });
  const [thread] = threads(answered.items);
  assert.ok(thread);
  assert.equal(thread.kind, 'checkpoint');
  assert.deepEqual(thread.meta, { kind: 'checkpoint', approvalId: 'ap-1', approvalStatus: 'answered', reminders: 1 });
  assert.deepEqual(thread.children.map((child) => child.id), ['l-rem', 'c-answered']);

  const checkpointStatus = (items: ConversationItem[]): string | undefined => {
    const meta = threads(items)[0]?.meta;
    return meta && meta.kind === 'checkpoint' ? meta.approvalStatus : undefined;
  };
  const pending = build({ comments: [comments[0]!], approvals: [{ id: 'ap-1', type: 'client_checkpoint', status: 'pending' }] });
  assert.equal(checkpointStatus(pending.items), 'pending');
  const cancelled = build({ comments: [comments[0]!], approvals: [{ id: 'ap-1', type: 'client_checkpoint', status: 'cancelled' }] });
  assert.equal(checkpointStatus(cancelled.items), 'cancelled');
  const unknown = build({ comments: [comments[0]!] });
  assert.equal(checkpointStatus(unknown.items), 'unknown');

  const noApproval = build({ comments: [agentComment('bare', 'a-alice', 'client_checkpoint_asked', { metadata: { approvalId: null, kind: 'direction' }, createdAt: at(0) })] });
  assert.deepEqual(ids(noApproval.items), ['c-bare']);
  assert.equal(findEvent(noApproval.items, 'c-bare')?.kind, 'milestone');
});

test('parent-card mirror rows carry a child chip pointing at the child card', () => {
  const result = build({
    comments: [
      systemComment('m1', 'client_checkpoint_asked', { body: 'Child card "CMS" is waiting on the client: which CMS?', metadata: { childCardId: 'child-9', approvalId: 'ap-2' }, createdAt: at(0) }),
      systemComment('m2', 'brainstorm_opened', { body: 'Child card "CMS" opened brainstorm round 1 with 2 department head(s).', createdAt: at(10) }),
    ],
  });
  const mirror = findEvent(result.items, 'c-m1');
  assert.deepEqual(mirror?.chips, [{ kind: 'child', text: 'child-9', cardId: 'child-9' }]);
  const plain = findEvent(result.items, 'c-m2');
  assert.equal(plain?.kind, 'milestone');
  assert.equal(plain?.chips.length, 0);
  assert.equal(threads(result.items).filter((thread) => thread.kind === 'brainstorm').length, 0, 'a mirror row without metadata.round is not a round container');
});

// --- folding, alerts, unknowns, markers -----------------------------------------

test('failed logs are alerts that never fold; consecutive system rows fold into one item with a tally', () => {
  const result = build({
    logs: [
      log('l0', { type: 'lock', status: 'running', message: 'Execution lock acquired by Ben via loop.', createdAt: at(0) }),
      log('l1', { type: 'dispatch', status: 'failed', message: 'adapter timeout', createdAt: at(1) }),
      log('l2', { type: 'queue', status: 'queued', message: 'Task run queued.', createdAt: at(2) }),
      log('l3', { type: 'dispatch', status: 'running', message: 'Dispatching.', createdAt: at(3) }),
    ],
  }, { sort: 'oldest' });
  const shaped = result.items.filter((item) => item.type !== 'day').map((item) => (item.type === 'fold' ? `fold:${item.events.map((event) => event.id).join('+')}` : item.type === 'event' ? item.event.id : item.type));
  assert.deepEqual(shaped, ['fold:l-l0', 'l-l1', 'fold:l-l2+l-l3']);
  const alert = findEvent(result.items, 'l-l1');
  assert.equal(alert?.kind, 'alert');
  assert.equal(alert?.hidden, false);
  const fold = result.items.find((item) => item.type === 'fold' && item.events.length === 2);
  if (!fold || fold.type !== 'fold') throw new Error('expected a two-row fold');
  assert.deepEqual(fold.tally, { queue: 1, dispatch: 1 });
  assert.equal(result.counts.system, 3);
  assert.equal(result.counts.alerts, 1);
  const unfolded = build({ logs: [log('l0', { type: 'lock', status: 'running', createdAt: at(0) }), log('l2', { type: 'queue', status: 'queued', createdAt: at(2) })] }, { filter: 'system' });
  assert.deepEqual(ids(unfolded.items), ['l-l2', 'l-l0']);
});

test('unknown actions are never dropped: comment → visible message, log → visible system, card_action → visible status', () => {
  const result = build({
    comments: [comment('c1', { action: 'something_new', createdAt: at(0) })],
    logs: [log('l1', { type: 'mystery', status: 'success', createdAt: at(1) })],
    actions: [action('a1', { action: 'integration.created', actorType: 'user', actorId: 'u-1', createdAt: at(2) })],
  });
  const c1 = findEvent(result.items, 'c-c1');
  assert.equal(c1?.kind, 'message');
  assert.equal(c1?.labelKey, 'kanban.event.something_new');
  assert.equal(c1?.rawLabel, 'something_new');
  const l1 = findEvent(result.items, 'l-l1');
  assert.equal(l1?.kind, 'system');
  assert.equal(l1?.hidden, false);
  const a1 = findEvent(result.items, 'a-a1');
  assert.equal(a1?.kind, 'status');
  assert.deepEqual(ids(result.items), ['a-a1', 'l-l1', 'c-c1']);
  assert.equal(result.items.filter((item) => item.type === 'fold').length, 0);
  assert.equal(result.counts.all, 3);
});

test('transitions into done / cancelled are milestones and into blocked are alerts; create is the create_card milestone', () => {
  const result = build({
    actions: [
      action('a1', { action: 'create', actorType: 'user', actorId: 'u-1', fromStatus: null, toStatus: 'todo', createdAt: at(0) }),
      action('a2', { action: 'card.created', actorType: 'user', actorId: 'u-1', createdAt: at(0) }),
      action('a3', { action: 'approve', actorType: 'agent:reviewer', actorId: 'a-cara', fromStatus: 'in_review', toStatus: 'done', createdAt: at(10) }),
      action('a4', { action: 'cancel', actorType: 'user', actorId: 'u-1', fromStatus: 'todo', toStatus: 'cancelled', createdAt: at(20) }),
      action('a5', { action: 'block', actorType: 'system', actorId: 'system', fromStatus: 'in_progress', toStatus: 'blocked', createdAt: at(30) }),
      action('a6', { action: 'card.updated', actorType: 'user', actorId: 'u-1', createdAt: at(40) }),
    ],
  });
  assert.equal(findEvent(result.items, 'a-a1')?.kind, 'milestone');
  assert.equal(findEvent(result.items, 'a-a1')?.labelKey, 'kanban.event.create_card');
  assert.equal(findEvent(result.items, 'a-a2')?.hidden, true);
  assert.equal(findEvent(result.items, 'a-a3')?.kind, 'milestone');
  assert.equal(findEvent(result.items, 'a-a3')?.tone, 'success');
  assert.equal(findEvent(result.items, 'a-a4')?.kind, 'milestone');
  assert.equal(findEvent(result.items, 'a-a5')?.kind, 'alert');
  assert.equal(findEvent(result.items, 'a-a6')?.kind, 'system');
  assert.equal(result.counts.milestones, 4, 'create, approve, cancel and the blocked alert; the two card.* echoes are system');
});

test('review comments get a verdict chip from the adjacent card_action and swallow the review log cost', () => {
  const result = build({
    comments: [agentComment('c1', 'a-cara', 'review_note', { createdAt: at(1) })],
    actions: [action('a1', { action: 'approve', actorType: 'agent:reviewer', actorId: 'a-cara', fromStatus: 'in_review', toStatus: 'done', createdAt: at(2) })],
    logs: [log('l1', { type: 'review', status: 'success', message: 'Review passed; card marked done.', costUsd: '0.20', durationSeconds: 30, createdAt: at(0) })],
  });
  const c1 = findEvent(result.items, 'c-c1');
  assert.equal(c1?.kind, 'review');
  assert.ok(c1?.chips.some((chip) => chip.kind === 'verdict' && chip.text === 'approve' && chip.status === 'done'));
  assert.ok(c1?.chips.some((chip) => chip.kind === 'cost' && chip.text === '$0.20 · 30s'));
  const l1 = findEvent(result.items, 'l-l1');
  assert.equal(l1?.kind, 'system');
  assert.equal(l1?.refs.mergedInto, 'c-c1');
  assert.equal(findEvent(result.items, 'a-a1')?.kind, 'milestone');
});

test('a review log without a matching comment stays a visible review row', () => {
  const result = build({ logs: [log('l1', { type: 'review', status: 'failed', message: 'Review rejected; card returned to todo.', createdAt: at(0) }), log('l2', { type: 'review', status: 'success', message: 'Review passed.', createdAt: at(600) })] });
  assert.equal(findEvent(result.items, 'l-l1')?.kind, 'alert');
  assert.equal(findEvent(result.items, 'l-l2')?.kind, 'review');
  assert.equal(findEvent(result.items, 'l-l2')?.delegationReview, true);
});

test('horizon marks the oldest end when more logs exist on the server', () => {
  const input = { logs: [log('l1', { type: 'queue', status: 'queued', createdAt: at(0) }), log('l2', { type: 'weird', createdAt: at(50) })], logsHasMore: true };
  const newest = build(input, { sort: 'newest' });
  assert.deepEqual(newest.items.at(-1), { type: 'horizon', at: Date.parse(at(0)) });
  const oldest = build(input, { sort: 'oldest' });
  assert.deepEqual(oldest.items[0], { type: 'horizon', at: Date.parse(at(0)) });
  const none = build({ logs: input.logs, logsHasMore: false });
  assert.equal(none.items.some((item) => item.type === 'horizon'), false);
});

test('the unread line separates events newer than lastSeenAt', () => {
  const comments = [comment('c1', { createdAt: at(0) }), comment('c2', { createdAt: at(100) }), comment('c3', { createdAt: at(200) })];
  const newest = build({ comments, lastSeenAt: at(150) }, { sort: 'newest' });
  const order = newest.items.filter((item) => item.type !== 'day').map((item) => (item.type === 'event' ? item.event.id : item.type));
  assert.deepEqual(order, ['c-c3', 'unread', 'c-c2', 'c-c1']);
  assert.equal(newest.counts.unread, 1);
  const oldest = build({ comments, lastSeenAt: Date.parse(at(150)) }, { sort: 'oldest' });
  const orderOldest = oldest.items.filter((item) => item.type !== 'day').map((item) => (item.type === 'event' ? item.event.id : item.type));
  assert.deepEqual(orderOldest, ['c-c1', 'c-c2', 'unread', 'c-c3']);
  const allNew = build({ comments, lastSeenAt: at(-10) });
  assert.equal(allNew.items.some((item) => item.type === 'unread'), false);
  const never = build({ comments });
  assert.equal(never.items.some((item) => item.type === 'unread'), false);
  assert.equal(never.counts.unread, 0);
});

test('day separators appear once per calendar day and latest points at the newest non-system event', () => {
  const dayMs = 86_400_000;
  const result = build({
    comments: [comment('c1', { createdAt: at(0) }), comment('c2', { createdAt: new Date(T0 - 2 * dayMs).toISOString() })],
    logs: [log('l1', { type: 'lock', status: 'running', createdAt: at(500) })],
  });
  assert.equal(result.items.filter((item) => item.type === 'day').length, 2);
  assert.equal(result.latest?.id, 'c-c1');
  assert.equal(result.counts.conversation, 2);
  assert.equal(result.counts.all, 3);
});

test('an optimistic comment already returned by the server is counted once', () => {
  const row = comment('c1', { createdAt: at(0) });
  const result = build({ comments: [row, { ...row }] });
  assert.deepEqual(ids(result.items), ['c-c1']);
  assert.equal(result.counts.all, 1);
});

test('filters: talk, milestones, system; empty filters keep the container when any child matches', () => {
  const input: Partial<ConversationInput> = {
    comments: [comment('c1', { createdAt: at(0) }), agentComment('c2', 'a-cara', 'review_note', { createdAt: at(10) })],
    actions: [action('a1', { action: 'claim', fromStatus: 'todo', toStatus: 'in_progress', createdAt: at(5) })],
    logs: [log('l1', { type: 'lock', status: 'running', createdAt: at(6) })],
    workProducts: [product('p1', { createdAt: at(20) })],
  };
  assert.deepEqual(ids(build(input, { filter: 'talk' }).items).sort(), ['c-c1', 'c-c2', 'p-p1']);
  assert.deepEqual(ids(build(input, { filter: 'milestones' }).items).sort(), ['a-a1']);
  assert.deepEqual(ids(build(input, { filter: 'system' }).items).sort(), ['a-a1', 'c-c1', 'c-c2', 'l-l1', 'p-p1']);
  assert.deepEqual(ids(build(input, { filter: 'delegationReview' }).items).sort(), ['c-c2']);
  const counts = build(input).counts;
  assert.equal(counts.talk, 3);
  assert.equal(counts.milestones, 1);
  assert.equal(counts.products, 1);
  assert.equal(counts.delegationReview, 1);
});

// --- mentions and agent comments -------------------------------------------------

test('a @mention question threads under its source comment, shows actor you, and its answer nests below', () => {
  const result = build({
    comments: [
      comment('c1', { body: 'hey @ben can you check the CMS list?', createdAt: at(0) }),
      comment('pq', { action: 'peer_question', body: 'can you check the CMS list?', parentCommentId: 'c1', authorType: 'user', authorId: 'u-1', agentId: null, assigneeAgentId: 'a-ben', delegationStatus: 'done', metadata: { peerQuestion: true, mention: true, targetSlug: 'ben', sourceCommentId: 'c1', authorName: 'Ricky', authorKind: 'user' }, createdAt: at(1) }),
      agentComment('pa', 'a-ben', 'peer_answer', { parentCommentId: 'pq', body: 'Checked, three candidates.', createdAt: at(30) }),
    ],
  });
  const [thread] = threads(result.items);
  assert.ok(thread);
  assert.equal(thread.kind, 'reply');
  assert.equal(thread.root.id, 'c-c1');
  assert.deepEqual(thread.children.map((child) => [child.id, child.depth]), [['c-pq', 1], ['c-pa', 2]]);
  const question = thread.children[0]!;
  assert.equal(question.kind, 'message');
  assert.equal(question.labelKey, 'kanban.event.mention_question');
  assert.equal(question.actor.type, 'you');
  assert.equal(question.refs.targetSlug, 'ben');
  assert.equal(question.refs.sourceCommentId, 'c1');
  assert.equal(question.hidden, false);
  const answer = thread.children[1]!;
  assert.equal(answer.labelKey, 'kanban.event.peer_answer');
  assert.equal(answer.actor.name, 'Ben');
  assert.ok(ids(build({ comments: [comment('c1', { createdAt: at(0) }), comment('pq', { action: 'peer_question', parentCommentId: 'c1', authorType: 'user', assigneeAgentId: 'a-ben', delegationStatus: 'queued', metadata: { peerQuestion: true, mention: true, targetSlug: 'ben', sourceCommentId: 'c1' }, createdAt: at(1) })] }, { filter: 'delegationReview' }).items).includes('thread:c-c1'));
});

test('an agent-authored comment renders as a message from that agent with via kept in refs', () => {
  const result = build({
    comments: [
      agentComment('c1', 'a-ben', 'comment', { body: 'Status: migration script drafted.', metadata: { via: 'report' }, createdAt: at(0) }),
      agentComment('c2', 'a-cara', 'comment', { body: 'Reviewed the draft.', metadata: { via: 'agent_token' }, createdAt: at(10) }),
    ],
  });
  const c1 = findEvent(result.items, 'c-c1');
  assert.equal(c1?.kind, 'message');
  assert.equal(c1?.labelKey, 'kanban.event.agent_comment');
  assert.deepEqual(c1?.actor, { type: 'agent', id: 'a-ben', name: 'Ben', role: 'Engineer' });
  assert.equal(c1?.refs.via, 'report');
  assert.equal(c1?.chips.length, 0);
  assert.equal(findEvent(result.items, 'c-c2')?.refs.via, 'agent_token');
  assert.equal(findEvent(result.items, 'c-c2')?.delegationReview, false);
});

test('an unresolved mention is a visible warning message from the system', () => {
  const result = build({ comments: [systemComment('f1', 'peer_question_failed', { body: '@bobb could not be resolved to another active agent in this company, so this question was not delivered.\n\nQuestion from Alice: can you check?', createdAt: at(0) })] });
  const row = findEvent(result.items, 'c-f1');
  assert.equal(row?.kind, 'message');
  assert.equal(row?.tone, 'warning');
  assert.equal(row?.hidden, false);
  assert.equal(row?.actor.type, 'system');
  assert.equal(row?.labelKey, 'kanban.event.mention_unresolved');
  assert.deepEqual(ids(result.items), ['c-f1']);
  assert.deepEqual(ids(build({ comments: [systemComment('f1', 'peer_question_failed', { createdAt: at(0) })] }, { filter: 'talk' }).items), ['c-f1']);
});

test('a deleted agent falls back to a short id and is flagged missing', () => {
  const event = classifyComment(agentComment('c1', '1a2b3c4d-0000-0000-0000-000000000000', 'agent_note'), ctx);
  assert.deepEqual(event.actor, { type: 'agent', id: '1a2b3c4d-0000-0000-0000-000000000000', name: '1a2b3c4d', missing: true });
});

// --- parity with today's UI --------------------------------------------------------

test('parity A: the 委派與審核 filter includes every row isDelegationReviewComment lists today', () => {
  const comments: CardComment[] = [
    comment('h1', { body: 'plain human comment', createdAt: at(0) }),
    agentComment('n1', 'a-ben', 'agent_note', { createdAt: at(1) }),
    agentComment('d1', 'a-alice', 'delegate_request', { assigneeAgentId: 'a-ben', reviewerAgentId: 'a-cara', reviewerScope: 'final', delegationStatus: 'queued', createdAt: at(2) }),
    agentComment('d2', 'a-ben', 'agent_delegated', { parentCommentId: 'd1', delegationStatus: 'waiting', createdAt: at(3) }),
    agentComment('d3', 'a-ben', 'delegate_report', { parentCommentId: 'd1', delegationStatus: 'submitted', createdAt: at(4) }),
    agentComment('d4', 'a-cara', 'final_review_approved', { parentCommentId: 'd3', delegationStatus: 'approved', createdAt: at(5) }),
    agentComment('r1', 'a-cara', 'review_note', { createdAt: at(6) }),
    agentComment('r2', 'a-cara', 'review_guidance', { createdAt: at(7) }),
    agentComment('r3', 'a-cara', 'review_waiting_on_children', { createdAt: at(8) }),
    agentComment('r4', 'a-cara', 'review_error', { createdAt: at(9) }),
    agentComment('p1', 'a-alice', 'peer_question', { assigneeAgentId: 'a-ben', delegationStatus: 'queued', metadata: { peerQuestion: true, targetSlug: 'ben' }, createdAt: at(10) }),
    agentComment('p2', 'a-ben', 'peer_answer', { parentCommentId: 'p1', createdAt: at(11) }),
    agentComment('q1', 'a-alice', 'peer_question', { assigneeAgentId: 'a-ben', delegationStatus: 'done', metadata: { peerQuestion: true, brainstorm: true, round: 1, departmentName: 'X' }, createdAt: at(12) }),
    agentComment('b1', 'a-alice', 'brainstorm_opened', { metadata: { round: 1, departmentIds: ['d1'] }, createdAt: at(11) }),
    comment('u1', { action: 'escalate_to_reviewer', createdAt: at(13) }),
    agentComment('x1', 'a-ben', 'delegate_failed', { parentCommentId: 'd1', delegationStatus: 'failed', createdAt: at(14) }),
    comment('m1', { action: 'peer_question', parentCommentId: 'h1', authorType: 'user', assigneeAgentId: 'a-ben', delegationStatus: 'queued', metadata: { peerQuestion: true, mention: true, targetSlug: 'ben', sourceCommentId: 'h1' }, createdAt: at(15) }),
  ];
  const expected = comments.filter(isDelegationReviewComment).map((row) => `c-${row.id}`).sort();
  assert.ok(expected.length >= 10, 'the oracle should select a meaningful subset');
  const filtered = build({ comments }, { filter: 'delegationReview' });
  const shown = new Set(flatEvents(filtered.items).map((event) => event.id));
  const missing = expected.filter((id) => !shown.has(id));
  assert.deepEqual(missing, []);
  assert.ok(shown.has('c-m1'), 'the mention question is reachable');
  assert.ok(shown.has('c-h1'), 'its source comment is shown as the thread root');
  assert.ok(!shown.has('c-n1'), 'a plain agent note is not a delegation / review row');
  const all = build({ comments });
  assert.equal(flatEvents(all.items).length, comments.length, 'no classifier drops a row');
  for (const row of comments) {
    const event = flatEvents(all.items).find((item) => item.id === `c-${row.id}`);
    assert.ok(event, `${row.id} missing`);
    if (isDelegationReviewComment(row)) assert.ok(event.kind === 'delegation' || event.kind === 'review' || event.delegationReview, `${row.id} not reachable from the delegation / review filter`);
  }
});

test('parity B: buildCommentPayload is bit-identical to the body kanban-board.tsx posts today', () => {
  type Mode = Parameters<typeof buildCommentPayload>[0];
  function legacyBody(commentAction: Mode, commentBody: string, commentAgentId: string, commentDelegateAssigneeId: string, commentDelegateReviewerId: string, commentDelegateScope: 'phase' | 'final', selected: Pick<Card, 'assigneeId' | 'reviewerId'>) {
    const effectiveAction = commentAgentId ? 'agent_note' : commentAction;
    return JSON.stringify({
      body: commentBody.trim(),
      action: effectiveAction,
      agentId: commentAgentId || null,
      assigneeAgentId: effectiveAction === 'delegate_to_agent' ? commentDelegateAssigneeId : null,
      reviewerAgentId: effectiveAction === 'delegate_to_agent' ? commentDelegateReviewerId || selected.assigneeId || selected.reviewerId || null : null,
      reviewerScope: effectiveAction === 'delegate_to_agent' ? commentDelegateScope : null,
    });
  }
  const modes: Mode[] = ['comment', 'agent_note', 'send_to_agent', 'continue_run', 'pause_agent', 'escalate_to_reviewer', 'delegate_to_agent'];
  const cases: Array<{ agentId: string; assignee: string; reviewer: string; scope: 'phase' | 'final'; card: Pick<Card, 'assigneeId' | 'reviewerId'> }> = [
    { agentId: '', assignee: 'a-ben', reviewer: 'a-cara', scope: 'phase', card },
    { agentId: '', assignee: 'a-ben', reviewer: '', scope: 'final', card },
    { agentId: '', assignee: 'a-ben', reviewer: '', scope: 'phase', card: { assigneeId: null, reviewerId: 'a-cara' } },
    { agentId: '', assignee: '', reviewer: '', scope: 'phase', card: { assigneeId: null, reviewerId: null } },
    { agentId: 'a-ben', assignee: 'a-cara', reviewer: 'a-alice', scope: 'final', card },
  ];
  for (const mode of modes) {
    for (const item of cases) {
      const expected = legacyBody(mode, '  hello  ', item.agentId, item.assignee, item.reviewer, item.scope, item.card);
      const actual = JSON.stringify(buildCommentPayload(mode, { body: '  hello  ', agentId: item.agentId, delegateAssigneeId: item.assignee, delegateReviewerId: item.reviewer, delegateScope: item.scope }, item.card));
      assert.equal(actual, expected, `${mode} ${JSON.stringify(item)}`);
    }
  }
  const delegate = buildCommentPayload('delegate_to_agent', { body: 'x', agentId: '', delegateAssigneeId: 'a-ben', delegateReviewerId: '', delegateScope: 'phase' }, card);
  assert.equal(delegate.reviewerAgentId, 'a-alice', 'reviewer falls back to the card assignee, then the card reviewer');
  assert.equal(delegate.reviewerScope, 'phase', 'reviewerScope is always sent for delegations');
});

// --- lower-level helpers --------------------------------------------------------------

test('classifyLog / classifyAction / dedupeByExactKeys / foldSystemRuns / assembleThreads work standalone', () => {
  assert.equal(classifyLog(log('l', { type: 'lock_expired', status: 'warning' }), ctx).kind, 'alert');
  assert.equal(classifyLog(log('l', { type: 'budget', status: 'failed' }), ctx).kind, 'alert');
  assert.equal(classifyLog(log('l', { type: 'budget', status: 'queued' }), ctx).hidden, true);
  assert.equal(classifyLog(log('l', { type: 'message_review', status: 'warning' }), ctx).kind, 'delegation');
  assert.equal(classifyAction(action('a', { action: 'integration.conflict', actorType: 'user', actorId: 'u-1' }), ctx).labelKey, 'kanban.event.integration_conflict');
  assert.equal(classifyAction(action('a', { action: 'context.injected', actorType: 'system', actorId: 'system' }), ctx).hidden, true);
  const events = [
    classifyComment(comment('c1', { action: 'continue_run', createdAt: at(0) }), ctx),
    classifyAction(action('a1', { action: 'resume', actorType: 'user', actorId: 'u-1', fromStatus: 'blocked', toStatus: 'todo', metadata: { commentId: 'c1' }, createdAt: at(0) }), ctx),
  ];
  const { kept, dropped } = dedupeByExactKeys(events, agents);
  assert.deepEqual(kept.map((event) => event.id), ['c-c1']);
  assert.deepEqual(dropped.map((event) => event.id), ['a-a1']);
  assert.deepEqual(kept[0]?.chips, [{ kind: 'consequence', text: 'todo', status: 'todo' }]);
  assert.equal(events[0]?.chips.length, 0, 'dedupe does not mutate its input');
  const folded = foldSystemRuns([
    { type: 'event', event: classifyLog(log('s1', { type: 'lock', status: 'running' }), ctx) },
    { type: 'event', event: classifyLog(log('s2', { type: 'queue', status: 'queued' }), ctx) },
    { type: 'event', event: classifyComment(comment('c1'), ctx) },
    { type: 'event', event: classifyLog(log('s3', { type: 'dispatch', status: 'running' }), ctx) },
  ]);
  assert.deepEqual(folded.map((item) => item.type), ['fold', 'event', 'fold']);
  const items = assembleThreads([classifyComment(agentComment('d1', 'a-alice', 'delegate_request', { assigneeAgentId: 'a-ben', delegationStatus: 'queued' }), ctx)]);
  assert.equal(items[0]?.type, 'thread');
  assert.equal(items.length, 1);
});

test('highlightMentions bolds @slug tokens by the server rule and ignores e-mail addresses', () => {
  const mentionAgents = agents.map((agent) => ({ slug: agent.slug, name: agent.name }));
  assert.deepEqual(highlightMentions('hi @ben and @cara', mentionAgents), [
    { type: 'text', text: 'hi ' },
    { type: 'mention', text: '@ben', slug: 'ben', known: true },
    { type: 'text', text: ' and ' },
    { type: 'mention', text: '@cara', slug: 'cara', known: true },
  ]);
  assert.deepEqual(highlightMentions('mail a@b.com now', mentionAgents), [{ type: 'text', text: 'mail a@b.com now' }]);
  assert.deepEqual(highlightMentions('@alice: go', mentionAgents), [
    { type: 'mention', text: '@alice', slug: 'alice', known: true },
    { type: 'text', text: ': go' },
  ]);
  assert.deepEqual(highlightMentions('(@ben)', mentionAgents), [
    { type: 'text', text: '(' },
    { type: 'mention', text: '@ben', slug: 'ben', known: true },
    { type: 'text', text: ')' },
  ]);
  assert.deepEqual(highlightMentions('ping @nobody and @client', mentionAgents).filter((segment) => segment.type === 'mention'), [
    { type: 'mention', text: '@nobody', slug: 'nobody', known: false },
    { type: 'mention', text: '@client', slug: 'client', known: true },
  ]);
  assert.deepEqual(highlightMentions('', mentionAgents), []);
  assert.deepEqual(highlightMentions('no mentions here', []), [{ type: 'text', text: 'no mentions here' }]);
  assert.deepEqual(highlightMentions('@Ben_2.x-y', []).map((segment) => segment.text), ['@Ben_2.x-y']);
});

test('mentionCandidates prefix-matches slug or name, case-insensitively, at most 6', () => {
  const pool = ['alice', 'ben', 'bella', 'cara', 'dana', 'erin', 'frank', 'gina'].map((slug) => ({ slug, name: slug[0]!.toUpperCase() + slug.slice(1) }));
  assert.deepEqual(mentionCandidates('b', pool).map((agent) => agent.slug), ['ben', 'bella']);
  assert.deepEqual(mentionCandidates('BE', pool).map((agent) => agent.slug), ['ben', 'bella']);
  assert.deepEqual(mentionCandidates('Ca', pool).map((agent) => agent.slug), ['cara']);
  assert.equal(mentionCandidates('', pool).length, 6);
  assert.deepEqual(mentionCandidates('z', pool), []);
  const named = [{ slug: 'ceo-01', name: 'Alice Wong' }, { slug: 'alice-2', name: 'Other' }];
  assert.deepEqual(mentionCandidates('ali', named).map((agent) => agent.slug), ['ceo-01', 'alice-2']);
});

// --- render window (PR-3) -----------------------------------------------------------

test('sliceConversationWindow keeps the head when newest-first and the tail when oldest-first, markers riding with their rows', async () => {
  const { sliceConversationWindow, oldestItemTime, isConversationRow, EMPTY_CONVERSATION } = await import('./card-conversation.ts');
  const day = (at: number): ConversationItem => ({ type: 'day', at });
  const ev = (id: string, at: number): ConversationItem => ({ type: 'event', event: classifyComment(comment(id, { createdAt: new Date(at).toISOString() }), ctx) });
  const horizon: ConversationItem = { type: 'horizon', at: 1 };
  // newest-first: [day, e5, e4, day, e3, e2, day, e1, horizon]
  const newest: ConversationItem[] = [day(50), ev('e5', 50), ev('e4', 40), day(30), ev('e3', 30), ev('e2', 20), day(10), ev('e1', 10), horizon];
  const head = sliceConversationWindow(newest, 'newest', 3);
  assert.deepEqual(head.visible.map((item) => (item.type === 'event' ? item.event.id : item.type)), ['day', 'c-e5', 'c-e4', 'day', 'c-e3']);
  assert.equal(head.hiddenCount, 2);
  assert.equal(oldestItemTime(head.visible), 30);
  // oldest-first: [horizon, day, e1, day, e2, e3, day, e4, e5]
  const oldest: ConversationItem[] = [horizon, day(10), ev('e1', 10), day(20), ev('e2', 20), ev('e3', 30), day(40), ev('e4', 40), ev('e5', 50)];
  const tail = sliceConversationWindow(oldest, 'oldest', 3);
  assert.deepEqual(tail.visible.map((item) => (item.type === 'event' ? item.event.id : item.type)), ['c-e3', 'day', 'c-e4', 'c-e5']);
  assert.equal(tail.hiddenCount, 2);
  const tailTwo = sliceConversationWindow(oldest, 'oldest', 2);
  assert.deepEqual(tailTwo.visible.map((item) => (item.type === 'event' ? item.event.id : item.type)), ['day', 'c-e4', 'c-e5']);
  // everything fits: untouched, horizon included
  const all = sliceConversationWindow(oldest, 'oldest', 60);
  assert.equal(all.visible, oldest);
  assert.equal(all.hiddenCount, 0);
  assert.equal(sliceConversationWindow(newest, 'newest', 0).visible.filter(isConversationRow).length, 1);
  assert.equal(oldestItemTime([]), 0);
  assert.equal(oldestItemTime([day(5)]), 0);
  assert.deepEqual(EMPTY_CONVERSATION.items, []);
  assert.equal(EMPTY_CONVERSATION.counts.all, 0);
});

test('sliceConversationWindow counts threads and folds as one row each and reads their oldest time', async () => {
  const { sliceConversationWindow, oldestItemTime } = await import('./card-conversation.ts');
  const result = build({
    comments: [
      comment('req', { action: 'delegate_request', authorType: 'agent', agentId: 'a-alice', assigneeAgentId: 'a-ben', delegationStatus: 'done', createdAt: at(0) }),
      agentComment('rep', 'a-ben', 'delegate_report', { parentCommentId: 'req', createdAt: at(100) }),
      comment('h1', { createdAt: at(200) }),
    ],
    logs: [log('s1', { type: 'lock', createdAt: at(300) }), log('s2', { type: 'queue', createdAt: at(301) })],
  });
  const rows = result.items.filter((item) => item.type !== 'day');
  assert.deepEqual(rows.map((item) => item.type), ['fold', 'event', 'thread']);
  const window = sliceConversationWindow(result.items, 'newest', 2);
  assert.equal(window.hiddenCount, 1);
  assert.deepEqual(window.visible.filter((item) => item.type !== 'day').map((item) => item.type), ['fold', 'event']);
  assert.equal(oldestItemTime(window.visible), T0 + 200_000);
  assert.equal(oldestItemTime(result.items), T0);
});
