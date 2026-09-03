import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card, ReviewFinding, ReviewRound } from '../components/kanban/card-types.ts';
import { SYSTEM_MERGE_NOTE, displayFindings, findingIsOpen, findingLocation, fixState, humanGateOf, isSealedComment, latestClosedRound, openFindings, openReviewRound, panelDegraded, pendingHumanGate, roundForComment, sortRounds, stripFindingsTable, submittedCount } from './card-review.ts';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

function round(overrides: Partial<ReviewRound> = {}): ReviewRound {
  return {
    id: 'r-1', cardId: 'card-1', round: 1, kind: 'panel', level: 0,
    authorAgentId: 'a-intern', reviewerIds: ['a-senior', 'a-cto'],
    status: 'open', decision: null, openedAt: iso(HOUR), findings: [],
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f-1', roundId: 'r-1', round: 1, reviewerAgentId: 'a-senior', findingKey: 'R1-S-1',
    severity: 'P1', file: 'src/a.ts', line: 12, title: 'Unchecked null', evidence: 'line 12', requiredFix: 'guard it',
    reassign: false, disposition: null, dispositionReason: null, mergedInto: null,
    codeEvidence: null, testEvidence: null, verification: null, verificationNote: null,
    ...overrides,
  } as ReviewFinding;
}

test('rounds sort newest first and expose the open one', () => {
  const older = round({ id: 'r-old', round: 1, status: 'closed', decision: 'revision_requested', openedAt: iso(3 * HOUR) });
  const newer = round({ id: 'r-new', round: 2, openedAt: iso(HOUR) });
  assert.deepEqual(sortRounds([older, newer]).map((row) => row.id), ['r-new', 'r-old']);
  assert.equal(openReviewRound([older, newer])?.id, 'r-new');
  assert.equal(openReviewRound([older]), null);
  assert.equal(latestClosedRound([older, newer])?.id, 'r-old');
  assert.equal(latestClosedRound([older, newer], 'verify'), null);
  assert.equal(sortRounds(null).length, 0);
});

test('submitted seats count only the reviewers still on the round', () => {
  const open = round({ metadata: { verdicts: { 'a-senior': 'revision_requested', 'a-gone': 'approved' } } });
  assert.equal(submittedCount(open), 1);
  assert.equal(submittedCount(round()), 0);
  assert.equal(panelDegraded(round({ metadata: { panel_degraded: true } })), true);
  assert.equal(panelDegraded(round()), false);
});

test('a closed round folds the server merges into their primary and keeps the author merges visible', () => {
  const primary = finding({ id: 'f-1', findingKey: 'R1-S-1', severity: 'P1', reviewerAgentId: 'a-senior' });
  const duplicate = finding({ id: 'f-2', findingKey: 'R1-C-1', reviewerAgentId: 'a-cto', disposition: 'merged', mergedInto: 'R1-S-1', verificationNote: SYSTEM_MERGE_NOTE });
  const blocker = finding({ id: 'f-3', findingKey: 'R1-C-2', severity: 'P0', reviewerAgentId: 'a-cto', title: 'Data loss' });
  const authorMerged = finding({ id: 'f-4', findingKey: 'R1-S-2', severity: 'P2', disposition: 'merged', mergedInto: 'R1-C-2', verificationNote: 'same root cause' });

  const rows = displayFindings([primary, duplicate, blocker, authorMerged]);
  assert.deepEqual(rows.map((row) => row.findingKey), ['R1-C-2', 'R1-S-1', 'R1-S-2'], 'P0 first, then by key');
  const folded = rows.find((row) => row.findingKey === 'R1-S-1');
  assert.deepEqual(folded?.reviewerIds, ['a-senior', 'a-cto'], 'both reviewers raised it');
  assert.deepEqual(folded?.mergedKeys, ['R1-C-1']);
  assert.ok(rows.some((row) => row.findingKey === 'R1-S-2'), 'an author merge stays its own row');
});

test('open findings are the ones the author never answered or the verify round reopened', () => {
  const untouched = finding({ findingKey: 'A' });
  const adopted = finding({ id: 'f-2', findingKey: 'B', disposition: 'adopted', verification: 'verified' });
  const reopened = finding({ id: 'f-3', findingKey: 'C', disposition: 'rejected', verification: 'still_open' });
  assert.equal(findingIsOpen(untouched), true);
  assert.equal(findingIsOpen(adopted), false);
  assert.equal(findingIsOpen(reopened), true);
  assert.deepEqual(openFindings([untouched, adopted, reopened]).map((row) => row.findingKey), ['A', 'C']);
});

