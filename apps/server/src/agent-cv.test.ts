import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCv, formatTeamResourceView, parseReviewScore, summarizeCv, type ReviewScoreRow } from './agent-cv.ts';

const at = (daysAgo: number) => new Date(Date.UTC(2026, 8, 2) - daysAgo * 86_400_000);
const row = (domain: string, score: number, verdict: string, daysAgo: number): ReviewScoreRow => ({ domain, score, verdict, createdAt: at(daysAgo) });

test('parseReviewScore prefers the structured field and falls back to a Score line', () => {
  assert.equal(parseReviewScore({ score: 8 }, 'Score: 3'), 8);
  assert.equal(parseReviewScore({ score: 11 }, 'Score: 7/10'), 7);
  assert.equal(parseReviewScore(null, 'Overall score = 10'), 10);
  assert.equal(parseReviewScore(null, 'No number here'), null);
  assert.equal(parseReviewScore(null, 'score: 42'), null);
});

test('summarizeCv averages the latest twenty per domain and flags thin samples', () => {
  const rows: ReviewScoreRow[] = [
    ...Array.from({ length: 25 }, (_, i) => row('code', i < 5 ? 4 : 9, i < 5 ? 'revision_requested' : 'approved', 25 - i)),
    row('content', 6, 'approved', 1),
  ];
  const cv = summarizeCv(rows);
  const code = cv.find((item) => item.domain === 'code');
  const content = cv.find((item) => item.domain === 'content');
  assert.equal(code?.samples, 20);
  assert.equal(code?.average, 9);
  assert.equal(code?.approvedRate, 100);
  assert.equal(code?.thin, false);
  assert.equal(content?.samples, 1);
  assert.equal(content?.thin, true);
  assert.equal(cv[0]?.domain, 'code');
});

test('formatCv and the team view read like a manager briefing', () => {
  assert.equal(formatCv([]), 'no reviewed work yet');
  const view = formatTeamResourceView([
    { name: 'Ribel', slug: 'ribel', positionName: 'Engineer', departmentName: 'IT', capabilities: ['typescript', 'postgres'], liveCards: 2, isBusy: true, cv: summarizeCv([row('code', 8, 'approved', 1), row('code', 9, 'approved', 2)]), lastRejectReason: null },
    { name: 'Digby', slug: 'digby', positionName: null, departmentName: 'IT', capabilities: [], liveCards: 0, isBusy: false, cv: [], lastRejectReason: 'Missing tests for the SSO path.' },
  ]);
  assert.match(view, /Ribel \(slug: ribel, Engineer, IT\)/);
  assert.match(view, /load: 2 live card\(s\), busy right now/);
  assert.match(view, /code 8\.5\/10 over 2 \(thin sample\), 100% approved/);
  assert.match(view, /Digby.*\n.*load: 0 live card\(s\), free/);
  assert.match(view, /last rejection: Missing tests/);
  assert.match(view, /reviews are evidence/);
});
