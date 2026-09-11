import type { A2aInvocationRecord, A2aInvocationStore } from '../a2a-polling.ts';

export function a2aTestDeps(sendFetch?: typeof fetch) {
  const records = new Map<string, A2aInvocationRecord>();
  const tasks: any[] = [];
  let time = 0;
  const store: A2aInvocationStore = {
    async begin(seed) {
      const existing = records.get(seed.key);
      if (existing) return { record: structuredClone(existing), created: false };
      const record = { ...seed, revision: 0 };
      records.set(seed.key, record);
      return { record: structuredClone(record), created: true };
    },
    async get(key) { return structuredClone(records.get(key) ?? null); },
    async compareAndSet(key, revision, patch) {
      const previous = records.get(key);
      if (!previous || previous.revision !== revision) return null;
      const record = { ...previous, ...patch, revision: revision + 1 };
      records.set(key, record);
      return structuredClone(record);
    },
  };
  const fetchImpl = (async (url, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    if (method === 'ListTasks') return Response.json({ result: { tasks: tasks.filter((task) => task.contextId === params.contextId) } });
    if (method === 'GetTask') return Response.json({ result: tasks.find((task) => task.id === params.id) });
    const response = await sendFetch!(url, init);
    const body = await response.clone().json();
    const task = body.result?.task ?? body.result;
    if (task?.id) tasks.push(task);
    return response;
  }) as typeof fetch;
  return { store, fetchImpl, now: () => time, sleep: async (ms: number) => { time += ms; } };
}
