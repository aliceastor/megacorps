import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card } from '../components/kanban/card-types.ts';
import { describeSituation, type SituationContext } from './card-situation.ts';
import { formatTemplate } from './format.ts';
import { t } from './i18n.ts';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

const agents = [
  { id: 'a-alice', name: 'Alice', role: 'CEO' },
  { id: 'a-ben', name: 'Ben', role: 'Engineer' },
  { id: 'a-cara', name: 'Cara', role: 'Reviewer' },
];

function ctx(overrides: Partial<SituationContext> = {}): SituationContext {
  return {
    now: NOW,
    locale: 'zh-TW',
    tf: (key, vars) => formatTemplate(t('zh-TW', key), vars ?? {}),
    agents,
    ...overrides,
  };
}

function card(overrides: Partial<Card> = {}): Card {
  return { id: 'card-1', title: 'Card', body: '', columnStatus: 'todo', tags: [], priority: 0, assigneeId: 'a-alice', reviewerId: null, updatedAt: iso(HOUR), ...overrides };
}

test('todo / done / cancelled', () => {
  assert.equal(describeSituation(card({ columnStatus: 'todo' }), ctx()).key, 'kanban.situation.queued');
  const done = describeSituation(card({ columnStatus: 'done', completedAt: iso(2 * HOUR) }), ctx());
  assert.equal(done.key, 'kanban.situation.done');
  assert.equal(done.tone, 'success');
  assert.ok(done.text.includes('完成於'));
  assert.equal(describeSituation(card({ columnStatus: 'done' }), ctx()).key, 'kanban.situation.doneNoAt');
  assert.equal(describeSituation(card({ columnStatus: 'cancelled' }), ctx()).key, 'kanban.situation.cancelled');
});

test('waiting_on_client quotes the pending approval question and how long it has waited', () => {
  const approvals = [{ id: 'ap-1', type: 'client_checkpoint', status: 'pending', createdAt: iso(4 * HOUR), payload: { question: '先做 CMS 還是先做設計稿？' } }];
  const situation = describeSituation(card({ columnStatus: 'waiting_on_client' }), ctx({ approvals }));
  assert.equal(situation.key, 'kanban.situation.client');
  assert.equal(situation.tone, 'warning');
  assert.equal(situation.vars.question, '先做 CMS 還是先做設計稿？');
  assert.ok(String(situation.vars.waited).includes('4'));
  assert.ok(situation.text.includes('先做 CMS'));
});

test('waiting_on_client falls back to the latest client_checkpoint_asked comment, then to a question-less line', () => {
  const comments = [
    { id: 'c-old', body: 'old question', action: 'client_checkpoint_asked', authorType: 'agent', agentId: 'a-alice', createdAt: iso(10 * HOUR) },
    { id: 'c-new', body: 'newer question', action: 'client_checkpoint_asked', authorType: 'agent', agentId: 'a-alice', createdAt: iso(2 * HOUR) },
  ];
  const withComment = describeSituation(card({ columnStatus: 'waiting_on_client' }), ctx({ latestComments: comments }));
  assert.equal(withComment.vars.question, 'newer question');
  const bare = describeSituation(card({ columnStatus: 'waiting_on_client' }), ctx());
  assert.equal(bare.key, 'kanban.situation.clientNoQuestion');
});

test('waiting_on_brainstorm reports the round and the number of department heads', () => {
  const comments = [{ id: 'c-b', body: 'round', action: 'brainstorm_opened', authorType: 'agent', agentId: 'a-alice', createdAt: iso(HOUR), metadata: { round: 2, departmentIds: ['d1', 'd2', 'd3'] } }];
  const situation = describeSituation(card({ columnStatus: 'waiting_on_brainstorm', brainstormRound: 2 }), ctx({ latestComments: comments }));
  assert.equal(situation.key, 'kanban.situation.brainstorm');
  assert.deepEqual(situation.vars, { round: 2, count: 3 });
  const unloaded = describeSituation(card({ columnStatus: 'waiting_on_brainstorm', brainstormRound: 1 }), ctx());
  assert.equal(unloaded.key, 'kanban.situation.brainstormNoCount');
  assert.equal(unloaded.vars.round, 1);
});

test('a parent card counts live children, the ones waiting on you and the blocked ones', () => {
  const children = [
    { id: 'k1', title: 'CMS', columnStatus: 'waiting_on_client' },
    { id: 'k2', title: 'Design', columnStatus: 'in_review' },
    { id: 'k3', title: 'Migration', columnStatus: 'done' },
    { id: 'k4', title: 'Infra', columnStatus: 'blocked' },
  ];
  const situation = describeSituation(card({ columnStatus: 'in_progress', rollupStatus: 'waiting_on_children', splitRound: 2 }), ctx({ children }));
  assert.equal(situation.key, 'kanban.situation.childrenDetail');
  assert.equal(situation.vars.count, 3);
  assert.ok(String(situation.vars.roundSuffix).includes('第 2 輪'));
  assert.ok(String(situation.vars.clauses).includes('1 張等你回答'));
  assert.ok(String(situation.vars.clauses).includes('1 張受阻'));
  assert.equal(situation.tone, 'warning');
});

