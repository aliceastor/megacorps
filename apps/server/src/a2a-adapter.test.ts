import assert from 'node:assert/strict';
import test from 'node:test';
import { a2aSendTimeoutMs, createA2aDispatch } from './adapters/a2a.ts';
import type { AgentLike, TaskContext } from './adapters/hermes.ts';
import { a2aTestDeps } from './test-support/a2a-fixture.ts';

const testDispatch = (deps: Parameters<typeof createA2aDispatch>[0] = {}) => createA2aDispatch({ ...deps, ...a2aTestDeps(deps.fetchImpl) });

const agent: AgentLike = {
  id: 'agent-1',
  name: 'Ribel',
  adapterType: 'a2a',
  hermesProfile: 'ribel',
  currentSessionId: null,
  adapterConfig: { sshHost: 'hermes-1.internal', sshUsername: 'ops' },
};

const task: TaskContext = { id: 'card-1', taskRunId: 'run-1', title: 'Do the thing', body: 'Please do the thing.', timeoutSeconds: 60, kind: 'task' };

type Captured = { url: string; body: any };

function fakeRpcFetch(reply: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body));
    captured.push({ url: String(url), body });
    const result = structuredClone(reply) as any;
    if (result.task) result.task.contextId = body.params.message.contextId;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
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
  const dispatch = testDispatch({
    fetchImpl: fakeRpcFetch(completedTask('work is done'), captured),
    tunnelFn: async (target) => { tunnelTargets.push(target); return 45_678; },
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, true);
  assert.equal(result.output, 'work is done');
  assert.equal(result.sessionId, captured[0]!.body.params.message.contextId);
  assert.ok(result.tokensUsed > 0);
  assert.equal(result.costUsd, 0);
  assert.equal(result.usage?.costStatus, 'unknown');
  assert.equal(result.usage?.costUsd, null);
  assert.equal(captured[0]!.url, 'http://127.0.0.1:45678/ribel');
  assert.equal(tunnelTargets[0].host, 'hermes-1.internal');
  assert.equal(tunnelTargets[0].user, 'ops');
  assert.equal(tunnelTargets[0].remotePort, 9900);
  // The prompt travels as the A2A message text and keeps the Kanban protocol.
  assert.match(captured[0]!.body.params.message.parts[0].text, /MegaCorps/);
});

test('a2a dispatch resumes a live context and regenerates legacy fallback contexts', async () => {
  const captured: Captured[] = [];
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(completedTask('ok'), captured), tunnelFn: async () => 45_678 });
  await dispatch({ ...agent, currentSessionId: 'ctx-prior' }, task);
  assert.equal(captured[0]!.body.params.message.contextId, 'ctx-prior');
  await dispatch({ ...agent, currentSessionId: 'a2a-fallback-123' }, { ...task, taskRunId: 'run-2' });
  assert.match(captured[1]!.body.params.message.contextId, /^a2a-ctx-/);
});

test('a2a dispatch preserves generated context for reconciliation when gateway omits identity', async () => {
  const captured: Captured[] = [];
  const dispatch = testDispatch({
    fetchImpl: fakeRpcFetch({ message: { messageId: 'm1', parts: [{ text: 'reply' }] } }, captured),
    tunnelFn: async () => 45_678,
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.match(result.sessionId, /^a2a-ctx-/);
  assert.equal(captured[0]!.body.params.message.contextId, result.sessionId);
});

test('a2a dispatch registers a push notification callback', async () => {
  const captured: Captured[] = [];
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(completedTask('ok'), captured), tunnelFn: async () => 45_678 });
  await dispatch(agent, task);
  assert.equal(
    captured[0]!.body.params.configuration.taskPushNotificationConfig.url,
    'http://localhost:4000/api/a2a/push',
  );
  await dispatch({ ...agent, adapterConfig: { ...agent.adapterConfig, a2aPushEnabled: false } }, { ...task, taskRunId: 'run-2' });
  assert.equal(captured[1]!.body.params.configuration, undefined);
});

