import assert from 'node:assert/strict';
import test from 'node:test';
import * as polling from './a2a-polling.ts';
import type { A2aInvocationRecord, A2aInvocationStore } from './a2a-polling.ts';

class MemoryStore implements A2aInvocationStore {
  record: A2aInvocationRecord | null = null;
  async begin(seed: Omit<A2aInvocationRecord, 'revision'>) {
    const created = !this.record;
    this.record ??= { ...seed, revision: 0 };
    return { record: structuredClone(this.record), created };
  }
  async get() { return structuredClone(this.record); }
  async compareAndSet(_key: string, revision: number, patch: Partial<A2aInvocationRecord>) {
    if (!this.record || this.record.revision !== revision) return null;
    this.record = { ...this.record, ...patch, revision: revision + 1 };
    return structuredClone(this.record);
  }
}

const task = (id = 'new', state = 'working', contextId = 'ctx', full = false) => ({
  id, contextId, status: { state }, ...(full ? { artifacts: [{ artifactId: 'answer', parts: [{ text: 'finished' }] }] } : {}),
});

function setup(extra: { completeAt?: number; failures?: number; ambiguous?: boolean; wrongId?: boolean; wrongContext?: boolean; missing?: boolean; noAcceptance?: boolean; sendError?: boolean; fullFailures?: number; oldSendReply?: boolean; submitted?: boolean } = {}) {
  const store = new MemoryStore();
  let time = 0;
  let sends = 0;
  let reads = 0;
  let fullReads = 0;
  const methods: Array<{ method: string; params: any }> = [];
  const fetchImpl = (async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    methods.push({ method, params });
    if (method === 'SendMessage') {
      sends++;
      assert.equal(store.record?.phase, 'sending');
      assert.deepEqual(store.record?.baselineTaskIds?.sort(), ['old', 'old-page2']);
      assert.equal(params.message.contextId, 'ctx');
      if (extra.sendError) throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
      if (extra.oldSendReply) return Response.json({ result: task('old', 'completed') });
      // Hermes registers immediately but its SendMessage response stays pending.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fetch failed')), { once: true });
      });
    }
    let result: unknown;
    if (method === 'ListTasks') {
      assert.equal(params.contextId, 'ctx');
      assert.equal(params.historyLength, 0);
      result = params.pageToken ? { tasks: [task('old-page2', 'completed')] } : {
        tasks: [task('old', 'completed'), ...(sends && !extra.noAcceptance ? [task(), ...(extra.ambiguous ? [task('another')] : [])] : [])],
        nextPageToken: 'page2',
      };
    } else {
      reads++;
      if (params.historyLength === undefined && ++fullReads <= (extra.fullFailures ?? 0)) throw new Error('full task fetch failed');
      if (reads <= (extra.failures ?? 0)) throw new Error('fetch failed');
      if (extra.missing) return Response.json({ error: { code: -32001, message: 'task not found' } });
      result = task(extra.wrongId ? 'wrong' : 'new', time >= (extra.completeAt ?? 1) ? 'completed' : extra.submitted ? 'submitted' : 'working', extra.wrongContext ? 'wrong' : 'ctx', params.historyLength === undefined);
    }
    return Response.json({ result });
  }) as typeof fetch;
  const options = {
    executionKey: 'invocation', scope: 'scope', route: 'route', contextId: 'ctx', text: 'work', baseUrl: 'http://gateway',
    timeoutMs: 600_000, rpcTimeoutMs: 100, store, fetchImpl, now: () => time,
    sleep: async (ms: number) => { time += ms; },
  };
  return { store, options, methods, sends: () => sends, reads: () => reads, time: () => time };
}

test('discovers while send is pending, survives failed reads and completes after 300 seconds with one send', async () => {
  const env = setup({ completeAt: 330_000, failures: 3 });
  const result = await polling.pollA2aMessage(env.options);
  assert.equal(result.text, 'finished');
  assert.equal(result.taskId, 'new');
  assert.equal(result.artifacts.length, 1);
  assert.equal(env.sends(), 1);
  assert.ok(env.time() >= 330_000);
  assert.equal(env.store.record?.phase, 'terminal');
  assert.equal(env.store.record?.deadlineAt, 600_000);
  assert.ok(env.methods.some(({ method, params }) => method === 'GetTask' && params.historyLength === undefined));
});

