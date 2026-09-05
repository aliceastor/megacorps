import assert from 'node:assert/strict';
import test from 'node:test';
import { giteaWorkerWriteReadiness } from './gitea.ts';
test('worker write readiness distinguishes protected read-only identities from capable workers without provider writes', async () => {
  const requests: string[] = [];
  let push = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(init?.method ?? 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'token synthetic-worker-token');
    return new Response(JSON.stringify(String(input).endsWith('/user') ? { login: 'worker', is_admin: false } : { permissions: { push, admin: false }, owner: { login: 'company' } }), { status: 200 });
  };
  const config = { apiUrl: 'https://gitea.test', internalUrl: 'https://gitea.test', externalUrl: 'https://gitea.test', adminToken: 'synthetic-server-token' };
  const identity = { username: 'worker', token: 'synthetic-worker-token' };
  assert.equal((await giteaWorkerWriteReadiness(config, 'company', 'repo', identity, fetchImpl)).ready, false);
  push = true;
  assert.equal((await giteaWorkerWriteReadiness(config, 'company', 'repo', identity, fetchImpl)).ready, true);
  assert.deepEqual(requests, ['GET', 'GET', 'GET', 'GET']);
});
