import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveFanoutCap, evaluateSplitPlan, formatSplitAnnouncement, type SplitAgentRef, type SplitContext } from './card-splitting.ts';

const agent = (slug: string, departmentId: string | null = 'dept-it'): SplitAgentRef => ({ id: `id-${slug}`, slug, name: slug.toUpperCase(), departmentId });
const alice = agent('alice', null);
const ribel = agent('ribel');
const digby = agent('digby');
const cto = agent('cto');
const writer = agent('writer', 'dept-content');

function context(overrides: Partial<SplitContext> = {}): SplitContext {
  const all = [alice, ribel, digby, cto, writer];
  return {
    parent: { id: 'card-1', splitRound: 0, decisionMode: 'auto' },
    splitter: alice,
    splitterIsCompanyBoss: false,
    directReports: [ribel, digby, writer],
    resolveAgent: (slug) => all.find((a) => a.slug === slug) ?? null,
    liveChildren: 0,
    maxChildrenPerCard: 3,
    ...overrides,
  };
}

const child = (assigneeSlug: string, extra: Record<string, unknown> = {}) => ({
  title: `Work for ${assigneeSlug}`,
  body: 'Build the thing end to end. Acceptance: tests green and the page renders the new list.',
  assigneeSlug,
  ...extra,
});

test('a valid plan yields candidates with the splitter as default reviewer and the next round number', () => {
  const result = evaluateSplitPlan(context(), [child('ribel'), child('digby')]);
  assert.ok(result.ok);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]?.reviewer.id, alice.id);
  assert.equal(result.round, 1);
});

test('splitting is only allowed downward to direct reports', () => {
  const result = evaluateSplitPlan(context(), [child('cto')]);
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /split_not_direct_report/);
});

test('the reviewer must exist and must not be the assignee', () => {
  const unknown = evaluateSplitPlan(context(), [child('ribel', { reviewerSlug: 'nobody' })]);
  assert.ok(!unknown.ok && /split_reviewer_unknown/.test(unknown.errors.join()));
  const self = evaluateSplitPlan(context(), [child('ribel', { reviewerSlug: 'ribel' })]);
  assert.ok(!self.ok && /split_reviewer_is_assignee/.test(self.errors.join()));
  const other = evaluateSplitPlan(context(), [child('ribel', { reviewerSlug: 'cto' })]);
  assert.ok(other.ok && other.candidates[0]?.reviewer.id === cto.id);
});

test('fan-out is capped by the company setting with a hard ceiling of five', () => {
  const four = [child('ribel'), child('digby'), child('writer'), child('ribel')];
  assert.ok(!evaluateSplitPlan(context({ maxChildrenPerCard: 3 }), four).ok);
  assert.ok(evaluateSplitPlan(context({ maxChildrenPerCard: 4 }), four).ok);
  assert.equal(effectiveFanoutCap(99), 5);
  assert.equal(effectiveFanoutCap(0), 1);
  assert.equal(effectiveFanoutCap(null), 3);
});

test('a live round blocks a new split, and rounds are finite', () => {
  const inProgress = evaluateSplitPlan(context({ liveChildren: 2 }), [child('ribel')]);
  assert.ok(!inProgress.ok && /split_round_in_progress/.test(inProgress.errors.join()));
  const exhausted = evaluateSplitPlan(context({ parent: { id: 'card-1', splitRound: 3, decisionMode: 'auto' } }), [child('ribel')]);
  assert.ok(!exhausted.ok && /split_rounds_exhausted/.test(exhausted.errors.join()));
});

test('solo mode forbids splitting', () => {
  const result = evaluateSplitPlan(context({ parent: { id: 'card-1', splitRound: 0, decisionMode: 'solo' } }), [child('ribel')]);
  assert.ok(!result.ok && /split_forbidden_solo/.test(result.errors.join()));
});

test('the company boss splits one card per department and is not bound by the numeric cap', () => {
  const boss = context({ splitterIsCompanyBoss: true, maxChildrenPerCard: 1 });
  const ok = evaluateSplitPlan(boss, [child('ribel'), child('writer')]);
  assert.ok(ok.ok);
  const duplicate = evaluateSplitPlan(boss, [child('ribel'), child('digby')]);
  assert.ok(!duplicate.ok && /split_department_duplicate/.test(duplicate.errors.join()));
});

test('dependencies must point inside the request and be acyclic', () => {
  const outside = evaluateSplitPlan(context(), [child('ribel', { dependsOn: [4] })]);
  assert.ok(!outside.ok && /split_dependency_invalid/.test(outside.errors.join()));
  const cycle = evaluateSplitPlan(context(), [child('ribel', { dependsOn: [1] }), child('digby', { dependsOn: [0] })]);
  assert.ok(!cycle.ok && /split_dependency_cycle/.test(cycle.errors.join()));
  const chain = evaluateSplitPlan(context(), [child('ribel'), child('digby', { dependsOn: [0] })]);
  assert.ok(chain.ok && chain.candidates[1]?.dependsOn.includes(0));
});

test('the announcement names every child, its assignee and its reviewer', () => {
  const text = formatSplitAnnouncement(1, [{ title: 'API', assignee: ribel, reviewer: cto, cardId: 'c-1' }, { title: 'Docs', assignee: writer, reviewer: alice, cardId: 'c-2' }]);
  assert.match(text, /Round 1: split into 2 child card/);
  assert.match(text, /1\. API → RIBEL \(reviewer CTO\) \[c-1\]/);
  assert.match(text, /2\. Docs → WRITER \(reviewer ALICE\)/);
});
