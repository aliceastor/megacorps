import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { projectFinalText } from './a2a-final-output.ts';
import { transportUsage, type UsageFacts } from './usage-facts.ts';
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
  finalOutputVersion?: 1;
  usage?: UsageFacts;
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

// Reasoning suppression. Some models stream chain-of-thought back over A2A —
// either as its own part (tagged in metadata/kind) or inline in the answer text
// via <think> tags. Neither belongs in a card output or a chat bubble, so both
// are stripped here: textFromParts feeds SendMessage, push events, and
// artifacts alike, so this one choke point covers every A2A read path.
const REASONING_MARKERS = new Set([
  'reasoning',
  'reasoning_content',
  'reasoningcontent',
  'thought',
  'thoughts',
  'thinking',
  'chain_of_thought',
  'chainofthought',
  'cot',
  'internal',
]);

const REASONING_TAGS = ['think', 'thinking', 'thought', 'reasoning', 'antml:thinking'];

function markedAsReasoning(value: unknown): boolean {
  return typeof value === 'string' && REASONING_MARKERS.has(value.trim().toLowerCase().replace(/[- ]/g, '_'));
}

function isReasoningPart(record: Record<string, unknown>): boolean {
  if (record.thought === true || record.isThought === true || record.reasoning === true) return true;
  if (markedAsReasoning(record.kind) || markedAsReasoning(record.type)) return true;
  const metadata = asRecord(record.metadata);
  if (metadata && (markedAsReasoning(metadata.kind) || markedAsReasoning(metadata.type) || metadata.thought === true || metadata.reasoning === true)) return true;
  const content = asRecord(record.content);
  return Boolean(content && markedAsReasoning(content.$case));
}