test('a2a dispatch maps input-required to needsInput and stays successful', async () => {
  const asking = {
    task: {
      id: 'task-q', contextId: 'ctx-q',
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{ text: 'Which environment should I target?' }] } },
    },
  };
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(asking), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.equal(result.success, true);
  assert.equal(result.needsInput?.question, 'Which environment should I target?');
  assert.equal(result.turnId, 'task-q');
});

test('a2a dispatch embeds a DataPart report into the output as fenced JSON', async () => {
  const withReport = {
    task: {
      id: 't', contextId: 'c',
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { parts: [{ text: 'all done' }, { data: { kind: 'megacorps-report', status: 'completed', summary: 'structured done' } }] },
      },
    },
  };
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(withReport), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.match(result.output, /all done/);
  assert.match(result.output, /```json\n\{"kind":"megacorps-report"/);
});

test('a2a dispatch passes artifact references through', async () => {
  const withArtifacts = {
    task: {
      id: 't', contextId: 'c',
      status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'done' }] } },
      artifacts: [{ artifactId: 'a1', name: 'PR', parts: [{ uri: 'https://github.com/x/y/pull/2' }] }],
    },
  };
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(withArtifacts), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.equal(result.artifacts?.[0]?.uri, 'https://github.com/x/y/pull/2');
});

test('a2a dispatch marks failed task states as unsuccessful', async () => {
  const failed = { task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'boom' }] } } } };
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(failed), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.equal(result.output, 'boom');
});

test('a2a dispatch requires recovery when terminal task needs authentication', async () => {
  const authRequired = { task: { id: 'auth', status: { state: 'TASK_STATE_AUTH_REQUIRED', message: { parts: [{ text: 'Sign in to continue' }] } } } };
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(authRequired), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.match(result.output, /^a2a_task_auth_required/);
  assert.equal(result.needsInput, null);
  assert.equal(result.turnId, 'auth');
});

test('a2a dispatch surfaces transport errors with a stable prefix', async () => {
  const dispatch = testDispatch({
    fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch,
    tunnelFn: async () => 45_678,
  });
  const result = await dispatch(agent, task);
  assert.equal(result.success, false);
  assert.match(result.output, /^a2a_transport_error: /);
});

test('a2a send timeout includes a 10s margin over the task budget', () => {
  assert.equal(a2aSendTimeoutMs(1500), 1_510_000);
  assert.equal(a2aSendTimeoutMs(null), 310_000);
});

test('a2a dispatch uses a direct base URL when configured', async () => {
  const captured: Captured[] = [];
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(completedTask('ok'), captured) });
  const direct: AgentLike = { ...agent, adapterConfig: { a2aBaseUrl: 'http://hermes-1.internal:9900' } };
  const result = await dispatch(direct, task);
  assert.equal(result.success, true);
  assert.equal(captured[0]!.url, 'http://hermes-1.internal:9900/ribel');
});

test('a2a dispatch replays same logical execution without a second send even when tunnel port changes', async () => {
  const captured: Captured[] = [];
  let port = 45_678;
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(completedTask('done'), captured), tunnelFn: async () => port++ });
  const first = await dispatch(agent, task);
  const second = await dispatch(agent, task);
  assert.equal(first.success, true);
  assert.equal(second.output, first.output);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(captured.length, 1);
});

test('a2a dispatch refuses to submit without a stable invocation identity', async () => {
  const captured: Captured[] = [];
  const dispatch = testDispatch({ fetchImpl: fakeRpcFetch(completedTask('done'), captured), tunnelFn: async () => 45_678 });
  const result = await dispatch(agent, { ...task, taskRunId: undefined });
  assert.equal(result.success, false);
  assert.match(result.output, /a2a_execution_key_missing/);
  assert.equal(captured.length, 0);
});
