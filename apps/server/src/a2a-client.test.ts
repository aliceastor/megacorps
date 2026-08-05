import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeA2aSendResult, parseA2aPushPayload, pythonSortedJson, sendA2aMessage, verifyA2aPushSignature } from './a2a-client.ts';
import { createHmac } from 'node:crypto';

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

const reportData = { kind: 'megacorps-report', status: 'completed', summary: 'structured summary', verdict: 'approved' };

test('normalizeA2aSendResult extracts a DataPart report (both part shapes)', () => {
  const flat = normalizeA2aSendResult({
    task: {
      id: 't', contextId: 'c',
      status: { state: 'completed', message: { parts: [{ text: 'done' }, { data: reportData }] } },
    },
  });
  assert.equal(flat.report?.summary, 'structured summary');
  const cased = normalizeA2aSendResult({
    task: {
      id: 't', contextId: 'c',
      status: { state: 'completed', message: { parts: [{ content: { $case: 'data', value: reportData } }] } },
    },
  });
  assert.equal(cased.report?.verdict, 'approved');
});

test('normalizeA2aSendResult ignores invalid DataPart reports', () => {
  const outcome = normalizeA2aSendResult({
    task: {
      id: 't', contextId: 'c',
      status: { state: 'completed', message: { parts: [{ text: 'ok' }, { data: { kind: 'megacorps-report', status: 'nope' } }] } },
    },
  });
  assert.equal(outcome.report, null);
  assert.equal(outcome.text, 'ok');
});

test('normalizeA2aSendResult collects artifact references', () => {
  const outcome = normalizeA2aSendResult({
    task: {
      id: 't', contextId: 'c',
      status: { state: 'completed', message: { parts: [{ text: 'done' }] } },
      artifacts: [
        { artifactId: 'a1', name: 'PR', parts: [{ uri: 'https://github.com/x/y/pull/1' }] },
        { artifactId: 'a2', parts: [{ text: 'inline body' }] },
      ],
    },
  });
  assert.equal(outcome.artifacts.length, 2);
  assert.equal(outcome.artifacts[0]?.uri, 'https://github.com/x/y/pull/1');
  assert.equal(outcome.artifacts[0]?.name, 'PR');
  assert.equal(outcome.artifacts[1]?.text, 'inline body');
});

test('pythonSortedJson matches Python json.dumps sorted output', () => {
  assert.equal(pythonSortedJson({ b: 1, a: 'x' }), '{"a": "x", "b": 1}');
  assert.equal(
    pythonSortedJson({ z: { d: true, c: null }, list: [1, 'two'] }),
    '{"list": [1, "two"], "z": {"c": null, "d": true}}',
  );
});

test('verifyA2aPushSignature accepts a Hermes-style signature and rejects tampering', () => {
  const payload = { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-08-05T00:00:00Z' } } };
  const secret = 'push-secret';
  const signature = createHmac('sha256', secret).update(pythonSortedJson(payload), 'utf8').digest('hex');
  assert.equal(verifyA2aPushSignature(payload, secret, signature), true);
  assert.equal(verifyA2aPushSignature(payload, secret, signature.replace(/^./, '0')), false);
  assert.equal(verifyA2aPushSignature(payload, 'wrong', signature), false);
});

test('parseA2aPushPayload reads a statusUpdate push body', () => {
  const parsed = parseA2aPushPayload({
    statusUpdate: {
      taskId: 't9',
      contextId: 'ctx-9',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{ text: 'which env?' }] } },
    },
  });
  assert.deepEqual(parsed, { taskId: 't9', contextId: 'ctx-9', state: 'input_required', text: 'which env?' });
  assert.equal(parseA2aPushPayload({ nonsense: true }), null);
});
