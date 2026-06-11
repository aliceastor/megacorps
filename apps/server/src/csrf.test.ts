import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { csrfInternals } from './csrf.ts';

function fakeRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

test('requests without Origin or Referer are allowed (non-browser clients)', () => {
  assert.equal(csrfInternals.requestOriginAllowed(fakeRequest({})), true);
  assert.equal(csrfInternals.requestOriginAllowed(fakeRequest({ cookie: 'session=abc' })), true);
});

test('origin matching WEB_ORIGIN is allowed', () => {
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  try {
    assert.equal(csrfInternals.requestOriginAllowed(fakeRequest({ origin: 'http://localhost:3000' })), true);
  } finally {
    delete process.env.WEB_ORIGIN;
  }
});

test('origin matching the proxied web host is allowed', () => {
  const request = fakeRequest({ origin: 'http://192.168.1.5:3000', 'x-megacorps-web-host': '192.168.1.5:3000' });
  assert.equal(csrfInternals.requestOriginAllowed(request), true);
});

test('origin matching the request host is allowed', () => {
  const request = fakeRequest({ origin: 'http://api.example.com', host: 'api.example.com' });
  assert.equal(csrfInternals.requestOriginAllowed(request), true);
});

test('foreign origins are rejected', () => {
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  try {
    const request = fakeRequest({ origin: 'https://evil.example.com', host: 'api.internal:4000', 'x-megacorps-web-host': 'localhost:3000' });
    assert.equal(csrfInternals.requestOriginAllowed(request), false);
  } finally {
    delete process.env.WEB_ORIGIN;
  }
});

test('CSRF_TRUSTED_ORIGINS entries are allowed', () => {
  process.env.CSRF_TRUSTED_ORIGINS = 'https://ops.example.com, https://other.example.com';
  try {
    assert.equal(csrfInternals.requestOriginAllowed(fakeRequest({ origin: 'https://ops.example.com' })), true);
  } finally {
    delete process.env.CSRF_TRUSTED_ORIGINS;
  }
});

test('opaque "null" origin is treated as missing', () => {
  assert.equal(csrfInternals.requestOriginAllowed(fakeRequest({ origin: 'null' })), true);
});
