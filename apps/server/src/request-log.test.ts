import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db } from './db/client.ts';
import { registerRequestLogging } from './request-log.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('installed request hooks never fail bodyless, null, health, auth or log-read responses', async t => {
  const writes: any[] = [];
  t.mock.method(db, 'insert', () => ({ values: async (value: unknown) => { writes.push(value); } }) as any);
  const app = Fastify(); t.after(() => app.close()); registerRequestLogging(app);
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/synthetic-bodyless', async () => ({ ok: true }));
  app.post('/api/synthetic-null', async () => null);
  app.get('/api/auth/synthetic', async () => ({ token: 'synthetic-auth-response' }));
  app.get('/api/prompt-logs', async () => ({ items: [{ prompt: 'must not be parsed' }], nextCursor: null }));
  app.get('/api/prompt-logs/:id', async () => ({ prompt: 'must not be parsed' }));
  for (const request of [
    { method: 'GET', url: '/health' },
    { method: 'GET', url: '/api/synthetic-bodyless' },
    { method: 'POST', url: '/api/synthetic-null', payload: null },
    { method: 'GET', url: '/api/auth/synthetic' },
    { method: 'GET', url: '/api/prompt-logs?view=summary' },
    { method: 'GET', url: '/api/prompt-logs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  ] as const) {
    const response = await app.inject(request as any);
    assert.equal(response.statusCode, 200, `${request.method} ${request.url}: ${response.body}`);
  }
  await tick();
  assert.equal(writes.length, 5, 'health metadata stays outside API event persistence');
  const [ordinary, nullBody, auth, summary, detail] = writes;
  assert.equal(ordinary.requestBody, null);
  assert.equal(nullBody.requestBody, null);
  assert.equal(auth.requestBody, '[redacted]'); assert.equal(auth.responseBody, '[redacted]');
  assert.equal(summary.requestBody, null); assert.equal(summary.responseBody, null);
  assert.equal(detail.requestBody, null); assert.equal(detail.responseBody, null);
});

test('saturation and persistence failure diagnostics never expose raw or encoded query secrets', async t => {
  const releases: Array<() => void> = [];
  let calls = 0;
  t.mock.method(db, 'insert', () => ({ values: () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('synthetic-db-error token=synthetic-error-secret'));
    return new Promise<void>((resolve) => releases.push(resolve));
  } }) as any);
  const app = Fastify(); t.after(() => app.close());
  const warnings: unknown[][] = [];
  t.mock.method(app.log, 'warn', (...args: unknown[]) => { warnings.push(args); });
  registerRequestLogging(app);
  app.get('/api/synthetic-saturation', async () => ({ ok: true }));
  await app.inject({ url: '/api/synthetic-saturation?token=synthetic-error-secret' });
  await tick();
  for (let index = 0; index < 32; index++) await app.inject({ url: `/api/synthetic-saturation?ordinary=${index}` });
  const saturated = await app.inject({ url: '/api/synthetic-saturation?t%6Fken=synthetic-overflow-secret&password=synthetic-password-secret' });
  assert.equal(saturated.statusCode, 200);
  const output = JSON.stringify(warnings);
  assert.doesNotMatch(output, /synthetic-(?:error|overflow|password)-secret/);
  assert.match(output, /\[redacted\]|api_event_persist_failed/);
  for (const release of releases) release();
  await tick();
});

test('log reads keep lifecycle metadata without parsing or storing recursive payloads', async () => {
  const module = await import('./request-log.ts') as Record<string, any>;
  assert.equal(module.requestLogInternals.isPayloadSuppressed('/api/prompt-logs?view=summary&q=needle'), true);
  assert.equal(module.requestLogInternals.isPayloadSuppressed('/api/prompt-logs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
  assert.equal(module.requestLogInternals.isPayloadSuppressed('/api/admin/activity?view=summary'), true);
  assert.equal(module.requestLogInternals.isPayloadSuppressed('/api/cards'), false);
  assert.equal(module.requestLogInternals.persistenceHook, 'onResponse');
  const path = module.requestLogInternals.sanitizePath('/api/auth/login?token=synthetic-query-secret&next=%2Flogs');
  assert.doesNotMatch(path, /synthetic-query-secret/);
  assert.match(path, /next=%2Flogs/);
});

test('stored payloads have a global serialized bound while preserving redaction', async () => {
  const { requestLogInternals } = await import('./request-log.ts') as Record<string, any>;
  const payload = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field-${index}`, {
    token: `synthetic-secret-${index}`,
    values: Array.from({ length: 100 }, () => 'x'.repeat(3_000)),
  }]));
  const sanitized = requestLogInternals.sanitizePayload(payload);
  const encoded = JSON.stringify(sanitized);
  assert.ok(Buffer.byteLength(encoded) <= requestLogInternals.maxSerializedBytes, `${Buffer.byteLength(encoded)} exceeds bound`);
  assert.doesNotMatch(encoded, /synthetic-secret/);
});

test('bounded persistence admits no unbounded queue and settles failures', async () => {
  const { requestLogInternals } = await import('./request-log.ts') as Record<string, any>;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const warnings: unknown[] = [];
  const writer = requestLogInternals.createBoundedWriter(1, (error: unknown) => warnings.push(error));
  assert.equal(writer.tryWrite(async () => blocked), true);
  assert.equal(writer.tryWrite(async () => { throw new Error('must not queue'); }), false);
  release();
  await writer.idle();
  assert.equal(writer.tryWrite(async () => { throw new Error('synthetic insert failure'); }), true);
  await writer.idle();
  assert.equal(warnings.length, 1);
  assert.equal(writer.pending(), 0);
});
