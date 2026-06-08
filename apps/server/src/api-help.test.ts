import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHelpCatalog, apiHelpMarkdown } from './api-help.ts';

test('api help includes response examples and rate-limit notes for every endpoint', () => {
  const catalog = apiHelpCatalog();
  assert.equal(typeof catalog.rateLimits.enforced, 'boolean');
  assert.match(catalog.rateLimits.summary, /rate limiting/i);
  assert.ok(catalog.adapters.includes('hermes-ssh'));
  assert.match(catalog.architecture.model, /multi-agent control plane/i);
  assert.ok(catalog.architecture.surfaces.some((surface) => surface.name === 'Projects' && surface.purpose.includes('Project Authority')));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/departments' && endpoint.group === 'Departments'));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/auth/bootstrap'));
  for (const endpoint of catalog.endpoints) {
    assert.notEqual(endpoint.responseSchema, undefined, `${endpoint.method} ${endpoint.path} missing responseSchema`);
    assert.notEqual(endpoint.responseExample, undefined, `${endpoint.method} ${endpoint.path} missing responseExample`);
    assert.ok(endpoint.rateLimit.length > 0, `${endpoint.method} ${endpoint.path} missing rateLimit`);
    assert.ok(endpoint.requiredRole, `${endpoint.method} ${endpoint.path} missing requiredRole`);
  }
});

test('api help markdown exposes response schema and rate limit sections', () => {
  const markdown = apiHelpMarkdown();
  assert.match(markdown, /## Rate Limits/);
  assert.match(markdown, /## Current Architecture/);
  assert.match(markdown, /Projects \(\/projects\)/);
  assert.match(markdown, /Response schema:/);
  assert.match(markdown, /hermes-ssh/);
});
