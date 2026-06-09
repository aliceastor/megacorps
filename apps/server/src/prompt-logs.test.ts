import assert from 'node:assert/strict';
import test from 'node:test';
import { promptSnapshotForAdapter, redactPromptForLog } from './prompt-logs.ts';

test('redacts outbound prompt secrets before persistence', () => {
  const redacted = redactPromptForLog([
    'Header: X-MegaCorps-Webhook-Secret: super-secret-shared-token',
    'Authorization: Bearer abc.def.ghi',
    '{"codexWsToken":"ws-secret","webhookSecret":"hook-secret","safe":"visible"}',
  ].join('\n'));

  assert.doesNotMatch(redacted, /super-secret|abc\.def|ws-secret|hook-secret/);
  assert.match(redacted, /X-MegaCorps-Webhook-Secret: \[redacted\]/);
  assert.match(redacted, /Authorization: \[redacted\]/);
  assert.match(redacted, /"safe":"visible"/);
});

test('webhook prompt snapshots redact adapter secret fields', () => {
  const snapshot = promptSnapshotForAdapter(
    { adapterType: 'webhook', hermesProfile: 'worker', currentSessionId: null, adapterConfig: { webhookSecret: 'hook-secret', webhookUrl: 'https://example.test/hook' } },
    { id: 'card-1', title: 'Ship feature', body: 'Implement this.', timeoutSeconds: 60 },
  );

  assert.doesNotMatch(snapshot, /hook-secret/);
  assert.match(snapshot, /"webhookSecret": "\[redacted\]"/);
  assert.match(snapshot, /Implement this/);
});