test('finding location, sealed seats and the stripped round message', () => {
  assert.equal(findingLocation({ file: 'src/a.ts', line: 12 }), 'src/a.ts:12');
  assert.equal(findingLocation({ file: 'src/a.ts', line: null }), 'src/a.ts');
  assert.equal(findingLocation({ file: null, line: 3 }), '');
  assert.equal(isSealedComment({ action: 'review_slot', metadata: { sealed: true } }), true);
  assert.equal(isSealedComment({ action: 'comment', metadata: null }), false);
  const stripped = stripFindingsTable('Round 1 closed: revision requested.\n\nFindings (2)\n| key | severity |\n| --- | --- |\n| R1-S-1 | P1 |\n\nNext: the author adjudicates.');
  assert.ok(!stripped.includes('|'), 'the markdown table is gone');
  assert.ok(!stripped.includes('Findings (2)'), 'so is its caption');
  assert.ok(stripped.startsWith('Round 1 closed: revision requested.'));
  assert.ok(stripped.endsWith('Next: the author adjudicates.'));
});

test('a comment finds its round by id, else by number and kind', () => {
  const panel = round({ id: 'r-1', round: 1, kind: 'panel', status: 'closed' });
  const verify = round({ id: 'r-2', round: 1, kind: 'verify', openedAt: iso(HOUR / 2) });
  assert.equal(roundForComment([panel, verify], { roundId: 'r-2' })?.id, 'r-2');
  assert.equal(roundForComment([panel, verify], { round: 1, reviewRoundKind: 'panel' })?.id, 'r-1');
  assert.equal(roundForComment([panel, verify], { roundId: 'gone', round: 1, reviewRoundKind: 'verify' })?.id, 'r-2');
  assert.equal(roundForComment([panel], { round: 9 }), null);
  assert.equal(roundForComment([panel], {}), null);
});

test('the human gate is read from a pending task_review approval only', () => {
  const payload = {
    humanGate: true, kind: 'fix_exhausted', reason: 'Fix rounds exhausted', trigger: 'rounds_exhausted', level: 2,
    findings: [{ key: 'R2-C-1', severity: 'P0', title: 'Data loss', file: 'src/a.ts', line: 4 }, { severity: 'P1' }],
  };
  const gate = humanGateOf({ type: 'task_review', status: 'pending', payload });
  assert.equal(gate?.kind, 'fix_exhausted');
  assert.equal(gate?.trigger, 'rounds_exhausted');
  assert.equal(gate?.level, 2);
  assert.equal(gate?.findings.length, 1, 'a finding without a key or title is dropped');
  assert.equal(gate?.findings[0]?.title, 'Data loss');

  assert.equal(humanGateOf({ type: 'task_review', status: 'approved', payload }), null, 'a decided approval is not a gate');
  assert.equal(humanGateOf({ type: 'client_checkpoint', status: 'pending', payload }), null);
  assert.equal(humanGateOf({ type: 'task_review', status: 'pending', payload: { reason: 'plain approval' } }), null);
  assert.equal(humanGateOf(null), null);
  assert.equal(humanGateOf({ type: 'task_review', status: 'pending', payload: { humanGate: true } })?.kind, 'client_approval', 'defaults to the client approval gate');
  assert.equal(pendingHumanGate([{ type: 'client_checkpoint', status: 'pending', payload }, { type: 'task_review', status: 'pending', payload }])?.kind, 'fix_exhausted');
  assert.equal(pendingHumanGate([]), null);
});

test('fix state appears only while the newest round sent the card back', () => {
  const base: Pick<Card, 'assigneeId' | 'reviewRound' | 'fixLevel' | 'revisionCount' | 'maxRevisions'> = {
    assigneeId: 'a-intern', reviewRound: 1, fixLevel: 0, revisionCount: 1, maxRevisions: 3,
  };
  const sentBack = round({ status: 'closed', decision: 'revision_requested' });
  const fixing = fixState(base, [sentBack]);
  assert.equal(fixing?.takenOver, false);
  assert.equal(fixing?.revision, 1);
  assert.equal(fixing?.maxRevisions, 3);

  assert.equal(fixState(base, [round({ status: 'closed', decision: 'approved' })]), null);
  assert.equal(fixState(base, [round({ status: 'open' })]), null, 'a round in flight is not a fix cycle');
  assert.equal(fixState({ ...base, reviewRound: 0 }, [sentBack]), null, 'a card that never had a round');
  assert.equal(fixState(base, []), null);

  // The boss took the card over: the round was authored by the intern, the card now sits with the senior.
  const takenOver = fixState({ ...base, assigneeId: 'a-senior', fixLevel: 1, revisionCount: 0 }, [sentBack]);
  assert.equal(takenOver?.takenOver, true);
  assert.equal(takenOver?.revision, 1, 'a reset counter still reads as the first round of this level');
});
