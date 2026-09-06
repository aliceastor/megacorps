import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { companies, companyMemberships, users, costEvents, kanbanCards } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';

test('dashboard month uses scoped ledger actual, estimated and unknown instead of all-time card cost', async t => {
  const company: any = { id: randomUUID(), name: 'Usage company' }, foreign = randomUUID();
  const user: any = { id: randomUUID(), email: 'usage-routes@example.test', role: 'viewer' };
  const now = new Date(), previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1);
  const usage = [
    { id: randomUUID(), companyId: company.id, costUsd: '1.25', costStatus: 'actual', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: '0.5', costStatus: 'estimated', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: null, costStatus: 'unknown', occurredAt: now },
    { id: randomUUID(), companyId: company.id, costUsd: '10', costStatus: 'actual', occurredAt: previousMonth },
    { id: randomUUID(), companyId: foreign, costUsd: '99', costStatus: 'actual', occurredAt: now },
  ];
  memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'viewer', status: 'active' }]], [costEvents, usage], [kanbanCards, [{ id: randomUUID(), companyId: company.id, columnStatus: 'done', status: 'done', count: 1, costUsd: 25 }]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
  assert.equal(dashboard.statusCode, 200, dashboard.body);
  assert.equal(dashboard.json().stats.monthlyCost, 1.75);
  assert.equal(dashboard.json().usage.actualUsd, '1.25000000');
  assert.equal(dashboard.json().usage.estimatedUsd, '0.50000000');
  assert.equal(dashboard.json().usage.unknownAttempts, 1);
  const summary = await app.inject({ method: 'GET', url: `/api/usage-summary?companyId=${company.id}`, headers });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().totalUsd, '1.75000000');
  const denied = await app.inject({ method: 'GET', url: `/api/usage-summary?companyId=${foreign}`, headers });
  assert.equal(denied.statusCode, 403);
});
