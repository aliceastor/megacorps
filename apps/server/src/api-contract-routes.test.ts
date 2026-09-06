import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { users, companies, companyMemberships, apiEvents, agentRuntimes } from './db/schema.ts';
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

test('runtime health describes configuration and observations without claiming connection reachability', async t => {
  const { app, state, company, headers } = await fixture(t);
  state.rows(agentRuntimes).push({ id: randomUUID(), companyId: company.id, name: 'Configured A2A', adapterType: 'a2a', isActive: true });
  let probes = 0; t.mock.method(globalThis, 'fetch', async () => { probes++; throw new Error('No external probes are permitted by this read contract'); });
  const response = await app.inject({ url: '/api/agent-runtimes/health', headers });
  assert.equal(response.statusCode, 200, response.body);
  const health = response.json()[0];
  assert.equal(health.reachability, 'not_checked');
  assert.equal(health.statusBasis, 'configuration_and_observed_runs');
  assert.equal(health.status, 'ready'); assert.equal(health.lastRunStatus, null);
  assert.deepEqual(health.capabilities, ['a2a', 'json-rpc', 'task-push-notifications']);
  assert.equal(probes, 0);
  const help = (await app.inject({ url: '/api/help' })).json().endpoints.find((entry: any) => entry.path === '/api/agent-runtimes/health');
  assert.deepEqual(Object.keys(help.responseExample[0]).sort(), Object.keys(health).sort());
});

test('company setup and readiness Help describe actual role-checked read envelopes', async t => {
  const { app, state, company, headers, user } = await fixture(t);
  state.rows(users)[0]!.role = 'operator'; state.rows(companyMemberships)[0]!.role = 'operator';
  for (const suffix of ['setup', 'execution-readiness']) await t.test(suffix, async () => {
    const response = await app.inject({ url: `/api/companies/${company.id}/${suffix}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const entry = (await app.inject({ url: '/api/help' })).json().endpoints.find((entry: any) => entry.path === `/api/companies/:id/${suffix}` && entry.method === 'GET');
    assert.notEqual(entry.responseExample, null, `${suffix} needs its actual response envelope`);
    assert.deepEqual(Object.keys(entry.responseExample).sort(), Object.keys(response.json()).sort());
  });
});

test('Help labels callback authentication that the actual routes enforce', async t => {
  const { app } = await fixture(t);
  const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-contract-webhook';
  t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
  for (const [path, auth] of [['/api/webhook/task-complete', 'webhook'], ['/api/gitea/events', 'gitea-token']]) await t.test(path!, async () => {
    const denied = await app.inject({ method: 'POST', url: path!, payload: {} }); assert.equal(denied.statusCode, 401, denied.body);
    const entry = (await app.inject({ url: '/api/help' })).json().endpoints.find((entry: any) => entry.path === path);
    assert.equal(entry.auth, auth);
  });
});

