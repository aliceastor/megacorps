import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { db } from './db/client.ts';
import { agents, appSettings, companies, projects } from './db/schema.ts';
import { reconcileGiteaProvisioning } from './bootstrap-provisioning.ts';

type Call = { method: string; path: string; body?: unknown };

const project = {
  id: 'project-1',
  companyId: 'company-1',
  name: 'Renamed Project',
  repoProvider: 'gitea-local',
  repoUrl: 'http://gitea.example/stored-org/original-repo.git',
  defaultBranch: 'main',
};
const company = { id: 'company-1', name: 'Renamed Company', slug: 'renamed-company' };
const agent = { id: 'agent-1', companyId: 'company-1', name: 'Alice', slug: 'alice', giteaUsername: 'agent-alice', giteaToken: 'token' };

function response(status: number, json: unknown = null): Response {
  return new Response(json === null ? null : JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockDatabase(): void {
  mock.method(db, 'select', ((selection?: Record<string, unknown>) => ({
    from(table: unknown) {
      if (table === agents && selection?.value === undefined) {
        const rows = selection?.giteaUsername ? [{ giteaUsername: agent.giteaUsername }] : [agent];
        return { where: () => selection?.giteaUsername ? { limit: () => rows } : rows };
      }
      if (table === projects) return { where: () => [project] };
      if (table === companies) return { where: () => ({ limit: () => [company] }) };
      if (table === appSettings) return { where: () => ({ limit: () => [{ value: 'webhook-token' }] }) };
      throw new Error('unexpected select');
    },
  })) as unknown as typeof db.select);
}

beforeEach(() => {
  process.env.GITEA_URL = 'http://gitea.example';
  process.env.GITEA_ADMIN_TOKEN = 'admin-token';
  process.env.INTERNAL_API_URL = 'http://megacorps:4000';
  mockDatabase();
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.GITEA_URL;
  delete process.env.GITEA_ADMIN_TOKEN;
  delete process.env.INTERNAL_API_URL;
});

test('reconciles the exact stored repo after project and company renames', async () => {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET' && url.pathname === '/api/v1/repos/stored-org/original-repo') return response(404);
    if (method === 'GET' && url.pathname === '/api/v1/orgs/stored-org') return response(404);
    if (method === 'GET' && url.pathname.endsWith('/hooks')) return response(200, []);
    return response(method === 'GET' ? 200 : method === 'POST' ? 201 : 204);
  }) as typeof fetch);

  await reconcileGiteaProvisioning({ log: { info() {}, warn() {} } } as never);

  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/api/v1/orgs' && (call.body as { username?: string }).username === 'stored-org'));
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/api/v1/orgs/stored-org/repos' && (call.body as { name?: string }).name === 'original-repo'));
  assert.ok(calls.some((call) => call.method === 'PUT' && call.path === '/api/v1/repos/stored-org/original-repo/collaborators/agent-alice'));
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/api/v1/repos/stored-org/original-repo/hooks'));
  assert.ok(calls.findIndex((call) => call.path === '/api/v1/orgs') < calls.findIndex((call) => call.path === '/api/v1/orgs/stored-org/repos'));
  assert.equal(calls.some((call) => call.path.includes('renamed-company') || call.path.includes('renamed-project')), false);
});

test('an existing stored repo skips organization and repository creation', async () => {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (method === 'GET' && path.endsWith('/hooks')) return response(200, []);
    return response(method === 'GET' ? 200 : 204);
  }) as typeof fetch);

  await reconcileGiteaProvisioning({ log: { info() {}, warn() {} } } as never);

  assert.ok(calls.some((call) => call.method === 'GET' && call.path === '/api/v1/repos/stored-org/original-repo'));
  assert.equal(calls.some((call) => call.method === 'POST' && (call.path === '/api/v1/orgs' || call.path.endsWith('/repos'))), false);
});

test('a non-404 stored repo failure propagates without provisioning', async () => {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    return response(503, { message: 'unavailable' });
  }) as typeof fetch);

  await assert.rejects(
    reconcileGiteaProvisioning({ log: { info() {}, warn() {} } } as never),
    /gitea_http_503/,
  );
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/v1/repos/stored-org/original-repo' }]);
});