test('splitRound 0 never prints a round and a subtree without alerts has no clauses', () => {
  const children = [{ id: 'k1', title: 'A', columnStatus: 'in_progress' }, { id: 'k2', title: 'B', columnStatus: 'todo' }];
  const situation = describeSituation(card({ columnStatus: 'in_progress', splitRound: 0 }), ctx({ children }));
  assert.equal(situation.key, 'kanban.situation.children');
  assert.equal(situation.vars.roundSuffix, '');
  assert.equal(situation.vars.count, 2);
  assert.ok(!situation.text.includes('第 0 輪'));
  assert.ok(!situation.text.includes('輪'));
});

test('rollupStatus waiting_on_children without a loaded subtree says the children are pending', () => {
  const situation = describeSituation(card({ columnStatus: 'in_progress', rollupStatus: 'waiting_on_children' }), ctx({ children: null }));
  assert.equal(situation.key, 'kanban.situation.childrenPending');
});

test('integrating parent names the owner', () => {
  const situation = describeSituation(card({ columnStatus: 'in_progress', rollupStatus: 'integrating' }), ctx({ children: [] }));
  assert.equal(situation.key, 'kanban.situation.integrating');
  assert.equal(situation.vars.name, 'Alice');
});

test('in_review / needs_review name the reviewer, or you when the client approves', () => {
  const agentReview = describeSituation(card({ columnStatus: 'in_review', reviewerId: 'a-cara' }), ctx());
  assert.equal(agentReview.key, 'kanban.situation.review');
  assert.equal(agentReview.vars.name, 'Cara');
  const humanReview = describeSituation(card({ columnStatus: 'in_review', reviewerId: null, requiresApproval: true }), ctx());
  assert.equal(humanReview.vars.name, '你');
  const help = describeSituation(card({ columnStatus: 'needs_review', reviewerId: 'a-cara' }), ctx());
  assert.equal(help.key, 'kanban.situation.helpReview');
  assert.ok(help.text.includes('負責人求助'));
});

test('waiting_on_external shows the latest external log message', () => {
  const logs = [
    { id: 'l1', type: 'external', status: 'queued', message: 'Waiting for CI run #12', createdAt: iso(HOUR) },
    { id: 'l2', type: 'dispatch', status: 'success', message: 'Dispatched', createdAt: iso(HOUR / 2) },
  ];
  const situation = describeSituation(card({ columnStatus: 'waiting_on_external' }), ctx({ latestLogs: logs }));
  assert.equal(situation.key, 'kanban.situation.external');
  assert.equal(situation.vars.message, 'Waiting for CI run #12');
  assert.equal(describeSituation(card({ columnStatus: 'waiting_on_external' }), ctx()).key, 'kanban.situation.externalNoMessage');
});

test('blocked quotes the newest alert body clipped to 120 characters', () => {
  const longReason = 'x'.repeat(200);
  const comments = [{ id: 'c1', body: longReason, action: 'agent_error', authorType: 'agent', agentId: 'a-ben', createdAt: iso(HOUR) }];
  const logs = [{ id: 'l1', type: 'dispatch', status: 'failed', message: 'adapter timeout', createdAt: iso(3 * HOUR) }];
  const situation = describeSituation(card({ columnStatus: 'blocked' }), ctx({ latestComments: comments, latestLogs: logs }));
  assert.equal(situation.key, 'kanban.situation.blocked');
  assert.equal(situation.tone, 'danger');
  assert.equal(String(situation.vars.reason).length, 121);
  assert.ok(String(situation.vars.reason).endsWith('…'));
  const newerLog = describeSituation(card({ columnStatus: 'blocked' }), ctx({ latestComments: comments, latestLogs: [{ ...logs[0]!, createdAt: iso(HOUR / 4) }] }));
  assert.equal(newerLog.vars.reason, 'adapter timeout');
  assert.equal(describeSituation(card({ columnStatus: 'blocked' }), ctx()).key, 'kanban.situation.blockedNoReason');
});

test('in_progress with an active delegation summary describes the phase assignee and reviewer', () => {
  const delegationSummary = { phaseAssigneeId: 'a-ben', phaseReviewerId: 'a-cara', phaseStatus: 'running' };
  const situation = describeSituation(card({ columnStatus: 'in_progress' }), ctx({ delegationSummary }));
  assert.equal(situation.key, 'kanban.situation.delegation');
  assert.deepEqual(situation.vars, { assignee: 'Ben', reviewer: 'Cara' });
  const noReviewer = describeSituation(card({ columnStatus: 'in_progress' }), ctx({ delegationSummary: { phaseAssigneeId: 'a-ben', phaseStatus: 'queued' } }));
  assert.equal(noReviewer.key, 'kanban.situation.delegationNoReviewer');
});

