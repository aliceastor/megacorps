import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeA2aSendResult, sendA2aMessage } from './a2a-client.ts';

const task = (state: string, text: string, extra: Record<string, unknown> = {}) => ({
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state, message: { messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text }] } },
  ...extra,
});

test('normalizeA2aSendResult reads a wrapped task result', () => {
  const outcome = normalizeA2aSendResult({ task: task('TASK_STATE_COMPLETED', 'hello world') });
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.text, 'hello world');
  assert.equal(outcome.contextId, 'ctx-1');
  assert.equal(outcome.taskId, 'task-1');
});

test('normalizeA2aSendResult reads a bare task result', () => {
  const outcome = normalizeA2aSendResult(task('completed', 'bare'));
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.text, 'bare');
});

test('normalizeA2aSendResult reads a direct message result', () => {
  const outcome = normalizeA2aSendResult({
    message: { messageId: 'm1', contextId: 'ctx-2', parts: [{ text: 'direct reply' }] },
  });
  assert.equal(outcome.text, 'direct reply');
  assert.equal(outcome.contextId, 'ctx-2');
  assert.equal(outcome.state, null);
});

test('normalizeA2aSendResult maps input-required state', () => {
  const outcome = normalizeA2aSendResult({ task: task('TASK_STATE_INPUT_REQUIRED', 'which repo?') });
  assert.equal(outcome.state, 'input_required');
  assert.equal(outcome.text, 'which repo?');
});

test('normalizeA2aSendResult joins artifact text when status message is empty', () => {
  const outcome = normalizeA2aSendResult({
    task: {
      id: 't2',
      contextId: 'ctx-3',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'a1', parts: [{ text: 'artifact body' }] }],
    },
  });
  assert.equal(outcome.text, 'artifact body');
});

test('normalizeA2aSendResult reads $case-shaped parts', () => {
  const outcome = normalizeA2aSendResult({
    task: {
      id: 't3',
      contextId: 'ctx-4',
      status: { state: 'completed', message: { parts: [{ content: { $case: 'text', value: 'case shaped' } }] } },
    },
  });
  assert.equal(outcome.text, 'case shaped');
});

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const { status = 200, body } = handler(String(url), (init ?? {}) as RequestInit);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('sendA2aMessage posts JSON-RPC SendMessage and returns the normalized outcome', async () => {
  const capturedCalls: Array<{ url: string; body: any; auth: string | null }> = [];
  const fetchImpl = fakeFetch((url, init) => {
    const headers = new Headers(init.headers as HeadersInit);
    const body = JSON.parse(String(init.body));
    capturedCalls.push({ url, body, auth: headers.get('authorization') });
    return { body: { jsonrpc: '2.0', id: body.id, result: { task: task('TASK_STATE_COMPLETED', 'ok done') } } };
  });
  const outcome = await sendA2aMessage({
    baseUrl: 'http://gateway.example:9900/ribel',
    text: 'do the thing',
    contextId: 'ctx-9',
    bearerToken: 'tok-1',
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(outcome.text, 'ok done');
  const captured = capturedCalls[0]!;
  assert.equal(captured.url, 'http://gateway.example:9900/ribel');
  assert.equal(captured.auth, 'Bearer tok-1');
  assert.equal(captured.body.method, 'SendMessage');
  assert.equal(captured.body.params.message.contextId, 'ctx-9');
  assert.equal(captured.body.params.message.role, 'ROLE_USER');
  assert.equal(captured.body.params.message.parts[0].text, 'do the thing');
});

test('sendA2aMessage throws on JSON-RPC error responses', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'task not found' } } }));
  await assert.rejects(
    sendA2aMessage({ baseUrl: 'http://x', text: 'hi', timeoutMs: 5_000, fetchImpl }),
    /task not found/,
  );
});

test('sendA2aMessage throws on HTTP errors', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
  await assert.rejects(
    sendA2aMessage({ baseUrl: 'http://x', text: 'hi', timeoutMs: 5_000, fetchImpl }),
    /401/,
  );
});
