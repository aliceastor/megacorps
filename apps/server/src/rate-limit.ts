import type { FastifyInstance, FastifyRequest } from 'fastify';

type RateLimitPolicy = {
  key: string;
  limit: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function rateLimitPolicyForPath(method: string, path: string): RateLimitPolicy | null {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return null;
  if (path === '/health' || path.startsWith('/api/help')) return null;

  const windowMs = envNumber('RATE_LIMIT_WINDOW_MS', 60_000);
  if (path.startsWith('/api/auth/')) return { key: 'auth', limit: envNumber('RATE_LIMIT_AUTH_PER_MINUTE', 12), windowMs };
  if (path.startsWith('/api/chat/')) return { key: 'chat', limit: envNumber('RATE_LIMIT_CHAT_PER_MINUTE', 40), windowMs };
  if (path.startsWith('/api/webhook/')) return { key: 'webhook', limit: envNumber('RATE_LIMIT_WEBHOOK_PER_MINUTE', 120), windowMs };
  if (path.startsWith('/api/runner/')) return { key: 'runner', limit: envNumber('RATE_LIMIT_RUNNER_PER_MINUTE', 240), windowMs };
  if (path.startsWith('/api/agent/')) return { key: 'agent-session', limit: envNumber('RATE_LIMIT_AGENT_SESSION_PER_MINUTE', 240), windowMs };
  if (path.endsWith('/test-connection') || path === '/api/cron/run') return { key: 'operator', limit: envNumber('RATE_LIMIT_OPERATOR_PER_MINUTE', 20), windowMs };
  if (['POST', 'PUT', 'DELETE'].includes(method)) return { key: 'write', limit: envNumber('RATE_LIMIT_WRITE_PER_MINUTE', 120), windowMs };
  return { key: 'read', limit: envNumber('RATE_LIMIT_READ_PER_MINUTE', 600), windowMs };
}

function clientKey(request: FastifyRequest): string {
  // With TRUST_PROXY, use the right-most X-Forwarded-For hop: it is the address the
  // trusted reverse proxy itself observed, so clients cannot spoof their bucket key
  // by sending a forged X-Forwarded-For prefix.
  const forwarded = truthy(process.env.TRUST_PROXY) ? request.headers['x-forwarded-for'] : undefined;
  const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const hops = header?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return hops[hops.length - 1] || request.ip || 'unknown';
}

const BUCKET_SWEEP_INTERVAL_MS = 60_000;
let lastBucketSweep = 0;

function sweepExpiredBuckets(now: number): void {
  if (now - lastBucketSweep < BUCKET_SWEEP_INTERVAL_MS) return;
  lastBucketSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url;
    const policy = rateLimitPolicyForPath(request.method, path);
    if (!policy) return;

    const now = Date.now();
    sweepExpiredBuckets(now);
    const bucketKey = `${policy.key}:${clientKey(request)}`;
    const existing = buckets.get(bucketKey);
    const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + policy.windowMs };
    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    const remaining = Math.max(0, policy.limit - bucket.count);
    reply.header('X-RateLimit-Limit', policy.limit);
    reply.header('X-RateLimit-Remaining', remaining);
    reply.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > policy.limit) {
      reply.header('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return reply.code(429).send({ error: 'rate_limited', bucket: policy.key, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) });
    }
  });
}
