import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHelpCatalog, apiHelpMarkdown } from './api-help.ts';

const registeredRoutes = [
  ['GET', '/health'],
  ['GET', '/api/help'],
  ['GET', '/api/live'],
  ['GET', '/api/auth/status'],
  ['POST', '/api/auth/bootstrap'],
  ['POST', '/api/auth/signup'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/invites'],
  ['POST', '/api/auth/accept-invite'],
  ['GET', '/api/me'],
  ['GET', '/api/admin/settings'],
  ['PUT', '/api/admin/settings'],
  ['GET', '/api/admin/users'],
  ['PUT', '/api/admin/users/:id'],
  ['GET', '/api/system-logs'],
  ['GET', '/api/activity'],
  ['GET', '/api/heartbeat-runs'],
  ['GET', '/api/task-runs'],
  ['GET', '/api/cost-events'],
  ['GET', '/api/approvals'],
  ['PUT', '/api/approvals/:id'],
  ['GET', '/api/budget-policies'],
  ['POST', '/api/budget-policies'],
  ['PUT', '/api/budget-policies/:id'],
  ['DELETE', '/api/budget-policies/:id'],
  ['GET', '/api/dashboard'],
  ['GET', '/api/companies'],
  ['POST', '/api/companies'],
  ['PUT', '/api/companies/:id'],
  ['DELETE', '/api/companies/:id'],
  ['GET', '/api/company-memberships'],
  ['POST', '/api/company-memberships'],
  ['PUT', '/api/company-memberships/:id'],
  ['DELETE', '/api/company-memberships/:id'],
  ['GET', '/api/departments'],
  ['POST', '/api/departments'],
  ['GET', '/api/positions'],
  ['POST', '/api/positions'],
  ['PUT', '/api/positions/:id'],
  ['DELETE', '/api/positions/:id'],
  ['GET', '/api/cards'],
  ['POST', '/api/cards'],
  ['PUT', '/api/cards/:id'],
  ['POST', '/api/cards/:id/cancel'],
  ['DELETE', '/api/cards/:id'],
  ['GET', '/api/cards/:id/logs'],
  ['GET', '/api/cards/:id/actions'],
  ['GET', '/api/cards/:id/comments'],
  ['GET', '/api/cards/:id/work-products'],
  ['POST', '/api/cards/:id/work-products'],
  ['POST', '/api/cards/:id/comments'],
  ['POST', '/api/cards/:id/run'],
  ['POST', '/api/cards/:id/review'],
  ['POST', '/api/cards/:id/decompose'],
  ['GET', '/api/agents'],
  ['POST', '/api/agents'],
  ['DELETE', '/api/agents/:id'],
  ['POST', '/api/agents/:id/pause'],
  ['POST', '/api/agents/:id/resume'],
  ['POST', '/api/agents/:id/reset-session'],
  ['PUT', '/api/agents/:id'],
  ['GET', '/api/agent-runtimes'],
  ['GET', '/api/agent-runtimes/health'],
  ['POST', '/api/agent-runtimes'],
  ['PUT', '/api/agent-runtimes/:id'],
  ['DELETE', '/api/agent-runtimes/:id'],
  ['POST', '/api/agents/:id/test-connection'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['PUT', '/api/projects/:id'],
  ['DELETE', '/api/projects/:id'],
  ['GET', '/api/goals'],
  ['POST', '/api/goals'],
  ['GET', '/api/knowledge-docs'],
  ['POST', '/api/knowledge-docs'],
  ['PUT', '/api/knowledge-docs/:id'],
  ['DELETE', '/api/knowledge-docs/:id'],
  ['POST', '/api/webhook/task-complete'],
  ['GET', '/api/machine-runners'],
  ['POST', '/api/machine-runners'],
  ['PUT', '/api/machine-runners/:id'],
  ['POST', '/api/machine-runners/:id/rotate-key'],
  ['DELETE', '/api/machine-runners/:id'],
  ['GET', '/api/runner/me'],
  ['POST', '/api/runner/heartbeat'],
  ['POST', '/api/runner/agent-sessions'],
  ['POST', '/api/runner/task-runs/claim'],
  ['POST', '/api/runner/task-runs/:id/complete'],
  ['GET', '/api/agent/me'],
  ['POST', '/api/agent/cards/:id/claim'],
  ['POST', '/api/agent/cards/:id/review'],
  ['POST', '/api/agent/cards/:id/release'],
  ['GET', '/api/chat/sessions'],
  ['POST', '/api/chat/sessions'],
  ['GET', '/api/chat/sessions/:id/messages'],
  ['POST', '/api/chat/sessions/:id/messages'],
  ['GET', '/api/cron/status'],
  ['GET', '/api/cron/runs'],
  ['POST', '/api/cron/run'],
] as const;

test('api help includes response examples and rate-limit notes for every endpoint', () => {
  const catalog = apiHelpCatalog();
  assert.equal(typeof catalog.rateLimits.enforced, 'boolean');
  assert.match(catalog.rateLimits.summary, /rate limiting/i);
  assert.ok(catalog.adapters.includes('hermes-ssh'));
  assert.match(catalog.architecture.model, /multi-agent control plane/i);
  assert.ok(catalog.architecture.surfaces.some((surface) => surface.name === 'Projects' && surface.purpose.includes('Project Authority')));
  assert.ok(catalog.architecture.surfaces.some((surface) => surface.name === 'Positions' && surface.primaryApi.includes('/api/positions')));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/departments' && endpoint.group === 'Departments'));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/positions' && endpoint.group === 'Positions'));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/auth/bootstrap'));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/runner/task-runs/claim' && endpoint.auth === 'runner'));
  assert.ok(catalog.endpoints.some((endpoint) => endpoint.path === '/api/agent/cards/:id/claim' && endpoint.auth === 'agent-session'));
  assert.ok(catalog.cli.commands.some((command) => command.command === 'apply' && command.auth === 'session'));
  assert.match(catalog.cli.manifestExample, /positions:/);
  assert.match(catalog.cli.manifestExample, /dependencies/);
  for (const endpoint of catalog.endpoints) {
    assert.notEqual(endpoint.responseSchema, undefined, `${endpoint.method} ${endpoint.path} missing responseSchema`);
    assert.notEqual(endpoint.responseExample, undefined, `${endpoint.method} ${endpoint.path} missing responseExample`);
    assert.ok(endpoint.rateLimit.length > 0, `${endpoint.method} ${endpoint.path} missing rateLimit`);
    assert.ok(endpoint.requiredRole, `${endpoint.method} ${endpoint.path} missing requiredRole`);
  }
});

test('api help covers every registered HTTP route', () => {
  const catalog = apiHelpCatalog();
  const helpRoutes = new Set(catalog.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`));
  for (const [method, path] of registeredRoutes) {
    assert.ok(helpRoutes.has(`${method} ${path}`), `Missing API help entry for ${method} ${path}`);
  }
});

test('api help markdown exposes response schema and rate limit sections', () => {
  const markdown = apiHelpMarkdown();
  assert.match(markdown, /## Rate Limits/);
  assert.match(markdown, /## CLI Commands/);
  assert.match(markdown, /## Current Architecture/);
  assert.match(markdown, /Projects \(\/projects\)/);
  assert.match(markdown, /megacorps runner daemon/);
  assert.match(markdown, /Response schema:/);
  assert.match(markdown, /hermes-ssh/);
});
