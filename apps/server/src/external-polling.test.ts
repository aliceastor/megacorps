import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTERNAL_POLL_MAX, formatPollExhaustedMessage, formatPollPrompt, nextPollAt, pollDecision, type PollableWait } from './external-polling.ts';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000);

function wait(overrides: Partial<PollableWait> = {}): PollableWait {
  return { pollIntervalSeconds: 300, status: 'waiting', createdAt: ago(600), lastPolledAt: null, pollCount: 0, ...overrides };
}

test('a wait with no interval is never polled', () => {
  assert.deepEqual(pollDecision(wait({ pollIntervalSeconds: null }), NOW), { poll: false, reason: 'not_polled' });
  assert.equal(nextPollAt(wait({ pollIntervalSeconds: null })), null);
});

test('the first check waits one full interval after the card parked', () => {
  assert.deepEqual(pollDecision(wait({ createdAt: ago(600) }), NOW), { poll: true, attempt: 1, final: false });
  assert.deepEqual(pollDecision(wait({ createdAt: ago(120) }), NOW), { poll: false, reason: 'too_soon' });
  assert.equal(nextPollAt(wait({ createdAt: ago(600) }))?.toISOString(), new Date(NOW - 300_000).toISOString());
});

test('later checks are measured from the last one, not from the card parking', () => {
  assert.deepEqual(pollDecision(wait({ createdAt: ago(9000), lastPolledAt: ago(60), pollCount: 3 }), NOW), { poll: false, reason: 'too_soon' });
  assert.deepEqual(pollDecision(wait({ createdAt: ago(9000), lastPolledAt: ago(301), pollCount: 3 }), NOW), { poll: true, attempt: 4, final: false });
});

test('an interval below the floor is raised instead of hammering the system', () => {
  const impatient = wait({ pollIntervalSeconds: 1, lastPolledAt: ago(10) });
  assert.deepEqual(pollDecision(impatient, NOW), { poll: false, reason: 'too_soon' });
  assert.deepEqual(pollDecision({ ...impatient, lastPolledAt: ago(31) }, NOW), { poll: true, attempt: 1, final: false });
});

test('the budget is finite and the last check announces itself', () => {
  const nearly = wait({ pollCount: EXTERNAL_POLL_MAX - 1, lastPolledAt: ago(600) });
  assert.deepEqual(pollDecision(nearly, NOW), { poll: true, attempt: EXTERNAL_POLL_MAX, final: true });
  assert.deepEqual(pollDecision({ ...nearly, pollCount: EXTERNAL_POLL_MAX }, NOW), { poll: false, reason: 'budget_spent' });
});

test('a wait that is no longer waiting is left alone', () => {
  for (const status of ['resolved', 'superseded', 'cancelled', 'timeout']) {
    assert.deepEqual(pollDecision(wait({ status }), NOW), { poll: false, reason: 'not_waiting' }, status);
  }
});

test('the prompt tells the owner to look, never to redo the work', () => {
  const prompt = formatPollPrompt({
    provider: 'github', waitingFor: 'CI on PR 42', externalUrl: 'https://example.test/runs/1', externalId: 'run-1',
    attempt: 2, max: EXTERNAL_POLL_MAX, final: false, intervalSeconds: 300,
  });
  assert.match(prompt, /External check, not new work/);
  assert.match(prompt, /CI on PR 42/);
  assert.match(prompt, /https:\/\/example\.test\/runs\/1/);
  assert.match(prompt, /Check 2 of 24, roughly every 5 minutes/);
  assert.match(prompt, /Do not redo the work/);
  assert.match(prompt, /waiting_on_external/);
  assert.ok(!prompt.includes('last automatic check'), 'only the final check says so');

  const last = formatPollPrompt({
    provider: 'ci', waitingFor: 'nightly build', externalUrl: null, externalId: null,
    attempt: EXTERNAL_POLL_MAX, max: EXTERNAL_POLL_MAX, final: true, intervalSeconds: 60,
  });
  assert.match(last, /last automatic check/);
  assert.match(last, /roughly every 1 minute\./);
  assert.ok(!last.includes('Where to look'), 'no url, no line');
});

test('the exhausted message says what happens next', () => {
  const message = formatPollExhaustedMessage({ provider: 'github', waitingFor: 'CI on PR 42', max: EXTERNAL_POLL_MAX });
  assert.match(message, /Stopped polling github after 24 checks/);
  assert.match(message, /stays parked/);
});
