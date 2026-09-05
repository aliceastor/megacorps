import assert from 'node:assert/strict';
import test from 'node:test';

test('summary and legacy log limits are finite positive integers with separate bounds', async () => {
  const helpers = await import('./log-query.ts') as Record<string, unknown>;
  assert.equal(typeof helpers.parseLogListQuery, 'function');
  const parse = helpers.parseLogListQuery as (query: Record<string, string | undefined>, legacyDefault: number) => { summary: boolean; limit: number };
  assert.deepEqual(parse({}, 200), { summary: false, limit: 200, cursor: null, search: null });
  assert.deepEqual(parse({ view: 'summary' }, 200), { summary: true, limit: 50, cursor: null, search: null });
  assert.equal(parse({ limit: '500' }, 200).limit, 500);
  assert.equal(parse({ view: 'summary', limit: '100' }, 200).limit, 100);
  for (const limit of ['NaN', 'Infinity', '-1', '0', '1.5', '101']) {
    assert.throws(() => parse({ view: 'summary', limit }, 200), /invalid_limit/);
  }
  assert.throws(() => parse({ limit: '501' }, 200), /invalid_limit/);
});

test('opaque cursors preserve the exact database timestamp and reject malformed input', async () => {
  const helpers = await import('./log-query.ts') as Record<string, unknown>;
  assert.equal(typeof helpers.encodeLogCursor, 'function');
  assert.equal(typeof helpers.decodeLogCursor, 'function');
  const encode = helpers.encodeLogCursor as (createdAt: string, id: string) => string;
  const decode = helpers.decodeLogCursor as (cursor: string) => { createdAt: string; id: string };
  const timestamp = '2026-09-06 12:34:56.123456+00';
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual(decode(encode(timestamp, id)), { createdAt: timestamp, id });
  for (const cursor of ['', 'not-base64', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ createdAt: 'today', id })).toString('base64url')]) {
    assert.throws(() => decode(cursor), /invalid_cursor/);
  }
});

test('opaque cursors reject impossible calendar and timezone timestamps before SQL', async () => {
  const { encodeLogCursor, decodeLogCursor } = await import('./log-query.ts');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const createdAt of [
    '2026-02-30 12:34:56.123456+00',
    '2025-02-29 12:34:56+00',
    '2026-04-31 12:34:56+00',
    '2026-09-06 24:00:00.000001+00',
    '2026-09-06 12:60:00+00',
    '2026-09-06 12:34:60+00',
    '2026-09-06 12:34:56+14:01',
    '2026-09-06 12:34:56+15',
  ]) {
    assert.throws(() => decodeLogCursor(encodeLogCursor(createdAt, id)), /invalid_cursor/, createdAt);
  }
  for (const createdAt of [
    '2024-02-29 23:59:59.999999+00',
    '2026-09-06T12:34:56.000001Z',
    '2026-09-06 12:34:56+14:00',
    '2026-09-06 12:34:56-0330',
  ]) {
    assert.deepEqual(decodeLogCursor(encodeLogCursor(createdAt, id)), { createdAt, id }, createdAt);
  }
});
