import assert from 'node:assert/strict';
import test from 'node:test';
import { createA2aDispatch } from './adapters/a2a.ts';
import { normalizeA2aSendResult } from './a2a-client.ts';

const agent = { id: 'synthetic-agent', hermesProfile: 'configured-profile', currentSessionId: 'reused-context', adapterConfig: { a2aBaseUrl: 'http://usage-fixture.internal:9900' } };
const task = { id: 'synthetic-card', title: 'Usage fixture', body: 'Synthetic prompt' };

test('A2A timeout is unknown usage, never an authoritative free attempt', async () => {
  const result = await createA2aDispatch({ fetchImpl: async () => { throw new Error('synthetic timeout'); } })(agent, task);
  assert.equal(result.success, false);
  assert.equal((result as any).usage?.costStatus, 'unknown');
  assert.equal((result as any).usage?.costUsd, null);
});

test('A2A retains only the versioned transport metadata usage contract', () => {
  const facts = { version: 1, costStatus: 'actual', tokenStatus: 'actual', costUsd: '0.00000019', provider: 'synthetic-provider', model: 'synthetic-model', inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 1, totalTokens: 7, providerEventId: 'provider-event-1', occurredAt: '2026-08-31T23:59:59.000Z' };
  const outcome = normalizeA2aSendResult({ task: { id: 'turn-2', contextId: 'reused-context', status: { state: 'completed' }, metadata: { megacorpsUsage: facts } } });
  assert.equal((outcome as any).usage?.costUsd, '0.00000019');
  assert.equal((outcome as any).usage?.source, 'a2a_metadata_v1');
  assert.equal((outcome as any).usage?.inputTokens, 5);
  assert.equal((outcome as any).usage?.providerEventId, 'provider-event-1');
  const unsupported = normalizeA2aSendResult({ message: { parts: [{ text: JSON.stringify(facts) }], metadata: { usage: facts } } });
  assert.equal((unsupported as any).usage, undefined);
});

test('A2A prompt plus output heuristics do not invent output tokens, model or price', async () => {
  const result = await createA2aDispatch({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', result: { kind: 'task', id: 'real-turn-1', contextId: 'reused-context', status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'Synthetic answer' }] } } } }), { headers: { 'content-type': 'application/json' } }) })(agent, task);
  assert.equal(result.success, true);
  assert.equal((result as any).usage?.costStatus, 'unknown');
  assert.equal((result as any).usage?.costUsd, null);
  assert.equal((result as any).usage?.provider, null);
  assert.equal((result as any).usage?.model, null);
  assert.equal((result as any).usage?.tokenStatus, 'estimated');
  assert.equal((result as any).usage?.inputTokens, null);
  assert.equal((result as any).usage?.outputTokens, null);
  assert.ok((result as any).usage?.totalTokens > 0);
});

