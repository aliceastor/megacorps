import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTeamResourceView, type TeamMemberView } from './agent-cv.ts';

const member = (name: string): TeamMemberView => ({
  name, slug: name.toLowerCase(), id: name.toLowerCase(), positionName: 'Engineer', departmentName: 'Engineering',
  bossName: 'CTO', bossId: 'cto-id', isActive: true, eligibleForDelegation: false, capabilities: [], liveCards: 1,
  isBusy: false, maxConcurrent: 2, cv: [], recentScores: [], scoreCount: 0,
});
test('resource format bounds directory and per-person score evidence, and discloses omissions', () => {
  const people = Array.from({ length: 45 }, (_, i) => member(`Member${i}`));
  people[0]!.recentScores = Array.from({ length: 4 }, (_, i) => ({ id: `score-${i}`, cardId: 'card-id', reviewerId: 'reviewer-id', reviewerName: 'Reviewer', domain: 'code', score: 8, verdict: 'approved', createdAt: new Date('2026-09-13T00:00:00Z') }));
  people[0]!.scoreCount = 9;
  people[1]!.isActive = false;
  const text = formatTeamResourceView(people);
  assert.match(text, /5 company members omitted/);
  assert.match(text, /6 older score records omitted/);
  assert.ok(!text.includes('score-3'));
  assert.match(text, /2026-09-13T00:00:00.000Z.*code.*8\/10.*approved/);
  assert.match(text, /reviewer: Reviewer.*reviewer-id/);
  assert.match(text, /open assigned cards: 1; execution: idle; configured concurrency: 2/);
  assert.match(text, /Member1[^\n]*inactive/);
  assert.match(text, /Eligible delegation recipients.*none currently/);
  assert.ok(!text.includes('free'));
});
