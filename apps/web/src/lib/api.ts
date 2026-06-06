const BAKED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

function isLocalApiUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(url);
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function uniqueUrls(urls: string[]): string[] {
  return Array.from(new Set(urls.filter(Boolean).map(normalizeApiUrl)));
}

function getBrowserApiUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:4000`;
}

function getApiCandidates(): string[] {
  const fallback = normalizeApiUrl(BAKED_API_URL || 'http://localhost:4000');
  if (typeof window === 'undefined') return [fallback];

  const { hostname } = window.location;
  const isLocalBrowser = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const browserApiUrl = getBrowserApiUrl();

  if (isLocalBrowser && BAKED_API_URL && !isLocalApiUrl(BAKED_API_URL)) return uniqueUrls([fallback, browserApiUrl ?? '']);
  return uniqueUrls([browserApiUrl ?? '', fallback]);
}

function getApiUrl(): string {
  return getApiCandidates()[0] ?? 'http://localhost:4000';
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
  const raw = data && typeof data === 'object' && 'error' in data
    ? String((data as { error?: unknown }).error)
    : typeof data === 'string' ? data : 'request_failed';
  return friendlyError(raw);
}

function friendlyError(message: string): string {
  if (message === 'signup_disabled') return 'Signup is disabled by an admin. Use an invite link or ask an admin to re-enable signup.';
  if (message === 'invalid_credentials') return 'Invalid email or password.';
  if (message === 'user_disabled') return 'This account is disabled. Contact an admin.';
  if (message === 'last_admin_required') return 'At least one active admin account is required.';
  if (message === 'DB auth.jwt_secret must be at least 32 characters') return 'The DB session secret is invalid. Check app_settings.auth.jwt_secret.';
  return message;
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
  const apiUrls = getApiCandidates();
  let response: Response | null = null;
  let lastNetworkError: unknown;

  for (const apiUrl of apiUrls) {
    try {
      response = await fetch(`${apiUrl}${path}`, {
        ...init,
        body: shouldSendEmptyJson ? '{}' : init.body,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        cache: 'no-store',
      });
      break;
    } catch (error) {
      lastNetworkError = error;
    }
  }

  if (!response) {
    throw new ApiError(`API unreachable. Tried ${apiUrls.join(', ')}. Check that the server container is running and reachable from this browser.`, 0, lastNetworkError);
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
export { API_URL, getApiCandidates, getApiUrl };
