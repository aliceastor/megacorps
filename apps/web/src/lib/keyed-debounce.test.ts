import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyedDebounce, type DebounceScheduler } from './keyed-debounce.ts';

// A manual scheduler: nothing fires until flush(), like a real timer queue
// that has not ticked yet.
function fakeScheduler() {
  const queue = new Map<number, { fn: () => void; delayMs: number }>();
  let next = 0;
  const scheduler: DebounceScheduler = {
    set: (fn, delayMs) => {
      next += 1;
      queue.set(next, { fn, delayMs });
      return next;
    },
    clear: (handle) => { queue.delete(handle as number); },
  };
  return {
    scheduler,
    size: () => queue.size,
    delays: () => [...queue.values()].map((entry) => entry.delayMs),
    flush() {
      const entries = [...queue.values()];
      queue.clear();
      for (const entry of entries) entry.fn();
    },
  };
}

test('calls under the same key collapse into the newest one', () => {
  const timers = fakeScheduler();
  const debounce = createKeyedDebounce(400, timers.scheduler);
  const calls: string[] = [];
  debounce.run('refresh', () => calls.push('first'));
  debounce.run('refresh', () => calls.push('second'));
  debounce.run('refresh', () => calls.push('third'));
  assert.equal(timers.size(), 1);
  assert.equal(debounce.pending(), 1);
  timers.flush();
  assert.deepEqual(calls, ['third']);
  assert.equal(debounce.pending(), 0);
});

test('different keys are independent and keep the configured delay', () => {
  const timers = fakeScheduler();
  const debounce = createKeyedDebounce(400, timers.scheduler);
  const calls: string[] = [];
  debounce.run('logs:c1', () => calls.push('logs'));
  debounce.run('actions:c1', () => calls.push('actions'));
  debounce.run('logs:c1', () => calls.push('logs again'));
  assert.deepEqual(timers.delays(), [400, 400]);
  assert.equal(debounce.pending(), 2);
  timers.flush();
  assert.deepEqual(calls.sort(), ['actions', 'logs again']);
});

test('cancel drops one key or everything', () => {
  const timers = fakeScheduler();
  const debounce = createKeyedDebounce(400, timers.scheduler);
  const calls: string[] = [];
  debounce.run('a', () => calls.push('a'));
  debounce.run('b', () => calls.push('b'));
  debounce.run('c', () => calls.push('c'));
  debounce.cancel('b');
  assert.equal(debounce.pending(), 2);
  debounce.cancel('missing');
  assert.equal(debounce.pending(), 2);
  debounce.cancel();
  assert.equal(debounce.pending(), 0);
  timers.flush();
  assert.deepEqual(calls, []);
});

test('a key can be scheduled again after it fired', () => {
  const timers = fakeScheduler();
  const debounce = createKeyedDebounce(400, timers.scheduler);
  let count = 0;
  debounce.run('k', () => { count += 1; });
  timers.flush();
  debounce.run('k', () => { count += 1; });
  timers.flush();
  assert.equal(count, 2);
});

test('the default scheduler uses real timers', async () => {
  const debounce = createKeyedDebounce(1);
  let fired = 0;
  debounce.run('k', () => { fired += 1; });
  debounce.run('k', () => { fired += 10; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fired, 10);
  assert.equal(debounce.pending(), 0);
});
