import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from './db/client.ts';
import { apiEvents } from './db/schema.ts';
import type { AuthenticatedRequest } from './auth.ts';

type LoggedRequest = AuthenticatedRequest & {
  startedAt?: number;
  requestBodyForLog?: unknown;
  responseBodyForLog?: unknown;
  responseErrorForLog?: string | null;
};

const SENSITIVE_KEY = /(password|pass|token|secret|jwt|apiKey|keyPath|privateKey)/i;
const MAX_TEXT = 3000;
const MAX_SERIALIZED_BYTES = 32 * 1024;
const MAX_COLLECTION_ITEMS = 100;
const MAX_NODES = 600;
const MAX_PENDING_WRITES = 32;
const REDACTED_PAYLOAD = '[redacted]';
const LOG_READ_PATHS = [
  '/api/system-logs',
  '/api/prompt-logs',
  '/api/activity',
  '/api/admin/activity',
  '/api/heartbeat-runs',
  '/api/task-runs',
  '/api/cron/runs',
  '/api/cron/status',
];

function pathOnly(path: string): string {
  return path.split('?')[0] ?? path;
}

function isPayloadSuppressed(path: string): boolean {
  const normalized = pathOnly(path);
  return LOG_READ_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isSensitiveTransport(path: string): boolean {
  const normalized = pathOnly(path);
  return normalized.startsWith('/api/auth/') || normalized.startsWith('/api/webhook/');
}

function sanitizePath(path: string): string {
  const separator = path.indexOf('?');
  if (separator < 0) return path;
  const pathname = path.slice(0, separator);
  const params = new URLSearchParams(path.slice(separator + 1));
  const sanitized = new URLSearchParams();
  for (const [key, value] of params) {
    sanitized.append(key, SENSITIVE_KEY.test(key) ? REDACTED_PAYLOAD : value);
  }
  const query = sanitized.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function trimText(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}... [truncated]` : value;
}

function fitJsonPreview(value: string, marker: string): { truncated: true; preview: string } {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { truncated: true as const, preview: `${value.slice(0, middle)}${marker}` };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_SERIALIZED_BYTES) low = middle;
    else high = middle - 1;
  }
  return { truncated: true, preview: `${value.slice(0, low)}${marker}` };
}

function sanitizePayload(value: unknown): unknown {
  let nodes = 0;
  let approximateBytes = 0;
  const visit = (nested: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || approximateBytes >= MAX_SERIALIZED_BYTES) return '[payload_truncated]';
    if (depth > 6) return '[max_depth]';
    if (nested === null || nested === undefined) return nested;
    if (typeof nested === 'string') {
      const result = trimText(nested);
      approximateBytes += Buffer.byteLength(result);
      return result;
    }
    if (typeof nested === 'number' || typeof nested === 'boolean') {
      approximateBytes += 16;
      return nested;
    }
    if (Array.isArray(nested)) {
      const result = nested.slice(0, MAX_COLLECTION_ITEMS).map((item) => visit(item, depth + 1));
      if (nested.length > result.length) result.push(`[${nested.length - result.length} more items]`);
      return result;
    }
    if (typeof nested === 'object') {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(nested as Record<string, unknown>);
      for (const [key, item] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
        approximateBytes += Buffer.byteLength(key) + 4;
        result[key] = SENSITIVE_KEY.test(key) ? REDACTED_PAYLOAD : visit(item, depth + 1);
        if (approximateBytes >= MAX_SERIALIZED_BYTES || nodes >= MAX_NODES) break;
      }
      if (entries.length > Object.keys(result).length) result.__truncatedKeys = entries.length - Object.keys(result).length;
      return result;
    }
    return trimText(String(nested));
  };

  const sanitized = visit(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized) <= MAX_SERIALIZED_BYTES) return sanitized;
  const marker = '... [payload truncated]';
  return fitJsonPreview(serialized, marker);
}

function parsePayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return null;
  if (Buffer.isBuffer(payload)) return trimText(payload.toString('utf8'));
  if (typeof payload !== 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return trimText(trimmed); }
}

function errorFromResponse(statusCode: number, responseBody: unknown): string | null {
  if (statusCode < 400) return null;
  if (responseBody && typeof responseBody === 'object' && 'error' in responseBody) {
    return trimText(String((responseBody as { error?: unknown }).error ?? 'request_failed'));
  }
  return trimText(typeof responseBody === 'string' ? responseBody : (JSON.stringify(responseBody) ?? 'request_failed'));
}

function createBoundedWriter(maxPending: number, onError: (error: unknown) => void) {
  const active = new Set<Promise<void>>();
  return {
    tryWrite(work: () => Promise<unknown>): boolean {
      if (active.size >= maxPending) return false;
      let operation!: Promise<void>;
      operation = Promise.resolve().then(work).then(() => undefined, onError).finally(() => active.delete(operation));
      active.add(operation);
      return true;
    },
    pending: () => active.size,
    idle: async () => { await Promise.all([...active]); },
  };
}

export const requestLogInternals = {
  createBoundedWriter,
  isPayloadSuppressed,
  maxSerializedBytes: MAX_SERIALIZED_BYTES,
  persistenceHook: 'onResponse' as const,
  sanitizePath,
  sanitizePayload,
};

export function registerRequestLogging(app: FastifyInstance): void {
  const writer = createBoundedWriter(MAX_PENDING_WRITES, () => app.log.warn({ error: 'api_event_persist_failed' }, 'failed to persist api event log'));

  app.addHook('onRequest', async (request) => {
    (request as LoggedRequest).startedAt = Date.now();
  });

  app.addHook('preHandler', async (request) => {
    const path = request.routeOptions.url ?? request.url;
    try {
      (request as LoggedRequest).requestBodyForLog = isPayloadSuppressed(path)
        ? null
        : isSensitiveTransport(path) ? REDACTED_PAYLOAD : sanitizePayload(request.body);
    } catch {
      (request as LoggedRequest).requestBodyForLog = null;
      app.log.warn({ error: 'api_event_sanitize_failed' }, 'failed to sanitize api event request');
    }
  });

  app.addHook('onSend', async (request: FastifyRequest, reply, payload) => {
    if (!request.url.startsWith('/api/')) return payload;
    const loggedRequest = request as LoggedRequest;
    const path = request.routeOptions.url ?? request.url;
    if (isPayloadSuppressed(path)) {
      loggedRequest.responseBodyForLog = null;
      loggedRequest.responseErrorForLog = reply.statusCode >= 400 ? 'log_read_failed' : null;
      return payload;
    }
    try {
      const responseBody = isSensitiveTransport(path) ? REDACTED_PAYLOAD : sanitizePayload(parsePayload(payload));
      loggedRequest.responseBodyForLog = responseBody;
      loggedRequest.responseErrorForLog = errorFromResponse(reply.statusCode, responseBody);
    } catch {
      loggedRequest.responseBodyForLog = null;
      loggedRequest.responseErrorForLog = reply.statusCode >= 400 ? 'request_failed' : null;
      app.log.warn({ error: 'api_event_sanitize_failed' }, 'failed to sanitize api event response');
    }
    return payload;
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (!request.url.startsWith('/api/')) return done();
    const loggedRequest = request as LoggedRequest;
    const accepted = writer.tryWrite(() => db.insert(apiEvents).values({
      userId: loggedRequest.authUser?.id ?? null,
      method: request.method,
      path: sanitizePath(request.url),
      statusCode: reply.statusCode,
      requestBody: loggedRequest.requestBodyForLog ?? null,
      responseBody: loggedRequest.responseBodyForLog ?? null,
      error: loggedRequest.responseErrorForLog ?? null,
      durationMs: Date.now() - (loggedRequest.startedAt ?? Date.now()),
    }));
    if (!accepted) app.log.warn({ path: sanitizePath(request.url) }, 'api event log dropped because persistence is saturated');
    done();
  });
}
