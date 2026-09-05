import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { companies, companyMemberships, projects, users } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';
import { dispatchCard } from './dispatch.ts';

test('managed setup defaults protect new repo, opt-out remains read-only, failed draft blocks dispatch and explicit save retries setup', async (t) => {
  const company = { id: randomUUID(), name: 'Fixture', slug: 'org' }, user = { id: randomUUID(), email: 'operator@example.test', role: 'admin' };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'admin', status: 'active' }]]]);
  const old = process.env.GITEA_URL, token = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = old; if (token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = token; });
  let offline = false, writes = 0;
  const rules = new Map<string, any[]>();
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/version') && offline) throw new Error('offline');
    if (init?.method === 'POST' && path.endsWith('/branch_protections')) { writes++; rules.set(path, [...rules.get(path) ?? [], { ...JSON.parse(String(init.body)), created_at: new Date().toISOString() }]); }
    const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: 'admin' } : path.endsWith('/collaborators') || path.endsWith('/hooks') ? [] : path.endsWith('/branch_protections') ? rules.get(path) ?? [] : { default_branch: 'main' };
    return new Response(JSON.stringify(value));
  });
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const create = async (name: string, values: object = {}) => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { companyId: company.id, name, repoProvider: 'gitea-local', ...values } });
    assert.equal(response.statusCode, 201, response.body); return response.json();
  };
  const ready = await create('ready');
  assert.equal(ready.autoMergeAfterApproval, true); assert.equal(ready.mergeReadiness.ready, true); assert.equal(writes, 2);
  const optout = await create('optout', { autoMergeAfterApproval: false });
  assert.equal(optout.autoMergeAfterApproval, false); assert.equal(writes, 2);
  const unconfigured = await create('external', { repoProvider: 'gitea-local', repoUrl: 'https://foreign.test/org/repo', autoMergeAfterApproval: true });
  assert.equal(unconfigured.mergeReadiness.ready, false); assert.equal(writes, 2);
  const before = JSON.stringify(state.rows(projects));
  await app.inject({ method: 'GET', url: `/api/projects/${optout.id}/merge-readiness`, headers });
  await app.inject({ method: 'GET', url: '/api/projects', headers });
  assert.equal(JSON.stringify(state.rows(projects)), before); assert.equal(writes, 2);
  offline = true;
  const draft = await create('retry');
  assert.equal(draft.mergeReadiness.ready, false); assert.equal(draft.autoMergeAfterApproval, true);
  const { kanbanCards } = await import('./db/schema.ts');
  const card = { id: randomUUID(), companyId: company.id, projectId: draft.id, columnStatus: 'todo' };
  state.rows(kanbanCards).push(card);
  await assert.rejects(dispatchCard(card.id), /managed_merge_unready/);
  offline = false;
  const retried = await app.inject({ method: 'PUT', url: `/api/projects/${draft.id}`, headers, payload: { autoMergeAfterApproval: true } });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().mergeReadiness.ready, true, 'explicit retry of failed setup establishes absent protection');
});
