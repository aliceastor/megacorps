// A trailing-edge debounce per key, shared by the board's live-event handler:
// a burst of card.* events collapses into one whole-board refresh, one
// comments reload, one logs reload… per window. Timers are injectable so
// node:test can drive it without fake clocks.

export type DebounceScheduler = {
  set: (fn: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};
export type KeyedDebounce = {
  /** Schedules fn under key; an earlier pending call for the same key is dropped (the newest closure wins). */
  run: (key: string, fn: () => void) => void;
  /** Drops the pending call for key, or every pending call when key is omitted. */
  cancel: (key?: string) => void;
  /** Number of keys with a call still pending. */
  pending: () => number;
};

const defaultScheduler: DebounceScheduler = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createKeyedDebounce(delayMs: number, scheduler: DebounceScheduler = defaultScheduler): KeyedDebounce {
  const timers = new Map<string, unknown>();
  return {
    run(key, fn) {
      const existing = timers.get(key);
      if (existing !== undefined) scheduler.clear(existing);
      const handle = scheduler.set(() => {
        timers.delete(key);
        fn();
      }, delayMs);
      timers.set(key, handle);
    },
    cancel(key) {
      if (key === undefined) {
        for (const handle of timers.values()) scheduler.clear(handle);
        timers.clear();
        return;
      }
      const handle = timers.get(key);
      if (handle === undefined) return;
      scheduler.clear(handle);
      timers.delete(key);
    },
    pending: () => timers.size,
  };
}
