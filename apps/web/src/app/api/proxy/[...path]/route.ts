import { NextRequest } from 'next/server';

const DEFAULT_SERVER_API_URL = 'http://localhost:4000';

function serverApiUrl(): string {
  const raw = process.env.SERVER_API_URL
    ?? process.env.INTERNAL_API_URL
    ?? process.env.NEXT_PUBLIC_API_URL
    ?? DEFAULT_SERVER_API_URL;
  return raw.replace(/\/+$/, '');
}

function targetUrl(request: NextRequest, segments: string[]): string {
  const path = `/${segments.join('/')}`;
  return `${serverApiUrl()}${path}${request.nextUrl.search}`;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');

  const response = await fetch(targetUrl(request, path), {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    cache: 'no-store',
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
