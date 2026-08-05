import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { agentReportSchema, type AgentReport } from '@megacorps/shared';

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

export type A2aArtifactRef = {
  artifactId: string;
  name?: string;
  uri?: string;
  text?: string;
};

export type A2aSendOutcome = {
  text: string;
  contextId: string | null;
  taskId: string | null;
  state: A2aTaskState | null;
  report: AgentReport | null;
  artifacts: A2aArtifactRef[];
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

function dataFromParts(parts: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parts)) return [];
  const found: Record<string, unknown>[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    const flat = asRecord(record.data);
    if (flat) { found.push(flat); continue; }
    const content = asRecord(record.content);
    if (content && content.$case === 'data') {
      const value = asRecord(content.value);
      if (value) found.push(value);
    }
  }
  return found;
}

function reportFromParts(parts: unknown): AgentReport | null {
  for (const data of dataFromParts(parts)) {
    if (data.kind !== 'megacorps-report') continue;
    const parsed = agentReportSchema.safeParse(data);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function uriFromParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.uri === 'string' && record.uri) return record.uri;
    const file = asRecord(record.file);
    if (file && typeof file.uri === 'string' && file.uri) return file.uri;
  }
  return undefined;
}

function artifactRefs(artifacts: unknown): A2aArtifactRef[] {
  if (!Array.isArray(artifacts)) return [];
  const refs: A2aArtifactRef[] = [];
  for (const artifact of artifacts) {
    const record = asRecord(artifact);
    if (!record) continue;
    const ref: A2aArtifactRef = { artifactId: typeof record.artifactId === 'string' && record.artifactId ? record.artifactId : randomUUID() };
    if (typeof record.name === 'string' && record.name) ref.name = record.name;
    const uri = uriFromParts(record.parts);
    if (uri) ref.uri = uri;
    const text = textFromParts(record.parts);
    if (text) ref.text = text;
    refs.push(ref);
  }
  return refs;
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
      report: reportFromParts(statusMessage?.parts),
      artifacts: artifactRefs(task.artifacts),
    };
  }

  if (message) {
    return {
      text: textFromParts(message.parts),
      contextId: typeof message.contextId === 'string' && message.contextId ? message.contextId : null,
      taskId: typeof message.taskId === 'string' && message.taskId ? message.taskId : null,
      state: null,
      report: reportFromParts(message.parts),
      artifacts: [],
    };
  }

  return { text: '', contextId: null, taskId: null, state: null, report: null, artifacts: [] };
}

// Python json.dumps(value, sort_keys=True, ensure_ascii=False) equivalent —
// Hermes signs push payloads over exactly this serialization.
export function pythonSortedJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => pythonSortedJson(item)).join(', ')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pythonSortedJson(record[key])}`).join(', ')}}`;
}

export function verifyA2aPushSignature(payload: unknown, secret: string, signature: string | null | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(pythonSortedJson(payload), 'utf8').digest('hex');
  const provided = signature.trim().toLowerCase();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

export type A2aPushEvent = {
  taskId: string;
  contextId: string;
  state: A2aTaskState | null;
  text: string;
};

export function parseA2aPushPayload(body: unknown): A2aPushEvent | null {
  const root = asRecord(body);
  const update = asRecord(root?.statusUpdate);
  if (!update) return null;
  const taskId = typeof update.taskId === 'string' ? update.taskId : '';
  const contextId = typeof update.contextId === 'string' ? update.contextId : '';
  if (!taskId && !contextId) return null;
  const status = asRecord(update.status);
  return {
    taskId,
    contextId,
    state: normalizeState(status?.state),
    text: textFromParts(asRecord(status?.message)?.parts),
  };
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
