import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSessionId, estimateTokens } from './hermes.ts';

test('extracts Hermes session IDs from stdout', () => {
  assert.equal(extractSessionId('ok\nSession: 20260604_120102_abc123\n'), '20260604_120102_abc123');
});

test('estimates token count conservatively', () => {
  assert.equal(estimateTokens('12345678'), 2);
});
