import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHelpCatalog, apiHelpMarkdown } from './api-help.ts';

test('api help includes response examples and rate-limit notes for every endpoint', () => {
  const catalog = apiHelpCatalog();
  assert.equal(catalog.rateLimits.enforced, false);
  assert.ok(catalog.adapters.includes('hermes-ssh'));
  for (const endpoint of catalog.endpoints) {
    assert.notEqual(endpoint.responseSchema, undefined, `${endpoint.method} ${endpoint.path} missing responseSchema`);
    assert.notEqual(endpoint.responseExample, undefined, `${endpoint.method} ${endpoint.path} missing responseExample`);
    assert.ok(endpoint.rateLimit.length > 0, `${endpoint.method} ${endpoint.path} missing rateLimit`);
  }
});

test('api help markdown exposes response schema and rate limit sections', () => {
  const markdown = apiHelpMarkdown();
  assert.match(markdown, /## Rate Limits/);
  assert.match(markdown, /Response schema:/);
  assert.match(markdown, /hermes-ssh/);
});
