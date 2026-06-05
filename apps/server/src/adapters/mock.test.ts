import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdapter } from './registry.ts';

test('mock adapter dispatches a local debug result', async () => {
  const adapter = getAdapter('mock');
  const result = await adapter.dispatch({ hermesProfile: 'local-debug', currentSessionId: null }, { id: 'card-1', title: 'Smoke', body: 'Run locally.' });
  assert.equal(result.success, true);
  assert.match(result.output, /Mock agent local-debug completed card card-1/);
  assert.match(result.sessionId, /^mock-/);
});
