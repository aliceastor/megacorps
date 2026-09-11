import { randomUUID } from 'node:crypto';
import { A2aRpcError, getA2aTask, listA2aTasks, sendA2aMessage, type A2aSendOutcome, type SendA2aMessageOptions } from './a2a-client.ts';

export type A2aInvocationRecord = {
  key: string;
  scope: string;
  route: string;
  contextId: string;
  baselineTaskIds: string[] | null;
  phase: 'preparing' | 'sending' | 'polling' | 'terminal' | 'reconciliation_required';
  taskId: string | null;
  deadlineAt: number;
  outcome: A2aSendOutcome | null;
  lastError: string | null;
  revision: number;
  remoteReconciliation?: import('./a2a-remote-reconciliation.ts').A2aRemoteReconciliation;
};

export type A2aInvocationPatch = Partial<Omit<A2aInvocationRecord, 'key' | 'scope' | 'route' | 'revision'>>;

export interface A2aInvocationStore {
  /** Creation grants submission ownership once. An alias may return another key. */
  begin(seed: Omit<A2aInvocationRecord, 'revision'>): Promise<{ record: A2aInvocationRecord; created: boolean }>;
  get(key: string): Promise<A2aInvocationRecord | null>;
  /** Return null on revision conflict; never recreate missing records. */
  compareAndSet(key: string, revision: number, patch: A2aInvocationPatch): Promise<A2aInvocationRecord | null>;
}

export class A2aPollingError extends Error {
  constructor(public readonly code: string, public readonly record: A2aInvocationRecord) {
    super(`${code}: A2A execution requires reconciliation`);
    this.name = 'A2aPollingError';
  }
}

export type PollA2aMessageOptions = SendA2aMessageOptions & {
  executionKey: string;
  scope: string;
  route: string;
  store: A2aInvocationStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rpcTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
};

// Persist categories/cause codes only. Gateway text and fetch error messages can
// contain prompts, URLs or credentials and must never enter the durable journal.
function transportError(error: unknown): string {
  if (error instanceof A2aRpcError) return `a2a_rpc:${error.code}`;
  const cause = error instanceof Error ? error.cause : null;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `a2a_transport:${code}` : 'a2a_transport_error';
}

function terminal(outcome: A2aSendOutcome): boolean {
  return outcome.state !== null && outcome.state !== 'submitted' && outcome.state !== 'working';
}

