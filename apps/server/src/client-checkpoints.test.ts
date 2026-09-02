import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointEligibilityError, checkpointFromOutput, checkpointFromQuestion, checkpointReminderDue, combineCheckpointAnswer, formatCheckpointAnswer, formatCheckpointMessage } from './client-checkpoints.ts';

test('checkpointFromOutput prefers the structured report and normalizes options', () => {
  const request = checkpointFromOutput('', { checkpoint: { kind: 'direction', question: 'Which stack?', options: [' Next.js ', '', 'Astro'], recommendation: ' Next.js ' } });
  assert.deepEqual(request, { kind: 'direction', question: 'Which stack?', options: ['Next.js', 'Astro'], recommendation: 'Next.js', artifactRefs: [] });
});

test('checkpointFromOutput reads a fenced report and returns null for plain output', () => {
  const fenced = ['Done so far.', '```json', '{ "kind": "megacorps-report", "status": "completed", "summary": "draft ready", "checkpoint": { "kind": "interim", "question": "Is the landing page draft what you had in mind?", "artifactRefs": ["deliverables/landing.md"] } }', '```'].join('\n');
  const request = checkpointFromOutput(fenced);
  assert.equal(request?.kind, 'interim');
  assert.deepEqual(request?.artifactRefs, ['deliverables/landing.md']);
  assert.equal(checkpointFromOutput('just prose, no report'), null);
});

test('an A2A question becomes a direction checkpoint', () => {
  assert.deepEqual(checkpointFromQuestion('  Should we drop IE11?  '), { kind: 'direction', question: 'Should we drop IE11?', options: [], recommendation: null, artifactRefs: [] });
});

test('only the owning CEO or department head may ask the client, one checkpoint at a time', () => {
  const base = { isOwner: true, isCompanyBoss: true, isDepartmentHead: false, alreadyPending: false };
  assert.equal(checkpointEligibilityError(base), null);
  assert.equal(checkpointEligibilityError({ ...base, isCompanyBoss: false, isDepartmentHead: true }), null);
  assert.match(checkpointEligibilityError({ ...base, isCompanyBoss: false }) ?? '', /client_checkpoint_not_allowed/);
  assert.match(checkpointEligibilityError({ ...base, isOwner: false }) ?? '', /client_checkpoint_not_owner/);
  assert.match(checkpointEligibilityError({ ...base, alreadyPending: true }) ?? '', /client_checkpoint_already_pending/);
});

test('reminders fire after the configured hours, then once a day', () => {
  const created = new Date('2026-09-02T08:00:00Z');
  const hours = (n: number) => new Date(created.getTime() + n * 3_600_000);
  assert.equal(checkpointReminderDue({ createdAt: created, lastRemindedAt: null }, hours(3), 4), false);
  assert.equal(checkpointReminderDue({ createdAt: created, lastRemindedAt: null }, hours(4), 4), true);
  assert.equal(checkpointReminderDue({ createdAt: created, lastRemindedAt: hours(4).toISOString() }, hours(10), 4), false);
  assert.equal(checkpointReminderDue({ createdAt: created, lastRemindedAt: hours(4).toISOString() }, hours(28), 4), true);
});

test('messages name the asker, list options, and record the answer', () => {
  const asked = formatCheckpointMessage({ kind: 'direction', question: 'Which stack?', options: ['Next.js', 'Astro'], recommendation: 'Next.js', artifactRefs: [] }, 'CEO');
  assert.match(asked, /CEO is asking the client \(direction decision\)/);
  assert.match(asked, /1\. Next\.js/);
  assert.match(asked, /Recommendation: Next\.js/);
  const answered = formatCheckpointAnswer({ question: 'Which stack?', answer: 'Go with Astro, keep it static.', selectedOption: 'Astro', decidedBy: 'ricky@example.com' });
  assert.match(answered, /Selected: Astro/);
  assert.match(answered, /keep it static/);
  assert.equal(combineCheckpointAnswer({ selectedOption: 'Astro', answer: '  ok ' }), 'Selected: Astro\nok');
  assert.equal(combineCheckpointAnswer({}), '');
});
