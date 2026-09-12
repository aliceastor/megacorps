import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './api.ts';
import { chatJobPollInterval, chatPollRetryDelay, shouldRetryChatPoll } from './chat-poll.ts';

test('pending jobs use a bounded two-second poll and terminal jobs stop', () => {
  assert.equal(chatJobPollInterval([{ status: 'running' }]), 2_000);
  assert.equal(chatJobPollInterval([{ status: 'queued' }]), 2_000);
  assert.equal(chatJobPollInterval([{ status: 'completed' }]), false);
});

test('transient 429 retries honor Retry-After without an unbounded retry loop', () => {
  const throttled = new ApiError('rate_limited', 429, {}, 7_000);
  assert.equal(shouldRetryChatPoll(0, throttled), true);
  assert.equal(shouldRetryChatPoll(2, throttled), true);
  assert.equal(shouldRetryChatPoll(3, throttled), false);
  assert.equal(chatPollRetryDelay(0, throttled), 7_000);
  assert.equal(chatPollRetryDelay(0, new Error('offline')), 1_000);
});