export async function pollA2aMessage(options: PollA2aMessageOptions): Promise<A2aSendOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = await options.store.begin({
    key: options.executionKey, scope: options.scope, route: options.route,
    contextId: options.contextId || `a2a-ctx-${randomUUID()}`, baselineTaskIds: null, phase: 'preparing',
    taskId: null, deadlineAt: now() + Math.max(1, options.timeoutMs), outcome: null, lastError: null,
  });
  let record = started.record;
  if (record.scope !== options.scope || record.route !== options.route) {
    throw new A2aPollingError('a2a_invocation_identity_mismatch', record);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let ownsSubmission = started.created;
  let sendOutcome: A2aSendOutcome | undefined;
  let sendError: string | undefined;
  let delay = Math.max(1, options.pollIntervalMs ?? 5_000);
  const maxDelay = Math.max(delay, options.maxPollIntervalMs ?? 15_000);

  const refresh = async () => {
    const fresh = await options.store.get(record.key);
    if (!fresh) throw new A2aPollingError('a2a_journal_missing', record);
    record = fresh;
  };
  const patch = async (change: A2aInvocationPatch): Promise<boolean> => {
    const updated = await options.store.compareAndSet(record.key, record.revision, change);
    if (!updated) { await refresh(); return false; }
    record = updated;
    return true;
  };
  const fail = async (code: string): Promise<never> => {
    while (record.phase !== 'terminal' && record.phase !== 'reconciliation_required') {
      const lastError = record.lastError ? `${code}; last=${record.lastError}` : code;
      if (await patch({ phase: 'reconciliation_required', lastError })) break;
    }
    throw new A2aPollingError(code, record);
  };
  const rpcOptions = () => ({
    baseUrl: options.baseUrl, bearerToken: options.bearerToken, fetchImpl: options.fetchImpl,
    timeoutMs: Math.max(1, Math.min(options.rpcTimeoutMs ?? 10_000, record.deadlineAt - now())), signal: controller.signal,
  });
  const validate = async (outcome: A2aSendOutcome, expectedId?: string) => {
    if (!outcome.taskId || outcome.contextId !== record.contextId || (expectedId && outcome.taskId !== expectedId) || record.baselineTaskIds?.includes(outcome.taskId)) {
      await fail('a2a_task_identity_mismatch');
    }
  };
  const listAll = async (): Promise<A2aSendOutcome[]> => {
    const tasks = new Map<string, A2aSendOutcome>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      if (now() >= record.deadlineAt) throw new A2aRpcError('a2a_rpc_timeout', 'a2a_rpc_timeout');
      const page = await listA2aTasks({ ...rpcOptions(), contextId: record.contextId, pageToken });
      for (const task of page.tasks) {
        if (!task.taskId || task.contextId !== record.contextId) await fail('a2a_task_identity_mismatch');
        tasks.set(task.taskId!, task);
      }
      pageToken = page.nextPageToken ?? undefined;
      if (pageToken && tokens.has(pageToken)) await fail('a2a_invalid_pagination');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return [...tasks.values()];
  };

  try {
    while (true) {
      await refresh();
      if (record.phase === 'terminal' && record.outcome) return record.outcome;
      if (record.phase === 'reconciliation_required') throw new A2aPollingError(record.lastError?.split(';')[0] ?? 'a2a_reconciliation_required', record);
      if (controller.signal.aborted) await fail('a2a_interrupted');
      if (now() >= record.deadlineAt) await fail(record.taskId ? 'a2a_deadline_exceeded' : 'a2a_acceptance_unknown');
      try {
        if (ownsSubmission && record.phase === 'preparing') {
          const baseline = await listAll();
          if (now() >= record.deadlineAt) continue;
          const claimed = await patch({ baselineTaskIds: baseline.map((task) => task.taskId!), phase: 'sending' });
          if (!claimed) continue;
          // The durable sending intent MUST precede the network call. Losing this
          // process after this point intentionally grants nobody another send.
          ownsSubmission = false;
          void sendA2aMessage({ ...options, ...rpcOptions(), contextId: record.contextId }).then(
            (outcome) => { sendOutcome = outcome; },
            (error: unknown) => { sendError = transportError(error); },
          );
        }
        if (sendError) {
          const code = sendError;
          sendError = undefined;
          if (!await patch({ lastError: code })) continue;
        }
        if (sendOutcome) {
          await validate(sendOutcome, record.taskId ?? undefined);
          if (!record.taskId) {
            if (!await patch({ taskId: sendOutcome.taskId, phase: 'polling' })) continue;
          }
          sendOutcome = undefined;
        }
        if (!record.taskId && record.baselineTaskIds !== null) {
          const baseline = new Set(record.baselineTaskIds);
          const candidates = (await listAll()).filter((task) => !baseline.has(task.taskId!));
          if (candidates.length > 1) await fail('a2a_ambiguous_task');
          if (candidates.length === 1 && !await patch({ taskId: candidates[0]!.taskId, phase: 'polling' })) continue;
        }
        if (record.taskId) {
          const status = await getA2aTask({ ...rpcOptions(), taskId: record.taskId });
          await validate(status, record.taskId);
          if (terminal(status)) {
            // Status reads deliberately omit history. Only the full exact task
            // response is authoritative for artifacts, reports, and usage.
            const full = await getA2aTask({ ...rpcOptions(), taskId: record.taskId, full: true });
            await validate(full, record.taskId);
            // Submission can settle during either query above. A conflicting
            // response must be rejected before the fetched result is cached.
            if (sendOutcome) await validate(sendOutcome, record.taskId);
            if (now() >= record.deadlineAt) continue;
            if (terminal(full) && await patch({ phase: 'terminal', outcome: full, lastError: null })) return full;
          }
        }
      } catch (error) {
        if (error instanceof A2aPollingError) throw error;
        if (record.taskId && error instanceof A2aRpcError && (error.code === -32001 || error.code === 'a2a_http_404')) await fail('a2a_task_missing');
        await patch({ lastError: transportError(error) });
      }
      await sleep(Math.min(delay, Math.max(0, record.deadlineAt - now())));
      delay = Math.min(maxDelay, Math.ceil(delay * 1.5));
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}
