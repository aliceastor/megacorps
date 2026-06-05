const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
  if (data && typeof data === 'object' && 'error' in data) return String((data as { error?: unknown }).error);
  return typeof data === 'string' ? data : 'request_failed';
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase();
  const shouldSendEmptyJson = method && !['GET', 'HEAD'].includes(method) && init.body === undefined;
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    body: shouldSendEmptyJson ? '{}' : init.body,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  });
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
export { API_URL };
