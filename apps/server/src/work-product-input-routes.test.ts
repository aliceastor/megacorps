import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { companies, companyMemberships, kanbanCards, projects, users, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';
import { planMergeGate, selectMergeCandidate } from './merge-gate.ts';

const head = 'a'.repeat(40);
const repo = 'https://gitea.test/org/repo';

async function fixture(t: any, repoUrl = repo) {
  const companyId = randomUUID(), projectId = randomUUID();
  const user = { id: randomUUID(), email: 'operator@example.test', role: 'operator', status: 'active' };
  const project = { id: projectId, companyId, repoUrl, defaultBranch: 'main', completionRequiresMerge: true };
  const card = { id: randomUUID(), companyId, projectId, assigneeId: null, title: 'Deliver change', columnStatus: 'in_review' };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Alpha' }]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId, role: 'operator', status: 'active' }]], [projects, [project]], [kanbanCards, [card]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  return { state, project, card, post: (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/cards/${card.id}/work-products`, headers, payload: { title: 'Delivered change', type: 'commit', ...payload } }) };
}

for (const [name, repository, commitPath] of [
  ['Gitea', repo, '/commit/'],
  ['GitHub', 'https://github.test/org/repo', '/commit/'],
  ['GitLab', 'https://gitlab.test/group/subgroup/repo', '/-/commit/'],
] as const) test(`one ${name} full-SHA URL POST persists canonical evidence usable by the existing candidate selector`, async t => {
  const f = await fixture(t, repository);
  const url = `${repository}${commitPath}${head}?view=parallel#diff`;
  const response = await f.post({ url });
  assert.equal(response.statusCode, 201, response.body);
  const stored = f.state.rows(workProducts)[0]!;
  assert.equal(stored.repoUrl, repository);
  assert.equal(stored.commitSha, head);
  assert.equal(stored.branch, null);
  assert.equal(stored.repoProvider, null);
  assert.deepEqual(stored.metadata, {});
  assert.equal(stored.url, url);
  assert.deepEqual(selectMergeCandidate([stored], f.project), { kind: 'branch', pullRequestUrl: null, pullRequestNumber: null, branch: null, headSha: head, workProductId: stored.id });
});

for (const [name, payload] of [
  ['foreign origin', { url: `https://foreign.test/org/repo/commit/${head}` }],
  ['foreign repository', { url: `https://gitea.test/org/other/commit/${head}` }],
  ['inconsistent explicit repository', { url: `${repo}/commit/${head}`, repoUrl: 'https://gitea.test/org/other' }],
  ['inconsistent explicit SHA', { url: `${repo}/commit/${head}`, commitSha: 'b'.repeat(40) }],
] as const) test(`POST rejects ${name} before storing commit evidence`, async t => {
  const f = await fixture(t);
  const response = await f.post(payload);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'work_product_commit_identity_mismatch');
  assert.equal(f.state.rows(workProducts).length, 0);
});

test('consistent explicit Advanced fields survive commit normalization', async t => {
  const f = await fixture(t);
  const explicit = { url: `${repo}/commit/${head}`, repoUrl: `${repo}.git`, commitSha: head.toUpperCase(), branch: 'feature/reports', repoProvider: 'gitea-local', summary: 'Reviewed separately', metadata: { note: 'human supplied' } };
  const response = await f.post(explicit);
  assert.equal(response.statusCode, 201, response.body);
  const stored = f.state.rows(workProducts)[0]!;
  for (const [key, value] of Object.entries(explicit)) assert.deepEqual(stored[key], value);
});

test('short, malformed, and unrelated external URLs do not invent canonical metadata', async t => {
  const f = await fixture(t);
  for (const url of [`${repo}/commit/abcdef1`, `${repo}/commit/${'a'.repeat(64)}`, `${repo}/commit/${head}/files`, `${repo}/commit/not-a-sha`, `ftp://gitea.test/org/repo/commit/${head}`, 'https://docs.foreign.test/manual', `https://gitea.test/repo/commit/${head}`, `https://gitea.test/org%2frepo/commit/${head}`]) {
    const response = await f.post({ url });
    assert.equal(response.statusCode, 201, response.body);
    const stored = response.json();
    assert.equal(stored.commitSha, null); assert.equal(stored.repoUrl, null);
    assert.equal(selectMergeCandidate([stored], f.project), null);
  }
  const docs = await f.post({ type: 'external', url: `https://foreign.test/org/repo/commit/${head}` });
  assert.equal(docs.statusCode, 201, docs.body); assert.equal(docs.json().repoUrl, null);
});

test('nested GitLab repository identity cannot alias another repository in the same group', async t => {
  const f = await fixture(t, 'https://gitlab.test/group/subgroup/repo');
  const response = await f.post({ url: `https://gitlab.test/group/subgroup/other/-/commit/${head}` });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(f.state.rows(workProducts).length, 0);
});

test('configured provider aliases remain compatible and a stored SHA still requires provider verification', async t => {
  const aliases = { GITEA_URL: 'https://gitea.test', GITEA_EXTERNAL_URL: 'https://public-gitea.test', GITEA_ADMIN_TOKEN: 'test-only-sentinel' };
  const previous = Object.fromEntries(Object.keys(aliases).map(key => [key, process.env[key]]));
  Object.assign(process.env, aliases);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = await fixture(t);
  const response = await f.post({ url: `https://public-gitea.test/org/repo/commit/${head}` });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(selectMergeCandidate(f.state.rows(workProducts), f.project)?.headSha, head);
  for (const scenario of ['offline', 'drift', 'verified'] as const) {
    let calls = 0;
    const plan = await planMergeGate(f.card as any, { fetchImpl: async () => {
      calls++;
      if (scenario === 'offline') throw new Error('synthetic provider offline');
      return new Response(JSON.stringify({ sha: scenario === 'drift' ? 'b'.repeat(40) : head }), { status: 200 });
    } });
    assert.ok(calls > 0, 'canonical URL metadata never bypasses provider verification');
    assert.equal(plan.disposition, scenario === 'verified' ? 'wait' : 'blocked');
    if (plan.disposition === 'blocked') assert.equal(plan.reason, scenario === 'offline' ? 'provider_unavailable' : 'head_drift');
  }
  assert.equal(f.card.columnStatus, 'in_review');
});
