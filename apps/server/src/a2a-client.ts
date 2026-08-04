import { randomUUID } from 'node:crypto';

// Minimal A2A v1.0 JSON-RPC client. Deliberately not @a2a-js/sdk: our only
// peer is the Hermes gateway's JSON-RPC binding, and the SDK's proto-generated
// types are far heavier than this wire surface (see Stage B plan).

export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export type A2aSendOutcome = {
  text: string;
  contextId: string | null;
  taskId: string | null;
  state: A2aTaskState | null;
};

const STATE_SUFFIXES: Array<[string, A2aTaskState]> = [
  ['INPUT_REQUIRED', 'input_required'],
  ['AUTH_REQUIRED', 'auth_required'],
  ['COMPLETED', 'completed'],
  ['SUBMITTED', 'submitted'],
  ['WORKING', 'working'],
  ['FAILED', 'failed'],
  ['CANCELED', 'canceled'],
  ['CANCELLED', 'canceled'],
  ['REJECTED', 'rejected'],
];

function normalizeState(raw: unknown): A2aTaskState | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const upper = raw.trim().toUpperCase().replace(/[- ]/g, '_');
  for (const [suffix, state] of STATE_SUFFIXES) {
    if (upper.endsWith(suffix)) return state;
  }
  return null;
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') {
      chunks.push(record.text);
      continue;
    }
    const content = record.content as Record<string, unknown> | undefined;
    if (content && content.$case === 'text' && typeof content.value === 'string') chunks.push(content.value);
  }
  return chunks.join('\n').trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function looksLikeTask(record: Record<string, unknown>): boolean {
  return 'status' in record || ('id' in record && 'contextId' in record && !('parts' in record));
}

function looksLikeMessage(record: Record<string, unknown>): boolean {
  return Array.isArray(record.parts);
}

export function normalizeA2aSendResult(result: unknown): A2aSendOutcome {
  const root = asRecord(result) ?? {};
  const task = asRecord(root.task) ?? (looksLikeTask(root) ? root : null);
  const message = asRecord(root.message) ?? asRecord(root.msg) ?? (!task && looksLikeMessage(root) ? root : null);

  if (task) {
    const status = asRecord(task.status);
    const statusMessage = asRecord(status?.message);
    let text = textFromParts(statusMessage?.parts);
    if (!text && Array.isArray(task.artifacts)) {
      text = task.artifacts
        .map((artifact) => textFromParts(asRecord(artifact)?.parts))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (!text && Array.isArray(task.history)) {
      const last = asRecord(task.history[task.history.length - 1]);
      text = textFromParts(last?.parts);
    }
    return {
      text,
      contextId: typeof task.contextId === 'string' && task.contextId ? task.contextId : null,
      taskId: typeof task.id === 'string' && task.id ? task.id : null,
      state: normalizeState(status?.state),
    };
  }

  if (message) {
    return {
      text: textFromParts(message.parts),
      contextId: typeof message.contextId === 'string' && message.contextId ? message.contextId : null,
      taskId: typeof message.taskId === 'string' && message.taskId ? message.taskId : null,
      state: null,
    };
  }

  return { text: '', contextId: null, taskId: null, state: null };
}

export type A2aRpcOptions = {
  baseUrl: string;
  bearerToken?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export async function a2aRpc(method: string, params: unknown, options: A2aRpcOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs));
  try {
    const response = await fetchImpl(options.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`a2a_http_${response.status}: ${method} request to A2A gateway failed`);
    const payload = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
    if (payload.error) throw new Error(`a2a_rpc_error${payload.error.code !== undefined ? ` ${payload.error.code}` : ''}: ${payload.error.message ?? 'unknown A2A error'}`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export type SendA2aMessageOptions = A2aRpcOptions & {
  text: string;
  contextId?: string | null;
};

export async function sendA2aMessage(options: SendA2aMessageOptions): Promise<A2aSendOutcome> {
  const message: Record<string, unknown> = {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: options.text }],
  };
  if (options.contextId) message.contextId = options.contextId;
  const result = await a2aRpc('SendMessage', { message }, options);
  return normalizeA2aSendResult(result);
}

export async function fetchAgentCard(baseUrl: string, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Record<string, unknown> | null> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, options?.timeoutMs ?? 10_000));
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`;
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return asRecord(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
