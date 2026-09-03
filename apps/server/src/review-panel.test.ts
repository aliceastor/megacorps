import assert from 'node:assert/strict';
import test from 'node:test';
import { composeReviewPanel, dispositionErrors, dispositionWarnings, findingIsOpen, formatDispositionRules, formatFindingsForPrompt, formatRoundClosedMessage, formatVerifyInstructions, isBlockingSeverity, mergeFindings, nextFixOwner, normalizeSeverity, panelRequired, roundDecision, takeoverTrigger, verificationDecision, type FindingRow, type PanelAgent } from './review-panel.ts';

const agent = (id: string, overrides: Partial<PanelAgent> = {}): PanelAgent => ({ id, isActive: true, departmentId: 'it', bossId: null, positionId: null, ...overrides });
const positions = [
  { id: 'pos-ceo', reviewDomain: null, isCompanyBoss: true },
  { id: 'pos-code', reviewDomain: 'code', isCompanyBoss: false },
  { id: 'pos-content', reviewDomain: 'content', isCompanyBoss: false },
  { id: 'pos-head', reviewDomain: null, isCompanyBoss: false },
];
const ceo = agent('ceo', { departmentId: null, positionId: 'pos-ceo' });
const head = agent('head', { bossId: 'ceo', positionId: 'pos-head' });
const alice = agent('alice', { bossId: 'head', positionId: 'pos-code' });
const bob = agent('bob', { bossId: 'head', positionId: 'pos-code' });
const carol = agent('carol', { bossId: 'head', positionId: 'pos-code', departmentId: 'ops' });
const dan = agent('dan', { bossId: 'head', positionId: 'pos-content' });
const departments = [{ id: 'it', headAgentId: 'head' }, { id: 'ops', headAgentId: null }];
const org = { agents: [ceo, head, alice, bob, carol, dan], positions, departments };

const finding = (key: string, overrides: Partial<FindingRow> = {}): FindingRow => ({
  key, reviewerId: 'bob', severity: 'P1', file: 'src/a.ts', line: 10, title: 'Null deref on empty list', evidence: 'crash', requiredFix: 'guard', reassign: false, ...overrides,
});

test('panelRequired follows the card mode first and the company default second', () => {
  assert.equal(panelRequired({ reviewMode: 'panel', critical: false }, 'never'), true);
  assert.equal(panelRequired({ reviewMode: 'single', critical: false }, 'always'), true);
  assert.equal(panelRequired({ reviewMode: 'single', critical: true }, 'critical_only'), true);
  assert.equal(panelRequired({ reviewMode: 'single', critical: false }, 'critical_only'), false);
  assert.equal(panelRequired({ reviewMode: 'single', critical: true }, 'never'), false);
  assert.equal(panelRequired({ reviewMode: 'single', critical: true }, null), true);
});

test('the panel is composed in the design order: explicit, department head, same department and domain', () => {
  const panel = composeReviewPanel({ ...org, authorId: 'alice', explicitReviewerIds: ['carol'], cardDomain: 'code' });
  assert.deepEqual(panel.reviewerIds, ['carol', 'head']);
  assert.equal(panel.degraded, false);
  assert.match(panel.reason, /explicit:carol, department_head:head/);
  const noExplicit = composeReviewPanel({ ...org, authorId: 'alice', cardDomain: 'code' });
  assert.deepEqual(noExplicit.reviewerIds, ['head', 'bob']);
});

test('cross-department domain matches come before the boss chain, and the chain is the last resort', () => {
  const noHead = composeReviewPanel({ ...org, departments: [{ id: 'it', headAgentId: null }], agents: [ceo, head, alice, carol, dan], authorId: 'alice', cardDomain: 'code' });
  assert.deepEqual(noHead.reviewerIds, ['carol', 'head']);
  const noDomain = composeReviewPanel({ ...org, departments: [{ id: 'it', headAgentId: null }], authorId: 'alice', cardDomain: null });
  assert.deepEqual(noDomain.reviewerIds, ['head']);
  assert.equal(noDomain.degraded, true);
});

test('the author, inactive agents and the company boss are never on the panel', () => {
  const panel = composeReviewPanel({ ...org, agents: [ceo, head, alice, agent('bob', { bossId: 'head', positionId: 'pos-code', isActive: false })], authorId: 'alice', explicitReviewerIds: ['alice', 'ceo', 'bob'], cardDomain: 'code' });
  assert.deepEqual(panel.reviewerIds, ['head']);
  const headAuthor = composeReviewPanel({ ...org, authorId: 'head', cardDomain: null });
  assert.deepEqual(headAuthor.reviewerIds, []);
  assert.match(headAuthor.reason, /no eligible reviewer/);
});

