import assert from 'node:assert/strict';
import test from 'node:test';
import * as provider from './gitea.ts';

const config = { apiUrl: 'https://gitea.test', internalUrl: 'https://gitea.test', externalUrl: 'https://gitea.test', adminToken: 'synthetic-service-secret' };
const safe = { rule_name: 'main', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [], unprotected_file_patterns: '' };
function fake(rules: any[] = [], overrides: Record<string, any> = {}) {
  const requests: Array<{ path: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (method === 'POST' && path.endsWith('branch_protections')) rules.push(body);
    const result = overrides[path] ?? (path === '/version' ? { version: '1.22.6' } : path === '/user' ? { login: 'service' } : path.endsWith('/collaborators') ? [{ login: 'agent', is_admin: false }] : path.endsWith('/collaborators/service/permission') ? { permission: 'admin' } : path.endsWith('/permission') ? { permission: 'write', user: { is_admin: false } } : path.endsWith('/branch_protections') ? rules : { default_branch: 'main', owner: { login: 'org' } });
    return new Response(JSON.stringify(result));
  };
  return { requests, fetchImpl };
}
test('immediate exact-head Gitea 1.22 merge never schedules, forces, deletes or manually marks merged', async () => {
  assert.equal(typeof (provider as any).giteaMergePullRequest, 'function');
  const { requests, fetchImpl } = fake();
  await (provider as any).giteaMergePullRequest(config, 'org', 'repo', 12, 'a'.repeat(40), fetchImpl);
  assert.deepEqual(requests[0], { path: '/repos/org/repo/pulls/12/merge', method: 'POST', body: { Do: 'merge', head_commit_id: 'a'.repeat(40), force_merge: false, merge_when_checks_succeed: false, delete_branch_after_merge: false } });
});
test('explicit establish denies direct push and grants merge only to verified service, then reads back', async () => {
  assert.equal(typeof (provider as any).giteaManagedReadiness, 'function');
  const { requests, fetchImpl } = fake();
  const result = await (provider as any).giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl });
  assert.equal(result.ready, true);
  assert.deepEqual(requests.find((r) => r.method === 'POST')?.body, safe);
  assert.equal(requests.filter((r) => r.path.endsWith('branch_protections') && r.method === 'GET').length, 2);
});
test('readiness inspection is read-only and existing stronger/unknown policies are never overwritten', async () => {
  assert.equal(typeof (provider as any).giteaManagedReadiness, 'function');
  for (const rules of [[], [{ ...safe, required_approvals: 2, unknown_future_rule: true }], [{ ...safe, unprotected_file_patterns: '*.md' }], [{ ...safe, merge_whitelist_usernames: [] }]]) {
    const { requests, fetchImpl } = fake(rules);
    const result = await (provider as any).giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl });
    assert.equal(result.ready, rules.length === 1 && (rules[0] as any)?.required_approvals === 2);
    assert.ok(requests.every((r) => r.method === 'GET'));
  }
});
test('unsafe existing rules, admin agents, dropped allowlist and unsupported/provider failures are unready', async () => {
  assert.equal(typeof (provider as any).giteaManagedReadiness, 'function');
  for (const overrides of [{ '/version': { version: '1.21.0' } }, { '/repos/org/repo/collaborators': [{ login: 'agent', is_admin: true }] }, { '/repos/org/repo/branch_protections': [{ ...safe, merge_whitelist_usernames: [] }] }]) {
    const { requests, fetchImpl } = fake([], overrides);
    assert.equal((await (provider as any).giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl })).ready, false);
    assert.ok(requests.every((r) => r.method === 'GET'));
  }
  assert.equal((await (provider as any).giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl: async () => { throw new Error('offline'); } })).ready, false);
});
test('protection read-back detects service identity silently dropped by Gitea', async () => {
  const base = fake(); let reads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/branch_protections') && (!init?.method || init.method === 'GET')) {
      reads++;
      return new Response(JSON.stringify(reads === 1 ? [] : [{ ...safe, merge_whitelist_usernames: [] }]));
    }
    return base.fetchImpl(url, init);
  };
  const result = await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl });
  assert.equal(result.ready, false); assert.equal(reads, 2); assert.equal(base.requests.filter((r) => r.method === 'POST').length, 1);
});
test('pagination and inherited effective agent privileges cannot hide an ordinary admin', async () => {
  const base = fake([safe]); let pages = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/collaborators')) {
      pages++; return new Response(JSON.stringify(pages === 1 ? Array.from({ length: 50 }, (_, i) => ({ login: `agent${i}`, is_admin: false })) : [{ login: 'hidden-admin', is_admin: true }]));
    }
    return base.fetchImpl(url, init);
  };
  assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl })).ready, false);
  assert.equal(pages, 2);
  const inherited = fake([safe], { '/repos/org/repo/collaborators/inherited/permission': { permission: 'admin', user: { is_admin: false } } });
  assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { agentUsernames: ['inherited'], fetchImpl: inherited.fetchImpl })).ready, false);
  assert.ok(inherited.requests.every((r) => r.method === 'GET'));
});
