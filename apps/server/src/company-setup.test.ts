import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { db } from './db/client.ts';
import {
  companies,
  users,
  companyMemberships,
  positions,
  agents,
  departments,
  agentRuntimes,
} from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { signSession } from './auth.ts';
import { registerRoutes } from './routes.ts';

async function fixture(t: any) {
  const user = { id: randomUUID(), email: 'setup@example.test', role: 'admin', status: 'active' };
  const state = memoryDb(t, [[users, [user]]]);
  t.mock.method(db, 'execute', async () => []);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const request = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: any) =>
    app.inject({ method, url, payload, headers });
  return { state, user, app, request };
}

test('setup persists sequential entity IDs and retries/back edits never create duplicate agents', async (t) => {
  const { request, state } = await fixture(t);
  const input = {
    setupKey: randomUUID(),
    name: 'Beginner company',
    slug: 'beginner',
    mission: 'Build useful things',
  };
  const created = await request('POST', '/api/company-setup', input);
  assert.equal(created.statusCode, 201, created.body);
  const repeated = await request('POST', '/api/company-setup', input);
  assert.equal(repeated.json().company.id, created.json().company.id);
  assert.equal(state.rows(companies).length, 1);
  const id = created.json().company.id;
  for (let i = 0; i < 2; i++) {
    const result = await request('PUT', `/api/companies/${id}/setup`, {
      step: 'boss',
      name: 'Boss',
      slug: 'boss',
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  assert.equal(state.rows(agents).length, 1);
  const dept = await request('PUT', `/api/companies/${id}/setup`, {
    step: 'department',
    name: 'Product',
    slug: 'product',
    description: 'Ship useful products',
  });
  assert.equal(dept.statusCode, 200, dept.body);
  const head = await request('PUT', `/api/companies/${id}/setup`, {
    step: 'head',
    name: 'Product head',
    slug: 'product-head',
  });
  assert.equal(head.statusCode, 200, head.body);
  const resumed = await request('GET', `/api/companies/${id}/setup`);
  assert.equal(resumed.json().boss.name, 'Boss');
  assert.equal(resumed.json().head.name, 'Product head');
  assert.notEqual(resumed.json().boss.id, resumed.json().head.id);
  assert.equal(resumed.json().head.departmentId, resumed.json().department.id);
  assert.equal(state.rows(agents).length, 2);
  assert.equal(state.rows(departments).length, 1);
  assert.equal(state.rows(companies)[0]?.autoDispatchEnabled, false);
  const finish = await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' });
  assert.equal(finish.statusCode, 409, finish.body);
  assert.equal(state.rows(companies)[0]?.autoDispatchEnabled, false);
});

test('setup cannot choose another company runtime or combine Boss and head', async (t) => {
  const { request, state } = await fixture(t);
  const created = await request('POST', '/api/company-setup', {
    setupKey: randomUUID(),
    name: 'Scope',
    slug: 'scope',
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().company.id;
  await request('PUT', `/api/companies/${id}/setup`, { step: 'boss', name: 'Boss', slug: 'boss' });
  await request('PUT', `/api/companies/${id}/setup`, { step: 'department', name: 'Team', slug: 'team' });
  const bossId = state.rows(agents)[0]!.id;
  const same = await request('PUT', `/api/companies/${id}/setup`, {
    step: 'head',
    agentId: bossId,
    name: 'Head',
    slug: 'head',
  });
  assert.equal(same.statusCode, 400, same.body);
  assert.match(same.json().error, /distinct/);
  const runtimeId = randomUUID();
  state
    .rows(agentRuntimes)
    .push({ id: runtimeId, companyId: randomUUID(), adapterType: 'a2a', isActive: true });
  const runtime = await request('PUT', `/api/companies/${id}/setup`, { step: 'runtime', runtimeId });
  assert.equal(runtime.statusCode, 400, runtime.body);
  assert.equal(state.rows(agents)[0]!.runtimeId, null);
});

test('runtime metadata alone cannot finish; explicit non-executing probe persists results and config changes invalidate them', async (t) => {
  const { request, state } = await fixture(t);
  const created = await request('POST', '/api/company-setup', {
    setupKey: randomUUID(),
    name: 'Live check',
    slug: 'live-check',
  });
  const id = created.json().company.id;
  for (const payload of [
    { step: 'boss', name: 'Boss', slug: 'boss' },
    { step: 'department', name: 'Team', slug: 'team' },
    { step: 'head', name: 'Head', slug: 'head' },
    { step: 'runtime', name: 'A2A', a2aBaseUrl: 'https://runtime.example.test' },
  ]) {
    const saved = await request('PUT', `/api/companies/${id}/setup`, payload);
    assert.equal(saved.statusCode, 200, saved.body);
  }
  const untested = await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' });
  assert.equal(untested.statusCode, 409);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ name: 'Synthetic runtime', protocolVersion: '0.3.0' }), {
      status: 200,
    });
  });
  const probe = await request('POST', `/api/companies/${id}/setup/probe`);
  assert.ok(probe.json().results.every((result: any) => result.success));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.endsWith('/.well-known/agent-card.json')));
  const resumed = await request('GET', `/api/companies/${id}/setup`);
  assert.deepEqual(resumed.json().connectionIssues, []);
  const runtime = state.rows(agentRuntimes)[0]!;
  runtime.config = { a2aBaseUrl: 'https://changed.example.test' };
  assert.equal((await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' })).statusCode, 409);
  await request('POST', `/api/companies/${id}/setup/probe`);
  const finish = await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.equal(state.rows(companies)[0]!.autoDispatchEnabled, true);
});

