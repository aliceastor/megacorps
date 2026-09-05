import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { db } from './db/client.ts';
import { users, companies, companyMemberships, activityLog, appSettings, goals } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { signSession } from './auth.ts';
import { registerRoutes } from './routes.ts';

async function fixture(t: any, companyCount = 0) {
  const user = { id: randomUUID(), email: 'admin@example.test', role: 'admin', status: 'active' };
  const companyRows = Array.from({ length: companyCount }, (_, i) => ({ id: randomUUID(), name: `Company ${i}`, slug: `company-${i}` }));
  const state = memoryDb(t, [[users, [user]], [companies, companyRows], [companyMemberships, companyRows.map(c => ({ userId: user.id, companyId: c.id, role: 'admin', status: 'active' }))]]);
  t.mock.method(db, 'execute', async () => []);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  return { state, user, app, headers: { cookie: `session=${await signSession(user)}` } };
}

test('companyless admin settings and user updates keep meaningful global audit', async t => {
  const { app, headers, user, state } = await fixture(t);
  const settings = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers, payload: {} });
  assert.equal(settings.statusCode, 200, settings.body);
  const update = await app.inject({ method: 'PUT', url: `/api/admin/users/${user.id}`, headers, payload: { name: 'Updated Admin' } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(state.rows(activityLog).length, 2);
  assert.ok(state.rows(activityLog).every(row => row.companyId === null && row.userId === user.id));
});

for (const count of [0, 2]) test(`scoped creation with ${count} visible companies requires context before writes`, async t => {
  const { app, headers, state } = await fixture(t, count);
  const response = await app.inject({ method: 'POST', url: '/api/goals', headers, payload: { title: 'Never silently assign' } });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'company_required');
  assert.match(response.json().message, /companyId/);
  assert.equal(state.rows(goals).length, 0);
});

test('single visible company remains compatible for scoped creation', async t => {
  const { app, headers, state } = await fixture(t, 1);
  const response = await app.inject({ method: 'POST', url: '/api/goals', headers, payload: { title: 'Explicit single scope' } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().companyId, state.rows(companies)[0]!.id);
});

test('signup creates first admin with no company or implicit membership', async t => {
  const { app, state } = await fixture(t);
  state.rows(users).splice(0); state.rows(appSettings).push({ key: 'auth.signup_enabled', value: 'true' });
  const response = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'first@example.test', name: 'First', password: 'Synthetic-test-password-42' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().user.role, 'admin');
  assert.equal(state.rows(companyMemberships).length, 0);
  assert.equal(state.rows(companies).length, 0);
  assert.equal(state.rows(activityLog)[0]?.companyId, null);
});


test('global audit is readable only through the global admin boundary', async t => {
  const { app, headers, user, state } = await fixture(t);
  state.rows(activityLog).push({ id: randomUUID(), companyId: null, action: 'admin.settings.updated' });
  const read = await app.inject({ url: '/api/admin/activity', headers });
  assert.equal(read.statusCode, 200); assert.equal(read.json().length, 1);
  user.role = 'viewer';
  const denied = await app.inject({ url: '/api/admin/activity', headers });
  assert.equal(denied.statusCode, 403);
  const ordinary = await app.inject({ url: '/api/activity', headers });
  assert.deepEqual(ordinary.json(), []);
});

test('companyless bootstrap denies an invalid token and creates the first admin with a valid token', async t => {
  const previous = process.env.BOOTSTRAP_TOKEN;
  process.env.BOOTSTRAP_TOKEN = 'Synthetic-bootstrap-token-2026';
  t.after(() => { if (previous === undefined) delete process.env.BOOTSTRAP_TOKEN; else process.env.BOOTSTRAP_TOKEN = previous; });
  const { app, state } = await fixture(t); state.rows(users).splice(0);
  const payload = { email: 'bootstrap@example.test', name: 'Bootstrap', password: 'Synthetic-password-2026' };
  const denied = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload });
  assert.equal(denied.statusCode, 401, denied.body); assert.equal(state.rows(users).length, 0);
  const allowed = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { ...payload, token: process.env.BOOTSTRAP_TOKEN } });
  assert.equal(allowed.statusCode, 200, allowed.body); assert.equal(allowed.json().user.role, 'admin');
  assert.equal(state.rows(companies).length, 0); assert.equal(state.rows(companyMemberships).length, 0);
});

test('unrelated legacy company edits remain possible; only a new dispatch enable requires setup', async t => {
  const { app, headers, state }=await fixture(t,1);const company=state.rows(companies)[0]!;company.autoDispatchEnabled=true;
  const edit=await app.inject({method:'PUT',url:`/api/companies/${company.id}`,headers,payload:{name:'Edited legacy',autoDispatchEnabled:true}});
  assert.equal(edit.statusCode,200,edit.body);assert.equal(company.name,'Edited legacy');
  company.autoDispatchEnabled=false;
  const enable=await app.inject({method:'PUT',url:`/api/companies/${company.id}`,headers,payload:{autoDispatchEnabled:true}});
  assert.equal(enable.statusCode,409,enable.body);assert.equal(company.autoDispatchEnabled,false);
});
