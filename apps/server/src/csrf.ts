import type { FastifyInstance, FastifyRequest } from 'fastify';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originHost(value: string | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function trustedOrigins(): Set<string> {
  const configured = [
    process.env.WEB_ORIGIN,
    ...(process.env.CSRF_TRUSTED_ORIGINS ?? '').split(','),
  ];
  const hosts = new Set<string>();
  for (const entry of configured) {
    const host = originHost(entry?.trim());
    if (host) hosts.add(host);
  }
  return hosts;
}

function requestOriginAllowed(request: FastifyRequest): boolean {
  const origin = headerValue(request.headers.origin) ?? headerValue(request.headers.referer);
  const host = originHost(origin);
  // Non-browser clients (CLI, runners, server-to-server calls) do not send Origin or
  // Referer; the session cookie cannot be attached cross-site by them, so allow.
  if (!host) return true;
  if (trustedOrigins().has(host)) return true;
  // Direct same-origin API access (browser talking straight to the Fastify host).
  const requestHost = headerValue(request.headers.host)?.toLowerCase();
  if (requestHost && host === requestHost) return true;
  // Same-origin requests forwarded by the Next.js proxy: the proxy always overwrites
  // x-megacorps-web-host with the host the browser actually used, so a matching
  // Origin proves the request came from our own web UI on that host.
  const proxiedWebHost = headerValue(request.headers['x-megacorps-web-host'] as string | string[] | undefined)?.toLowerCase();
  if (proxiedWebHost && host === proxiedWebHost) return true;
  const forwardedHost = headerValue(request.headers['x-forwarded-host'] as string | string[] | undefined)?.split(',')[0]?.trim().toLowerCase();
  if (forwardedHost && host === forwardedHost) return true;
  return false;
}

export function registerCsrfOriginCheck(app: FastifyInstance): void {
  if (process.env.CSRF_ORIGIN_CHECK === 'false') return;
  app.addHook('onRequest', async (request, reply) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;
    // Only session-cookie auth is CSRF-prone; bearer/runner/webhook secrets cannot be
    // attached by a foreign page, so requests without a session cookie are exempt.
    const cookieHeader = headerValue(request.headers.cookie);
    if (!cookieHeader || !/(?:^|;\s*)session=/.test(cookieHeader)) return;
    if (requestOriginAllowed(request)) return;
    request.log.warn({ origin: request.headers.origin, referer: request.headers.referer, path: request.url }, 'csrf origin rejected');
    return reply.code(403).send({ error: 'csrf_origin_rejected' });
  });
}

export const csrfInternals = { requestOriginAllowed, originHost, trustedOrigins };