test('setup start reports a taken company slug as a retryable field error with no partial draft', async (t) => {
  const { request, state } = await fixture(t);
  const original = db.insert.bind(db);
  t.mock.method(db, 'insert', ((table: any) =>
    table === companies
      ? {
          values: () => {
            throw Object.assign(new Error('unique violation'), { code: '23505' });
          },
        }
      : original(table)) as typeof db.insert);
  const result = await request('POST', '/api/company-setup', {
    setupKey: randomUUID(),
    name: 'Draft',
    slug: 'taken',
  });
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error, 'setup_slug_taken');
  assert.match(result.json().message, /different slug/);
  assert.equal(state.rows(companyMemberships).length, 0);
  assert.equal(state.rows(positions).length, 0);
});

async function minimum(request: Awaited<ReturnType<typeof fixture>>['request']) {
  const created = await request('POST', '/api/company-setup', { setupKey: randomUUID(), name: 'Repair', slug: 'repair' });
  const id = created.json().company.id;
  for (const payload of [{ step: 'boss', name: 'Boss', slug: 'boss' }, { step: 'department', name: 'Team', slug: 'team' }, { step: 'head', name: 'Head', slug: 'head' }]) {
    const saved = await request('PUT', `/api/companies/${id}/setup`, payload);
    assert.equal(saved.statusCode, 200, saved.body);
  }
  return id;
}

for (const adapterType of ['a2a', 'codex-app-server']) test(`Add A2A after selecting shared ${adapterType} preserves the selected runtime and retries exactly once`, async t => {
  const { request, state } = await fixture(t);
  const id = await minimum(request);
  const shared = { id: randomUUID(), companyId: id, name: 'Shared', adapterType, isActive: true, config: { a2aBaseUrl: 'https://shared.example.test', a2aBearerToken: 'synthetic-sentinel', custom: 'keep' }, localWorkspaceRoot: '/keep' };
  state.rows(agentRuntimes).push(shared);
  const other = { id: randomUUID(), companyId: id, name: 'Other', runtimeId: shared.id, adapterType, adapterConfig: { preserve: true } };
  state.rows(agents).push(other);
  const before = structuredClone({ shared, other });
  assert.equal((await request('PUT', `/api/companies/${id}/setup`, { step: 'runtime', runtimeId: shared.id })).statusCode, 200);
  const input = { step: 'runtime', runtimeCreateKey: randomUUID(), name: 'New A2A', a2aBaseUrl: 'https://new.example.test' };
  const first = await request('PUT', `/api/companies/${id}/setup`, input);
  assert.equal(first.statusCode, 200, first.body);
  const newId = first.json().draft.runtimeId;
  assert.notEqual(newId, shared.id);
  const again = await request('PUT', `/api/companies/${id}/setup`, input);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().draft.runtimeId, newId);
  assert.equal(state.rows(agentRuntimes).length, 2);
  assert.equal(state.rows(agentRuntimes).find(r => r.id === newId)?.adapterType, 'a2a');
  assert.deepEqual({ shared, other }, before);
  const altered = await request('PUT', `/api/companies/${id}/setup`, { ...input, a2aBaseUrl: 'https://different.example.test' });
  assert.equal(altered.statusCode, 409, altered.body);
});

for (const broken of ['runtime', 'head']) test(`completed setup can explicitly reopen and repair ${broken} with the same entities`, async t => {
  const { request, state } = await fixture(t);
  const id = await minimum(request);
  await request('PUT', `/api/companies/${id}/setup`, { step: 'runtime', name: 'A2A', a2aBaseUrl: 'https://runtime.example.test' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ name: 'Synthetic endpoint' })));
  await request('POST', `/api/companies/${id}/setup/probe`);
  assert.equal((await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' })).statusCode, 200);
  const company = state.rows(companies)[0]!;
  const ids = state.rows(agents).map(a => a.id);
  const runtime = state.rows(agentRuntimes)[0]!;
  const department = state.rows(departments)[0]!;
  if (broken === 'runtime') runtime.isActive = false;
  else department.headAgentId = null;
  const snapshot = structuredClone(company);
  const status = await request('GET', `/api/companies/${id}/setup`);
  assert.equal(status.json().status, 'needs_attention');
  assert.deepEqual(company, snapshot, 'GET must not pause dispatch or mutate draft');
  const reopen = await request('PUT', `/api/companies/${id}/setup`, { step: 'reopen' });
  assert.equal(reopen.statusCode, 200, reopen.body);
  assert.equal(company.autoDispatchEnabled, false);
  assert.equal(company.setupDraft.completed, false);
  runtime.isActive = true;
  const fixed = await request('PUT', `/api/companies/${id}/setup`, { step: 'head', name: 'Head', slug: 'head' });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal((await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' })).statusCode, 409, 'reopen requires new checks');
  await request('POST', `/api/companies/${id}/setup/probe`);
  assert.equal((await request('PUT', `/api/companies/${id}/setup`, { step: 'finish' })).statusCode, 200);
  assert.deepEqual(state.rows(agents).map(a => a.id), ids);
  assert.equal(state.rows(departments).length, 1);
  assert.equal(state.rows(agentRuntimes).length, 1);
  assert.equal((await request('GET', `/api/companies/${id}/setup`)).json().status, 'ready');
  company.autoDispatchEnabled = false;
  assert.equal((await request('GET', `/api/companies/${id}/setup`)).json().status, 'dispatch_disabled');
});
