const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
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
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
export { API_URL };