test('terminal replay and restart resume do not send again', async () => {
  const env = setup();
  await env.store.begin({ key: 'invocation', scope: 'scope', route: 'route', contextId: 'ctx', baselineTaskIds: ['old', 'old-page2'], phase: 'polling', taskId: 'new', deadlineAt: 60_000, outcome: null, lastError: null });
  const result = await polling.pollA2aMessage(env.options);
  assert.equal(result.text, 'finished');
  assert.equal(env.sends(), 0);
  const requests = env.methods.length;
  assert.deepEqual(await polling.pollA2aMessage(env.options), result);
  assert.equal(env.methods.length, requests);
  assert.equal(env.store.record?.deadlineAt, 60_000);
});

for (const [name, extra, code] of [
  ['multiple new tasks', { ambiguous: true }, 'a2a_ambiguous_task'],
  ['wrong task ID', { wrongId: true }, 'a2a_task_identity_mismatch'],
  ['wrong context', { wrongContext: true }, 'a2a_task_identity_mismatch'],
  ['accepted task disappears', { missing: true }, 'a2a_task_missing'],
  ['acceptance never becomes known', { noAcceptance: true }, 'a2a_acceptance_unknown'],
] as const) {
  test(`${name} enters reconciliation without resubmission`, async () => {
    const env = setup(extra);
    await assert.rejects(polling.pollA2aMessage({ ...env.options, timeoutMs: 20_000 }), (error: any) => error.code === code);
    assert.equal(env.sends(), 1);
    assert.equal(env.store.record?.phase, 'reconciliation_required');
    await assert.rejects(polling.pollA2aMessage(env.options));
    assert.equal(env.sends(), 1);
  });
}

test('working tasks exhaust original total deadline even after restart', async () => {
  const env = setup({ completeAt: 1_000_000 });
  await env.store.begin({ key: 'invocation', scope: 'scope', route: 'route', contextId: 'ctx', baselineTaskIds: [], phase: 'polling', taskId: 'new', deadlineAt: 12_000, outcome: null, lastError: null });
  await assert.rejects(polling.pollA2aMessage(env.options), (error: any) => error.code === 'a2a_deadline_exceeded');
  assert.equal(env.time(), 12_000);
  assert.equal(env.sends(), 0);
});

test('resumed preparation cannot establish a baseline or send', async () => {
  const env = setup();
  await env.store.begin({ key: 'invocation', scope: 'scope', route: 'route', contextId: 'ctx', baselineTaskIds: null, phase: 'preparing', taskId: null, deadlineAt: 12_000, outcome: null, lastError: null });
  await assert.rejects(polling.pollA2aMessage(env.options));
  assert.equal(env.sends(), 0);
});

test('resume honors durable context even when caller context changed', async () => {
  const env = setup({ completeAt: 0 });
  await env.store.begin({ key: 'invocation', scope: 'scope', route: 'route', contextId: 'ctx', baselineTaskIds: [], phase: 'polling', taskId: 'new', deadlineAt: 12_000, outcome: null, lastError: null });
  assert.equal((await polling.pollA2aMessage({ ...env.options, contextId: 'stale-context' })).contextId, 'ctx');
  assert.equal(env.sends(), 0);
});

test('unknown send response and failed final fetch recover through queries only', async () => {
  const env = setup({ sendError: true, fullFailures: 2 });
  assert.equal((await polling.pollA2aMessage(env.options)).text, 'finished');
  assert.equal(env.sends(), 1);
});

test('concurrent begin grants exactly one send owner', async () => {
  const env = setup({ completeAt: 0 });
  const results = await Promise.all([polling.pollA2aMessage(env.options), polling.pollA2aMessage(env.options)]);
  assert.equal(env.sends(), 1);
  assert.equal(results[0].text, 'finished');
  assert.deepEqual(results[0], results[1]);
});

test('unknown acceptance preserves sanitized send cause in durable reconciliation', async () => {
  const env = setup({ noAcceptance: true, sendError: true });
  await assert.rejects(polling.pollA2aMessage({ ...env.options, timeoutMs: 20_000 }));
  assert.match(env.store.record!.lastError!, /ECONNRESET/);
  assert.doesNotMatch(env.store.record!.lastError!, /fetch failed/);
});

test('conflicting send response arriving during terminal query cannot accept an old task', async () => {
  const env = setup({ completeAt: 0, oldSendReply: true });
  await assert.rejects(polling.pollA2aMessage(env.options), (error: any) => error.code === 'a2a_task_identity_mismatch');
  assert.equal(env.sends(), 1);
});

test('submitted tasks are still polled until completion', async () => {
  const env = setup({ completeAt: 20_000, submitted: true });
  assert.equal((await polling.pollA2aMessage(env.options)).state, 'completed');
  assert.ok(env.time() >= 20_000);
  assert.equal(env.sends(), 1);
});
