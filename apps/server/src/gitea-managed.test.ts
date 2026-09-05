import assert from 'node:assert/strict';
import test from 'node:test';
import * as provider from './gitea.ts';

const config = { apiUrl: 'https://gitea.test', internalUrl: 'https://gitea.test', externalUrl: 'https://gitea.test', adminToken: 'synthetic-service-secret' };
const safe = { rule_name: '[m]ain', created_at: '2026-09-05T00:00:00Z', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [], unprotected_file_patterns: '' };
const fallback = { rule_name: '**', created_at: '2026-09-05T00:00:02Z', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [], unprotected_file_patterns: '', protected_file_patterns: '' };
function fake(rules: any[] = [], overrides: Record<string, any> = {}) {
  const requests: Array<{ path: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (method === 'POST' && path.endsWith('branch_protections')) rules.push({ ...body, created_at: new Date().toISOString() });
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
  assert.deepEqual(requests.filter((r) => r.method === 'POST').map((r) => r.body), [safe, fallback].map(({ created_at, ...body }) => body));
  assert.equal(requests.filter((r) => r.path.endsWith('branch_protections') && r.method === 'GET').length, 2);
});
test('readiness inspection is read-only and existing stronger/unknown policies are never overwritten', async () => {
  assert.equal(typeof (provider as any).giteaManagedReadiness, 'function');
  for (const rules of [[], [{ ...safe, required_approvals: 2, unknown_future_rule: true }, fallback], [{ ...safe, unprotected_file_patterns: '*.md' }, fallback], [{ ...safe, merge_whitelist_usernames: [] }, fallback]]) {
    const { requests, fetchImpl } = fake(rules);
    const result = await (provider as any).giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl });
    assert.equal(result.ready, rules.length === 2 && (rules[0] as any)?.required_approvals === 2);
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
  assert.equal(result.ready, false); assert.equal(reads, 2); assert.equal(base.requests.filter((r) => r.method === 'POST').length, 2);
});

test('readback rejects a missing fallback or silently disabled empty merge whitelist', async () => {
  for (const readback of [[safe], [safe, { ...fallback, enable_merge_whitelist: false }]]) {
    const base = fake(); let reads = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/branch_protections') && (!init?.method || init.method === 'GET')) return new Response(JSON.stringify(++reads === 1 ? [] : readback));
      return base.fetchImpl(url, init);
    };
    assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl })).ready, false);
    assert.equal(reads, 2); assert.equal(base.requests.filter((request) => request.method === 'POST').length, 2);
  }
});
test('pagination and inherited effective agent privileges cannot hide an ordinary admin', async () => {
  const base = fake([safe, fallback]); let pages = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/collaborators')) {
      pages++; return new Response(JSON.stringify(pages === 1 ? Array.from({ length: 50 }, (_, i) => ({ login: `agent${i}`, is_admin: false })) : [{ login: 'hidden-admin', is_admin: true }]));
    }
    return base.fetchImpl(url, init);
  };
  assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl })).ready, false);
  assert.equal(pages, 2);
  const inherited = fake([safe, fallback], { '/repos/org/repo/collaborators/inherited/permission': { permission: 'admin', user: { is_admin: false } } });
  assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { agentUsernames: ['inherited'], fetchImpl: inherited.fetchImpl })).ready, false);
  assert.ok(inherited.requests.every((r) => r.method === 'GET'));
});
test('explicit opt-in adds only missing fallback while preserving stronger exact rules', async () => {
  const stronger = { ...safe, required_approvals: 3, enable_status_check: true, status_check_contexts: ['required/ci'], unknown_future_rule: true };
  const fixture = fake([stronger]);
  const result = await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl: fixture.fetchImpl });
  assert.equal(result.ready, true);
  assert.deepEqual(fixture.requests.filter((r) => r.method !== 'GET').map((r) => r.body), [(({ created_at, ...body }) => body)(fallback)]);
  assert.equal(stronger.required_approvals, 3);
});

test('special glob characters in a default branch cannot establish an ambiguous allow rule', async () => {
  const fixture = fake([], { '/repos/org/repo': { default_branch: 'main{alt}' } });
  assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main{alt}', { establish: true, fetchImpl: fixture.fetchImpl })).ready, false);
  assert.ok(fixture.requests.every((request) => request.method === 'GET'));
});

test('literal allow glob must have a valid strictly older provider-second timestamp than fallback', async () => {
  for (const rules of [
    [safe, fallback],
    [{ ...safe, created_at: fallback.created_at }, fallback],
    [{ ...safe, created_at: '2026-09-05T00:00:02.100Z' }, { ...fallback, created_at: '2026-09-05T00:00:02.900Z' }],
    [{ ...safe, created_at: '2026-09-05T00:00:03Z' }, fallback],
    [{ ...safe, created_at: undefined }, fallback],
    [safe, { ...fallback, created_at: 'invalid' }],
    [{ ...safe, rule_name: 'main' }, fallback],
    [fallback],
  ]) {
    const fixture = fake(rules);
    const result = await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl: fixture.fetchImpl });
    assert.equal(result.ready, rules[0] === safe && rules[1] === fallback);
    assert.ok(fixture.requests.every((request) => request.method === 'GET'));
  }
});
test('fallback excludes service and ordinary mergers, covers nested branches, and rejects unsafe shadow rules without writes', async () => {
  for (const rules of [[safe], [safe, { ...fallback, merge_whitelist_usernames: ['service'] }], [safe, fallback, { ...safe, rule_name: 'feature/nested' }], [safe, fallback, { ...fallback, rule_name: 'feature/*' }], [safe, { ...fallback, enable_push: false }]]) {
    const fixture = fake(rules);
    const result = await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl: fixture.fetchImpl });
    assert.equal(result.ready, false);
    assert.ok(fixture.requests.every((r) => r.method === 'GET'));
  }
  for (const rule of [{ ...safe, rule_name: 'feature/nested' }, { ...fallback, rule_name: 'feature/*' }]) {
    const fixture = fake([safe, fallback, rule]);
    assert.equal((await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { establish: true, fetchImpl: fixture.fetchImpl })).ready, false);
    assert.ok(fixture.requests.every((request) => request.method === 'GET'));
  }
  // Pinned Gitea exact-before-glob and ** nested matching are modeled here.
  const fixture = fake([fallback, safe]);
  const result = await provider.giteaManagedReadiness(config, 'org', 'repo', 'main', { fetchImpl: fixture.fetchImpl });
  assert.equal(result.ready, true);
  for (const branch of ['feature', 'feature/deep/nested']) {
    const effective = branch === 'main' ? safe : fallback;
    assert.equal(effective.enable_push, true);
    assert.equal(effective.enable_merge_whitelist, true);
    assert.equal(effective.merge_whitelist_usernames.includes('service'), false);
  }
});
