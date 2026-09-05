export type LogCursor = { createdAt: string; id: string };

export class LogQueryError extends Error {
  constructor(public readonly code: 'invalid_limit' | 'invalid_cursor' | 'invalid_search') {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function isValidPgTimestamp(value: string): boolean {
  const match = PG_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = days[month] ?? 0;
  return year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= maxDay
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 14 && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0);
}

export function encodeLogCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeLogCursor(value: string): LogCursor {
  try {
    if (!value || value.length > 512) throw new Error('bad cursor');
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LogCursor>;
    if (typeof decoded.createdAt !== 'string' || !isValidPgTimestamp(decoded.createdAt) || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) {
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
