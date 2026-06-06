import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from './db/client.ts';
import { apiEvents } from './db/schema.ts';
import type { AuthenticatedRequest } from './auth.ts';

type LoggedRequest = AuthenticatedRequest & {
  startedAt?: number;
  requestBodyForLog?: unknown;
};

const SENSITIVE_KEY = /(password|pass|token|secret|jwt|apiKey|keyPath|privateKey)/i;
const MAX_TEXT = 3000;
const REDACTED_PAYLOAD = '[redacted]';

function suppressPayloadLogging(path: string): boolean {
  return path.startsWith('/api/auth/') || path.startsWith('/api/webhook/');
}

function trimText(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}... [truncated]` : value;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max_depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return trimText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

function parsePayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return null;
  if (Buffer.isBuffer(payload)) return trimText(payload.toString('utf8'));
  if (typeof payload !== 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimText(trimmed);
  }
}

function errorFromResponse(statusCode: number, responseBody: unknown): string | null {
  if (statusCode < 400) return null;
  if (responseBody && typeof responseBody === 'object' && 'error' in responseBody) {
    return trimText(String((responseBody as { error?: unknown }).error ?? 'request_failed'));
  }
  return trimText(typeof responseBody === 'string' ? responseBody : (JSON.stringify(responseBody) ?? 'request_failed'));
}

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    (request as LoggedRequest).startedAt = Date.now();
  });

  app.addHook('preHandler', async (request) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
    (request as LoggedRequest).requestBodyForLog = suppressPayloadLogging(path) ? REDACTED_PAYLOAD : sanitize(request.body);
  });

  app.addHook('onSend', async (request: FastifyRequest, reply, payload) => {
    if (!request.url.startsWith('/api/')) return payload;

    const loggedRequest = request as LoggedRequest;
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
    const responseBody = suppressPayloadLogging(path) ? REDACTED_PAYLOAD : sanitize(parsePayload(payload));
    const statusCode = reply.statusCode;

    await db.insert(apiEvents).values({
      userId: loggedRequest.authUser?.id ?? null,
      method: request.method,
      path: request.url,
      statusCode,
      requestBody: loggedRequest.requestBodyForLog ?? null,
      responseBody,
      error: errorFromResponse(statusCode, responseBody),
      durationMs: Date.now() - (loggedRequest.startedAt ?? Date.now()),
    }).catch((error) => app.log.warn({ error }, 'failed to persist api event log'));

    return payload;
  });
}
