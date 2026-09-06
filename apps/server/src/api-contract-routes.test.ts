import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { users, companies, companyMemberships, apiEvents } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { signSession } from './auth.ts';
import { registerRoutes } from './routes.ts';
import { registerRequestLogging } from './request-log.ts';

async function fixture(t: any) {
  const user = { id: randomUUID(), email: 'contracts@example.test', role: 'viewer', status: 'active' };
  const company = { id: randomUUID(), name: 'Synthetic', slug: 'synthetic' };
  const state = memoryDb(t, [[users, [user]], [companies, [company]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'viewer', status: 'active' }]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); registerRequestLogging(app); await registerRoutes(app);
  return { app, state, user, company, headers: { cookie: `session=${await signSession(user)}` } };
}

for (const path of ['/api/dashboard', '/api/search', '/api/dashboard/timeseries', '/api/cron/status']) test(`Help describes the actual authenticated ${path} object envelope`, async t => {
  const { app, headers, state, user } = await fixture(t);
  const response = await app.inject({ url: path, headers });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json(); assert.equal(Array.isArray(body), false);
  const help = await app.inject({ url: '/api/help', headers }); assert.equal(help.statusCode, 200);
  const entry = help.json().endpoints.find((entry: any) => entry.path === path && entry.method === 'GET');
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry.responseExample).sort(), Object.keys(body).sort());
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.rows(apiEvents).some(row => row.path === path && row.statusCode === 200 && row.userId === user.id));
});