test('a historical delegation summary is ignored and the owner is shown running instead', () => {
  const delegationSummary = { phaseAssigneeId: 'a-ben', phaseReviewerId: 'a-cara', phaseStatus: 'approved' };
  const situation = describeSituation(card({ columnStatus: 'in_progress', startedAt: iso(HOUR) }), ctx({ delegationSummary }));
  assert.equal(situation.key, 'kanban.situation.running');
  assert.equal(situation.vars.name, 'Alice');
  assert.ok(String(situation.vars.since).length > 0);
  const noStart = describeSituation(card({ columnStatus: 'in_progress', startedAt: null }), ctx());
  assert.equal(noStart.key, 'kanban.situation.runningNoSince');
});

test('an unknown status degrades to the raw status text', () => {
  const situation = describeSituation(card({ columnStatus: 'mystery' }), ctx());
  assert.equal(situation.key, 'kanban.situation.unknown');
  assert.equal(situation.text, 'mystery');
});

test('every situation key renders in all three locales without leaking tokens', () => {
  const keys = ['kanban.situation.client', 'kanban.situation.brainstorm', 'kanban.situation.childrenDetail', 'kanban.situation.integrating', 'kanban.situation.review', 'kanban.situation.helpReview', 'kanban.situation.external', 'kanban.situation.blocked', 'kanban.situation.delegation', 'kanban.situation.running', 'kanban.situation.queued', 'kanban.situation.done', 'kanban.situation.cancelled'];
  const vars = { question: 'q', waited: 'w', round: 1, count: 2, roundSuffix: '', clauses: 'c', name: 'n', message: 'm', reason: 'r', assignee: 'a', reviewer: 'v', since: 's', at: 't' };
  for (const locale of ['zh-TW', 'en', 'ja'] as const) {
    for (const key of keys) {
      const text = formatTemplate(t(locale, key), vars);
      assert.notEqual(text, key, `${locale} lacks ${key}`);
      assert.ok(!/\{[a-zA-Z]+\}/.test(text), `${locale} ${key} leaves a token: ${text}`);
    }
  }
});

test('a blind panel round reports how many seats have answered', () => {
  const rounds = [{
    id: 'r-1', cardId: 'card-1', round: 1, kind: 'panel', level: 0, authorAgentId: 'a-ben',
    reviewerIds: ['a-cara', 'a-alice'], status: 'open', decision: null, openedAt: iso(HOUR),
    metadata: { verdicts: { 'a-cara': 'revision_requested' } }, findings: [],
  }];
  const panel = describeSituation(card({ columnStatus: 'in_review', assigneeId: 'a-ben', reviewMode: 'panel' }), ctx({ reviewRounds: rounds }));
  assert.equal(panel.key, 'kanban.situation.panelReview');
  assert.deepEqual(panel.vars, { submitted: 1, total: 2 });

  const verify = describeSituation(card({ columnStatus: 'in_review', assigneeId: 'a-ben' }), ctx({ reviewRounds: [{ ...rounds[0]!, kind: 'verify' }] }));
  assert.equal(verify.key, 'kanban.situation.verifyReview');
});

test('the human gate outranks the round: fix exhausted, no reviewer, and plain client approval', () => {
  const gate = (payload: Record<string, unknown>) => [{ id: 'ap-1', type: 'task_review', status: 'pending', payload }];
  const inReview = card({ columnStatus: 'in_review', requiresApproval: true });
  assert.equal(describeSituation(inReview, ctx({ approvals: gate({ humanGate: true, kind: 'fix_exhausted' }) })).key, 'kanban.situation.fixExhausted');
  assert.equal(describeSituation(inReview, ctx({ approvals: gate({ humanGate: true, kind: 'review_unavailable' }) })).key, 'kanban.situation.reviewUnavailable');
  assert.equal(describeSituation(inReview, ctx({ approvals: gate({ humanGate: true }) })).key, 'kanban.situation.awaitingClient');
  assert.equal(describeSituation(inReview, ctx({ approvals: [{ id: 'ap-2', type: 'task_review', status: 'pending', payload: {} }] })).key, 'kanban.situation.awaitingClient');
});

test('a card sent back by a round is fixing, and shows the takeover once the boss holds it', () => {
  const closed = [{
    id: 'r-1', cardId: 'card-1', round: 1, kind: 'panel', level: 0, authorAgentId: 'a-ben',
    reviewerIds: ['a-cara'], status: 'closed', decision: 'revision_requested', openedAt: iso(2 * HOUR), findings: [],
  }];
  const fixing = describeSituation(card({ columnStatus: 'in_progress', assigneeId: 'a-ben', reviewRound: 1, revisionCount: 2, maxRevisions: 3 }), ctx({ reviewRounds: closed }));
  assert.equal(fixing.key, 'kanban.situation.fixing');
  assert.deepEqual(fixing.vars, { round: 2, max: 3 });

  const takenOver = describeSituation(
    card({ columnStatus: 'in_progress', assigneeId: 'a-cara', reviewRound: 1, fixLevel: 1, revisionCount: 0 }),
    ctx({ reviewRounds: closed }),
  );
  assert.equal(takenOver.key, 'kanban.situation.takenOver');
  assert.equal(takenOver.vars.name, 'Cara');
});
