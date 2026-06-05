const BAKED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

function isLocalApiUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(url);
}

function getApiUrl(): string {
  const fallback = BAKED_API_URL || 'http://localhost:4000';
  if (typeof window === 'undefined') return fallback;

  const { protocol, hostname } = window.location;
  const isLocalBrowser = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (isLocalBrowser) return fallback;
  if (BAKED_API_URL && !isLocalApiUrl(BAKED_API_URL)) return BAKED_API_URL;
  return `${protocol}//${hostname}:4000`;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function parseResponse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(data: unknown): string {
  if (Array.isArray(data)) return data.map(formatIssue).join('\n');
  if (data && typeof data === 'object' && 'issues' in data && Array.isArray((data as { issues?: unknown }).issues)) {
    return (data as { issues: unknown[] }).issues.map(formatIssue).join('\n');
  }
  if (data && typeof data === 'object' && 'error' in data) return String((data as { error?: unknown }).error);
  return typeof data === 'string' ? data : 'request_failed';
}

function formatIssue(issue: unknown): string {
  if (!issue || typeof issue !== 'object') return String(issue);
  const row = issue as { path?: unknown[]; code?: string; minimum?: number; message?: string };
  const field = row.path?.length ? String(row.path.join('.')) : 'field';
  if (row.code === 'too_small' && typeof row.minimum === 'number') return `${field} must be at least ${row.minimum} characters.`;
  return `${field}: ${row.message ?? 'invalid value'}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase();
  const shouldSendEmptyJson = method && !['GET', 'HEAD'].includes(method) && init.body === undefined;
  const apiUrl = getApiUrl();
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      body: shouldSendEmptyJson ? '{}' : init.body,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
    });
  } catch (error) {
    throw new ApiError(`API unreachable at ${apiUrl}. Check that the server container is running.`, 0, error);
  }
  const text = await response.text();
  const data = parseResponse(text);
  if (!response.ok) {
    const message = errorMessage(data);
    if (typeof window !== 'undefined' && (message === 'auth_required' || message === 'auth_expired')) {
      const next = `${window.location.pathname}${window.location.search}`;
      if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/signup')) {
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
      }
    }
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}
const API_URL = getApiUrl();
export { API_URL, getApiUrl };
