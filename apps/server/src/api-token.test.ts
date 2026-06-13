import assert from 'node:assert/strict';
import test from 'node:test';
import { generateApiToken, apiTokenInternals } from './api-token.ts';

test('api tokens use a direct MegaCorps API prefix and hashed storage', () => {
  const token = generateApiToken();
  assert.match(token, /^mca_[A-Za-z0-9_-]{43}$/);
  assert.match(apiTokenInternals.hashApiToken(token), /^[a-f0-9]{64}$/);
  assert.match(apiTokenInternals.previewApiToken(token), /^mca_[A-Za-z0-9_-]{4}\.\.\.[A-Za-z0-9_-]{6}$/);
});
