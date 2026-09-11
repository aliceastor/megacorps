import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './test-support/memory-db.ts';
import { taskRuns } from './db/schema.ts';

test('disabling task workers preserves the bounded remote drainage timer without claiming local work', async t => {
  const previousWorker = process.env.TASK_RUN_WORKER_ENABLED;
  const previousLoop = process.env.DISPATCH_LOOP_ENABLED;
  process.env.TASK_RUN_WORKER_ENABLED = 'false';
  process.env.DISPATCH_LOOP_ENABLED = 'false';
  t.after(() => {
    if (previousWorker === undefined) delete process.env.TASK_RUN_WORKER_ENABLED; else process.env.TASK_RUN_WORKER_ENABLED = previousWorker;
    if (previousLoop === undefined) delete process.env.DISPATCH_LOOP_ENABLED; else process.env.DISPATCH_LOOP_ENABLED = previousLoop;
  });
  const run = { id: 'queued-local-work', status: 'queued' };
  memoryDb(t, [[taskRuns, [run]]]);
  const timers: (() => void)[] = [];
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { timers.push(callback); return 1 as any; });
  const { startDispatchLoop } = await import('./dispatch.ts');
  startDispatchLoop({ addHook: () => {}, log: { error: () => {} } } as any);
  assert.equal(timers.length, 1, 'read-only drainage must survive disabling task dispatch');
  timers[0]!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.status, 'queued');
});