test('the panel size is configurable and explicit reviewers are kept before the org fills the rest', () => {
  const one = composeReviewPanel({ ...org, authorId: 'alice', cardDomain: 'code', size: 1 });
  assert.deepEqual(one.reviewerIds, ['head']);
  assert.equal(one.degraded, true);
  const three = composeReviewPanel({ ...org, authorId: 'alice', cardDomain: 'code', size: 3 });
  assert.deepEqual(three.reviewerIds, ['head', 'bob', 'carol']);
  const verify = composeReviewPanel({ ...org, authorId: 'alice', explicitReviewerIds: ['bob', 'carol'], cardDomain: 'code' });
  assert.deepEqual(verify.reviewerIds, ['bob', 'carol']);
  const refill = composeReviewPanel({ ...org, agents: [ceo, head, alice, bob, agent('carol', { bossId: 'head', positionId: 'pos-code', departmentId: 'ops', isActive: false }), dan], authorId: 'alice', explicitReviewerIds: ['bob', 'carol'], cardDomain: 'code' });
  assert.deepEqual(refill.reviewerIds, ['bob', 'head']);
});

test('severity helpers normalize case and treat only P0 and P1 as blocking', () => {
  assert.equal(normalizeSeverity(' p0 '), 'P0');
  assert.equal(normalizeSeverity('P1'), 'P1');
  assert.equal(normalizeSeverity('nonsense'), 'P2');
  assert.equal(normalizeSeverity(null), 'P2');
  assert.equal(isBlockingSeverity('p1'), true);
  assert.equal(isBlockingSeverity('P2'), false);
});

