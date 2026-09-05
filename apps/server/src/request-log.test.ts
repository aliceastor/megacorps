import assert from 'node:assert/strict';
import test from 'node:test';

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
