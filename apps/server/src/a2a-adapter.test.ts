import assert from 'node:assert/strict';
import test from 'node:test';
import { createA2aDispatch } from './adapters/a2a.ts';
import type { AgentLike, TaskContext } from './adapters/hermes.ts';

const agent: AgentLike = {
  id: 'agent-1',
  name: 'Ribel',
  adapterType: 'a2a',
  hermesProfile: 'ribel',
  currentSessionId: null,
  adapterConfig: { sshHost: 'hermes-1.internal', sshUsername: 'ops' },
};

const task: TaskContext = { id: 'card-1', title: 'Do the thing', body: 'Please do the thing.', timeoutSeconds: 60, kind: 'task' };

type Captured = { url: string; body: any };

function fakeRpcFetch(reply: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body));
    captured.push({ url: String(url), body });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: reply }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const completedTask = (text: string) => ({
  task: {
    id: 'task-9',
    contextId: 'ctx-live',
    status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text }] } },
  },
});

test('a2a dispatch tunnels to the gateway and returns the agent reply', async () => {
  const captured: Captured[] = [];
  const tunnelTargets: any[] = [];
  const dispatch = createA2aDispatch({
    fetchImpl: fakeRpcFetch(completedTask('work is done'), captured),
    tunnelFn: async (target) => { tunnelTargets.push(target); return 45_678; },
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, true);
  assert.equal(result.output, 'work is done');
  assert.equal(result.sessionId, 'ctx-live');
  assert.ok(result.tokensUsed > 0);
  assert.ok(result.costUsd > 0);
  assert.equal(captured[0]!.url, 'http://127.0.0.1:45678/ribel');
  assert.equal(tunnelTargets[0].host, 'hermes-1.internal');
  assert.equal(tunnelTargets[0].user, 'ops');
  assert.equal(tunnelTargets[0].remotePort, 9900);
  // The prompt travels as the A2A message text and keeps the Kanban protocol.
  assert.match(captured[0]!.body.params.message.parts[0].text, /MegaCorps/);
});

test('a2a dispatch resumes a live context and skips fallback contexts', async () => {
  const captured: Captured[] = [];
  const dispatch = createA2aDispatch({ fetchImpl: fakeRpcFetch(completedTask('ok'), captured), tunnelFn: async () => 45_678 });
  await dispatch({ ...agent, currentSessionId: 'ctx-prior' }, task);
  assert.equal(captured[0]!.body.params.message.contextId, 'ctx-prior');
  await dispatch({ ...agent, currentSessionId: 'a2a-fallback-123' }, task);
  assert.equal(captured[1]!.body.params.message.contextId, undefined);
});

test('a2a dispatch generates a fallback session id when the gateway omits contextId', async () => {
  const dispatch = createA2aDispatch({
    fetchImpl: fakeRpcFetch({ message: { messageId: 'm1', parts: [{ text: 'reply' }] } }),
    tunnelFn: async () => 45_678,
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, true);
  assert.match(result.sessionId, /^a2a-fallback-/);
});

test('a2a dispatch marks failed task states as unsuccessful', async () => {
  const failed = { task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'boom' }] } } } };
  const dispatch = createA2aDispatch({ fetchImpl: fakeRpcFetch(failed), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.equal(result.output, 'boom');
});

test('a2a dispatch surfaces transport errors with a stable prefix', async () => {
  const dispatch = createA2aDispatch({
    fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch,
    tunnelFn: async () => 45_678,
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.match(result.output, /^a2a_transport_error: /);
});

test('a2a dispatch uses a direct base URL when configured', async () => {
  const captured: Captured[] = [];
  const dispatch = createA2aDispatch({ fetchImpl: fakeRpcFetch(completedTask('ok'), captured) });
  const direct: AgentLike = { ...agent, adapterConfig: { a2aBaseUrl: 'http://hermes-1.internal:9900' } };
  const result = await dispatch(direct, task);
  assert.equal(result.success, true);
  assert.equal(captured[0]!.url, 'http://hermes-1.internal:9900/ribel');
});