test('mergeFindings collapses the same file, line and title, keeps the harsher severity and lists both reviewers', () => {
  const merged = mergeFindings([
    finding('R1-AB1-1', { reviewerId: 'alice', severity: 'P2', title: 'Null deref on empty list' }),
    finding('R1-BC2-1', { reviewerId: 'bob', severity: 'P0', title: 'Null-deref, on empty list!', reassign: true }),
    finding('R1-AB1-2', { reviewerId: 'alice', severity: 'P1', line: 42, title: 'Missing test' }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.key, 'R1-BC2-1');
  assert.equal(merged[0]?.severity, 'P0');
  assert.deepEqual(merged[0]?.reviewerIds, ['alice', 'bob']);
  assert.deepEqual(merged[0]?.mergedKeys, ['R1-AB1-1']);
  assert.deepEqual(merged[0]?.reassignedBy, ['bob']);
  assert.equal(merged[0]?.reassign, false);
  assert.equal(merged[1]?.key, 'R1-AB1-2');
  assert.deepEqual(merged[1]?.reviewerIds, ['alice']);
});

test('roundDecision approves only unanimous approvals with no open P0/P1', () => {
  assert.equal(roundDecision({ findings: [finding('a', { severity: 'P2' })], verdicts: ['approved', 'approved'] }), 'approved');
  assert.equal(roundDecision({ findings: [finding('a', { severity: 'P1' })], verdicts: ['approved', 'approved'] }), 'revision_requested');
  assert.equal(roundDecision({ findings: [], verdicts: ['approved', 'revision_requested'] }), 'revision_requested');
  assert.equal(roundDecision({ findings: [], verdicts: ['approved', 'escalate'] }), 'revision_requested');
  assert.equal(roundDecision({ findings: [], verdicts: [] }), 'revision_requested');
  assert.equal(roundDecision({ findings: [finding('a', { severity: 'P0', disposition: 'adopted', verification: 'verified' })], verdicts: ['approved'] }), 'approved');
});

test('dispositionErrors demands an answer for every finding and a real reason to reject a P0/P1', () => {
  const findings = [finding('R1-A1-1', { severity: 'P0' }), finding('R1-A1-2', { severity: 'P2' })];
  const missing = dispositionErrors(findings, [{ findingKey: 'R1-A1-1', disposition: 'adopted' }]);
  assert.equal(missing.length, 1);
  assert.match(missing[0] ?? '', /disposition_missing: finding R1-A1-2/);
  const badReject = dispositionErrors(findings, [{ findingKey: 'r1-a1-1', disposition: 'rejected', reason: 'no' }, { findingKey: 'R1-A1-2', disposition: 'rejected' }]);
  assert.equal(badReject.length, 1);
  assert.match(badReject[0] ?? '', /disposition_reason_required: R1-A1-1/);
  const ok = dispositionErrors(findings, [{ findingKey: 'R1-A1-1', disposition: 'rejected', reason: 'unreachable: the list is validated non-empty at the API boundary' }, { findingKey: 'R1-A1-2', disposition: 'adopted', codeEvidence: 'commit abc' }]);
  assert.deepEqual(ok, []);
});

test('merged dispositions must point at another finding of the round, and adopted without evidence is only a warning', () => {
  const findings = [finding('K1'), finding('K2')];
  const selfMerge = dispositionErrors(findings, [{ findingKey: 'K1', disposition: 'merged', mergedInto: 'K1' }, { findingKey: 'K2', disposition: 'adopted' }]);
  assert.match(selfMerge.join('\n'), /disposition_merge_target_invalid: K1/);
  const unknownMerge = dispositionErrors(findings, [{ findingKey: 'K1', disposition: 'merged', mergedInto: 'K9' }, { findingKey: 'K2', disposition: 'adopted' }]);
  assert.match(unknownMerge.join('\n'), /disposition_merge_target_invalid: K1/);
  const goodMerge = dispositionErrors(findings, [{ findingKey: 'K1', disposition: 'merged', mergedInto: 'k2' }, { findingKey: 'K2', disposition: 'adopted' }]);
  assert.deepEqual(goodMerge, []);
  const warnings = dispositionWarnings(findings, [{ findingKey: 'K1', disposition: 'merged', mergedInto: 'K2' }, { findingKey: 'K2', disposition: 'adopted' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /evidence_missing: K2/);
});

test('verificationDecision approves when adopted findings are verified and rejections are not contested', () => {
  const findings = [finding('A', { disposition: 'adopted' }), finding('B', { disposition: 'rejected' }), finding('C', { disposition: 'merged' })];
  const approved = verificationDecision(findings, [{ findingKey: 'A', status: 'verified' }, { findingKey: 'B', status: 'verified' }]);
  assert.deepEqual(approved, { decision: 'approved', openKeys: [] });
  const contested = verificationDecision(findings, [{ findingKey: 'a', status: 'verified' }, { findingKey: 'B', status: 'still_open' }, { findingKey: 'C', status: 'still_open' }]);
  assert.deepEqual(contested, { decision: 'revision_requested', openKeys: ['B', 'C'] });
});

test('an adopted finding nobody verified, or one verifier contested, stays open', () => {
  const findings = [finding('A', { disposition: 'adopted' })];
  assert.deepEqual(verificationDecision(findings, []), { decision: 'revision_requested', openKeys: ['A'] });
  assert.deepEqual(verificationDecision(findings, [{ findingKey: 'A', status: 'verified' }, { findingKey: 'A', status: 'still_open' }]), { decision: 'revision_requested', openKeys: ['A'] });
  assert.equal(findingIsOpen({ disposition: null, verification: null }), true);
  assert.equal(findingIsOpen({ disposition: 'adopted', verification: null }), false);
  assert.equal(findingIsOpen({ disposition: 'adopted', verification: 'still_open' }), true);
});

test('takeoverTrigger fires on escalation, an exhausted revision budget, or a unanimous reassign flag on a P0', () => {
  assert.equal(takeoverTrigger({ escalation: { reason: 'beyond me' }, revisionCount: 0, maxRevisions: 3, findings: [] }), 'escalation');
  assert.equal(takeoverTrigger({ revisionCount: 3, maxRevisions: 3, findings: [] }), 'rounds_exhausted');
  assert.equal(takeoverTrigger({ revisionCount: 2, maxRevisions: 3, findings: [] }), null);
  const p0 = { severity: 'P0' as const, reassign: false, reassignedBy: ['alice', 'bob'] };
  assert.equal(takeoverTrigger({ revisionCount: 0, maxRevisions: 3, findings: [p0], reviewerIds: ['alice', 'bob'] }), 'reassign_flagged');
  assert.equal(takeoverTrigger({ revisionCount: 0, maxRevisions: 3, findings: [{ ...p0, reassignedBy: ['alice'] }], reviewerIds: ['alice', 'bob'] }), null);
  assert.equal(takeoverTrigger({ revisionCount: 0, maxRevisions: 3, findings: [{ ...p0, severity: 'P1' }], reviewerIds: ['alice', 'bob'] }), null);
  assert.equal(takeoverTrigger({ revisionCount: 0, maxRevisions: 3, findings: [{ severity: 'P0', reassign: true }] }), 'reassign_flagged');
});

test('nextFixOwner climbs one step up the boss chain inside the department and stops at the head or the CEO', () => {
  const agents = [
    { id: 'ceo', bossId: null, isActive: true, isCompanyBoss: true },
    { id: 'head', bossId: 'ceo', isActive: true },
    { id: 'alice', bossId: 'head', isActive: true },
    { id: 'bob', bossId: 'zed', isActive: true },
    { id: 'zed', bossId: 'head', isActive: false },
  ];
  assert.equal(nextFixOwner({ authorId: 'alice', agents, departmentHeadId: 'head' }), 'head');
  assert.equal(nextFixOwner({ authorId: 'head', agents, departmentHeadId: 'head' }), null);
  assert.equal(nextFixOwner({ authorId: 'head', agents, departmentHeadId: null }), null);
  assert.equal(nextFixOwner({ authorId: 'bob', agents, departmentHeadId: 'head' }), null);
  assert.equal(nextFixOwner({ authorId: null, agents, departmentHeadId: 'head' }), null);
});

test('formatFindingsForPrompt and the disposition rules give the author keys, severities and the report shape', () => {
  const text = formatFindingsForPrompt([{ ...finding('R1-AB1-1', { severity: 'P0', reassign: true }), reviewerIds: ['alice', 'bob'] }, finding('R1-AB1-2', { disposition: 'rejected', dispositionReason: 'unreachable', verification: 'still_open', verificationNote: 'it is reachable via the import path' })]);
  assert.match(text, /\[P0\] R1-AB1-1 src\/a\.ts:10 - Null deref on empty list \(raised independently by 2 reviewers\) \[reassign flagged\]/);
  assert.match(text, /your previous disposition: rejected - unreachable/);
  assert.match(text, /verifier says still open: it is reachable via the import path/);
  assert.equal(formatFindingsForPrompt([]), 'No open findings.');
  const rules = formatDispositionRules();
  assert.match(rules, /"dispositions"/);
  assert.match(rules, /adopted/);
  assert.match(rules, /rejected/);
  assert.match(rules, /merged/);
  assert.match(rules, /"escalation"/);
});

test('formatVerifyInstructions lists each disposition with its evidence and asks for verifications', () => {
  const text = formatVerifyInstructions([finding('K1', { disposition: 'adopted', codeEvidence: 'commit abc', testEvidence: 'npm test green' }), finding('K2', { disposition: 'merged', mergedInto: 'K1' })]);
  assert.match(text, /K1 src\/a\.ts:10 - Null deref/);
  assert.match(text, /code evidence: commit abc/);
  assert.match(text, /disposition: merged \(merged into K1\)/);
  assert.match(text, /test evidence: none given/);
  assert.match(text, /"verifications"/);
});

test('formatRoundClosedMessage names reviewers, absentees, the decision and the open keys', () => {
  const panel = formatRoundClosedMessage({ round: 1, kind: 'panel', decision: 'revision_requested', reviewerNames: ['Alice', 'Bob'], absentNames: ['Bob'], degraded: false }, [{ ...finding('R1-A1-1', { severity: 'P0' }), reviewerIds: ['alice'] }]);
  assert.match(panel, /Blind panel review round 1 closed: revision requested\./);
  assert.match(panel, /Absent \(no answer before the timeout\): Bob/);
  assert.match(panel, /\| R1-A1-1 \| P0 \| src\/a\.ts:10 \| Null deref on empty list \| 1 \|/);
  assert.match(panel, /Open findings to answer: R1-A1-1\./);
  const verify = formatRoundClosedMessage({ round: 1, kind: 'verify', decision: 'approved', reviewerNames: ['Alice'], absentNames: [], degraded: true }, [finding('R1-A1-1', { disposition: 'adopted', verification: 'verified' })]);
  assert.match(verify, /panel_degraded/);
  assert.match(verify, /\| R1-A1-1 \| P1 \| adopted \| verified \| Null deref on empty list \|/);
  assert.match(verify, /the card proceeds/);
  assert.match(formatRoundClosedMessage({ round: 2, kind: 'panel', decision: 'unavailable', reviewerNames: [], absentNames: ['Bob'] }, []), /no reviewer answered/);
});
