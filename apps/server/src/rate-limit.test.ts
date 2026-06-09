import assert from 'node:assert/strict';
import test from 'node:test';
import { rateLimitPolicyForPath } from './rate-limit.ts';

test('rate limit policy classifies sensitive routes', () => {
  assert.equal(rateLimitPolicyForPath('POST', '/api/auth/login')?.key, 'auth');
  assert.equal(rateLimitPolicyForPath('POST', '/api/chat/sessions/id/messages')?.key, 'chat');
  assert.equal(rateLimitPolicyForPath('POST', '/api/webhook/task-complete')?.key, 'webhook');
  assert.equal(rateLimitPolicyForPath('POST', '/api/cron/run')?.key, 'operator');
  assert.equal(rateLimitPolicyForPath('GET', '/api/cron/runs')?.key, 'read');
  assert.equal(rateLimitPolicyForPath('GET', '/api/help'), null);
  assert.equal(rateLimitPolicyForPath('GET', '/health'), null);
});