// Strips paired <think>...</think> blocks, plus the two half-open shapes that
// show up when a gateway consumes one side of the tag pair as a control token.
export function stripInlineReasoning(text: string): string {
  if (!text || !text.includes('<')) return text;
  let stripped = text;
  for (const tag of REASONING_TAGS) {
    const name = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    stripped = stripped.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, 'gi'), '');
    // Orphan close tag (opening token was swallowed): everything before it is reasoning.
    stripped = stripped.replace(new RegExp(`^[\\s\\S]*?</${name}\\s*>`, 'i'), '');
    // Orphan open tag (response was cut off mid-thought): everything after it is reasoning.
    stripped = stripped.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*$`, 'i'), '');
  }
  const trimmed = stripped.trim();
  return trimmed;
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  // The newest structured report is authoritative, even when invalid. Keep
  // its raw payload for the ordinary report validator to request correction.
  const report = dataFromParts(parts).filter((data) => data.kind === 'megacorps-report').at(-1);
  if (report) return JSON.stringify(report);
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (isReasoningPart(record)) continue;
    if (typeof record.text === 'string') {
      chunks.push(record.text);
      continue;
    }
    const content = record.content as Record<string, unknown> | undefined;
    if (content && content.$case === 'text' && typeof content.value === 'string') chunks.push(content.value);
  }
  const joined = chunks.join('\n').trim();
  const projected = projectFinalText(joined);
  // An explicit envelope's body is already the final answer. Preserve literal
  // tags/content inside it, including the existing chat-actions protocol.
  return projected === joined ? stripInlineReasoning(projected).trim() : projected;
}

function hasTextParts(parts: unknown): boolean {
  return Array.isArray(parts) && parts.some((part) => {
    const record = asRecord(part);
    if (!record) return false;
    const content = asRecord(record.content);
    return (typeof record.text === 'string' && Boolean(record.text.trim()))
      || isReasoningPart(record)
      || (content?.$case === 'text' && typeof content.value === 'string' && Boolean(content.value.trim()));
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dataFromParts(parts: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parts)) return [];
  const found: Record<string, unknown>[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record || isReasoningPart(record)) continue;
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
  for (const data of dataFromParts(parts).reverse()) {
    if (data.kind !== 'megacorps-report') continue;
    const parsed = agentReportSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
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

/** Upgrade pre-projection durable outcomes without decoding new chat bodies twice. */
export function normalizeStoredA2aOutcome(outcome: A2aSendOutcome): A2aSendOutcome {
  if (outcome.finalOutputVersion === 1) return outcome;
  return {
    ...outcome,
    finalOutputVersion: 1,
    text: textFromParts([{ text: outcome.text }]),
    artifacts: outcome.artifacts.map((artifact) => artifact.text === undefined ? artifact : {
      ...artifact, text: textFromParts([{ text: artifact.text }]),
    }),
  };
}

export function normalizeA2aSendResult(result: unknown): A2aSendOutcome {
  const root = asRecord(result) ?? {};
  const task = asRecord(root.task) ?? (looksLikeTask(root) ? root : null);
  const message = asRecord(root.message) ?? asRecord(root.msg) ?? (!task && looksLikeMessage(root) ? root : null);

  if (task) {
    const status = asRecord(task.status);
    const statusMessage = asRecord(status?.message);
    let text = textFromParts(statusMessage?.parts);
    if (!text && !hasTextParts(statusMessage?.parts) && Array.isArray(task.artifacts)) {
      text = task.artifacts
        .map((artifact) => textFromParts(asRecord(artifact)?.parts))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (!text && !hasTextParts(statusMessage?.parts) && !(Array.isArray(task.artifacts) && task.artifacts.length) && Array.isArray(task.history)) {
      const last = asRecord(task.history[task.history.length - 1]);
      text = textFromParts(last?.parts);
    }
    return {
      finalOutputVersion: 1,
      text,
      contextId: typeof task.contextId === 'string' && task.contextId ? task.contextId : null,
      taskId: typeof task.id === 'string' && task.id ? task.id : null,
      state: normalizeState(status?.state),
      report: reportFromParts(statusMessage?.parts),
      artifacts: artifactRefs(task.artifacts),
      usage: transportUsage(asRecord(task.metadata)?.megacorpsUsage, 'a2a_metadata_v1'),
    };
  }

  if (message) {
    return {
      finalOutputVersion: 1,
      text: textFromParts(message.parts),
      contextId: typeof message.contextId === 'string' && message.contextId ? message.contextId : null,
      taskId: typeof message.taskId === 'string' && message.taskId ? message.taskId : null,
      state: null,
      report: reportFromParts(message.parts),
      artifacts: [],
      usage: transportUsage(asRecord(message.metadata)?.megacorpsUsage, 'a2a_metadata_v1'),
    };
  }

  return { finalOutputVersion: 1, text: '', contextId: null, taskId: null, state: null, report: null, artifacts: [] };
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
  usage?: UsageFacts;
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
    ...(transportUsage(asRecord(update.metadata)?.megacorpsUsage, 'a2a_push_metadata_v1') ? { usage: transportUsage(asRecord(update.metadata)?.megacorpsUsage, 'a2a_push_metadata_v1') } : {}),
  };
}

export type A2aRpcOptions = {
  baseUrl: string;
  bearerToken?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export class A2aRpcError extends Error {
  constructor(public readonly code: string | number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'A2aRpcError';
  }
}

export async function a2aRpc(method: string, params: unknown, options: A2aRpcOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let rejectInterrupted: (reason: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const interrupt = (code: string) => {
    rejectInterrupted(new A2aRpcError(code, `${code}: ${method} request interrupted`));
    controller.abort();
  };
  const onAbort = () => interrupt('a2a_rpc_aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => interrupt('a2a_rpc_timeout'), Math.max(1, options.timeoutMs));
  try {
    if (options.signal?.aborted) onAbort();
    return await Promise.race([interrupted, (async () => {
      if (controller.signal.aborted) throw new A2aRpcError('a2a_rpc_aborted', 'a2a_rpc_aborted');
      const response = await fetchImpl(options.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new A2aRpcError(`a2a_http_${response.status}`, `a2a_http_${response.status}: ${method} request to A2A gateway failed`);
      const payload = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
      if (payload.error) {
        const code = typeof payload.error.code === 'number' && Number.isFinite(payload.error.code) ? payload.error.code : 'a2a_rpc_error';
        throw new A2aRpcError(code, `a2a_rpc_error ${code}: ${payload.error.message ?? 'unknown A2A error'}`);
      }
      return payload.result;
    })()]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function getA2aTask(options: A2aRpcOptions & { taskId: string; full?: boolean }): Promise<A2aSendOutcome> {
  return normalizeA2aSendResult(await a2aRpc('GetTask', { id: options.taskId, ...(options.full ? {} : { historyLength: 0 }) }, options));
}

export async function listA2aTasks(options: A2aRpcOptions & { contextId: string; pageToken?: string }): Promise<{ tasks: A2aSendOutcome[]; nextPageToken: string | null }> {
  const result = asRecord(await a2aRpc('ListTasks', {
    contextId: options.contextId, historyLength: 0, includeArtifacts: false,
    ...(options.pageToken ? { pageToken: options.pageToken } : {}),
  }, options));
  if (!result || !Array.isArray(result.tasks)) throw new A2aRpcError('a2a_invalid_list', 'a2a_invalid_list: gateway omitted task list');
  return { tasks: result.tasks.map(normalizeA2aSendResult), nextPageToken: typeof result.nextPageToken === 'string' && result.nextPageToken ? result.nextPageToken : null };
}

export type SendA2aMessageOptions = A2aRpcOptions & {
  text: string;
  contextId?: string | null;
  configuration?: Record<string, unknown> | null;
};

export async function sendA2aMessage(options: SendA2aMessageOptions): Promise<A2aSendOutcome> {
  const message: Record<string, unknown> = {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: options.text }],
  };
  if (options.contextId) message.contextId = options.contextId;
  const params: Record<string, unknown> = { message };
  if (options.configuration) params.configuration = options.configuration;
  const result = await a2aRpc('SendMessage', params, options);
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
