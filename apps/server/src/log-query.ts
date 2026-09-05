export type LogCursor = { createdAt: string; id: string };

export class LogQueryError extends Error {
  constructor(public readonly code: 'invalid_limit' | 'invalid_cursor' | 'invalid_search') {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export function encodeLogCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeLogCursor(value: string): LogCursor {
  try {
    if (!value || value.length > 512) throw new Error('bad cursor');
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LogCursor>;
    if (typeof decoded.createdAt !== 'string' || !PG_TIMESTAMP.test(decoded.createdAt) || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) {
      throw new Error('bad cursor');
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new LogQueryError('invalid_cursor');
  }
}

function parseLimit(raw: unknown, fallback: number, cap: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new LogQueryError('invalid_limit');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new LogQueryError('invalid_limit');
  return value;
}

export function parseLogListQuery(query: Record<string, unknown>, legacyDefault: number): {
  summary: boolean;
  limit: number;
  cursor: LogCursor | null;
  search: string | null;
} {
  const summary = query.view === 'summary';
  const limit = parseLimit(query.limit, summary ? 50 : legacyDefault, summary ? 100 : 500);
  const cursor = query.cursor === undefined ? null : typeof query.cursor === 'string' ? decodeLogCursor(query.cursor) : (() => { throw new LogQueryError('invalid_cursor'); })();
  if (cursor && !summary) throw new LogQueryError('invalid_cursor');
  if (query.q !== undefined && typeof query.q !== 'string') throw new LogQueryError('invalid_search');
  const normalized = query.q?.trim() ?? '';
  if (normalized.length > 200) throw new LogQueryError('invalid_search');
  return { summary, limit, cursor, search: normalized || null };
}
