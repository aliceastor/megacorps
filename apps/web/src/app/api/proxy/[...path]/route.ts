import { NextRequest } from 'next/server';

const DEFAULT_SERVER_API_URLS = ['http://server:4000', 'http://localhost:4000'];

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function uniqueUrls(urls: Array<string | undefined>): string[] {
  return Array.from(new Set(urls.filter(Boolean).map((url) => normalizeUrl(url!))));
}

function serverApiUrls(): string[] {
  return uniqueUrls([
    process.env.SERVER_API_URL,
    process.env.INTERNAL_API_URL,
    ...DEFAULT_SERVER_API_URLS,
    process.env.NEXT_PUBLIC_API_URL,
  ]);
}

function targetUrl(baseUrl: string, request: NextRequest, segments: string[]): string {
  const path = `/${segments.join('/')}`;
  return `${baseUrl}${path}${request.nextUrl.search}`;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');

  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const tried: string[] = [];
  let lastError: unknown;

  for (const apiUrl of serverApiUrls()) {
    tried.push(apiUrl);
    try {
      const response = await fetch(targetUrl(apiUrl, request, path), {
        method: request.method,
        headers,
        body,
        cache: 'no-store',
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      lastError = error;
    }
  }

  return Response.json({
    error: 'api_proxy_unreachable',
    tried,
    message: lastError instanceof Error ? lastError.message : 'unknown proxy error',
  }, { status: 502 });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
