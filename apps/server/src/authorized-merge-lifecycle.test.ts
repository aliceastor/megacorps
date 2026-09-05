import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryDb } from './test-support/memory-db.ts';
import { externalEvents, externalWaits, kanbanCards, mergeIntents, projects, taskRuns, workProducts } from './db/schema.ts';
import { parkForMerge, reconcileMergeWait, type MergeGatePlan } from './merge-gate.ts';
import { dispatchInternals, reviewCard } from './dispatch.ts';
import { executeAuthorizedMerge } from './authorized-merge.ts';

const head = 'a'.repeat(40);
function fixture(t: TestContext) {
  const previous = { url: process.env.GITEA_URL, token: process.env.GITEA_ADMIN_TOKEN };
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-service-secret';
  t.after(() => { if (previous.url === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = previous.url; if (previous.token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = previous.token; });
  const project: any = { id: randomUUID(), companyId: randomUUID(), name: 'Managed', repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo', managedRepoFullName: 'org/repo', defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: true };
  const card: any = { id: randomUUID(), companyId: project.companyId, projectId: project.id, title: 'Reviewed deliverable', body: 'Evidence', columnStatus: 'in_review', mergeGateVersion: 0, assigneeId: null, reviewerId: null, requiresApproval: false, dependencyCardIds: [] };
  const state = memoryDb(t, [[projects, [project]], [kanbanCards, [card]], [workProducts, [{ id: 'work', cardId: card.id, projectId: project.id, type: 'pull_request', pullRequestUrl: 'https://gitea.test/org/repo/pulls/12', commitSha: head }]]]);
  const plan: Extract<MergeGatePlan, { disposition: 'wait' }> = { disposition: 'wait', project, candidate: { kind: 'pull_request', pullRequestNumber: 12, pullRequestUrl: 'https://gitea.test/org/repo/pulls/12', branch: 'feature', headSha: head, workProductId: 'work' }, headSha: head, defaultBranch: 'main', waitingFor: 'merge into main', externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12' };
  let posts = 0, merged = false, observedHead = head;
  let post: () => Promise<Response> = async () => { merged = true; return new Response(null, { status: 204 }); };
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') {
      posts++; const body = JSON.parse(String(init.body));
      assert.deepEqual(body, { Do: 'merge', head_commit_id: head, force_merge: false, merge_when_checks_succeed: false, delete_branch_after_merge: false });
      return post();
    }
    const result = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: 'admin' } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [{ rule_name: 'main', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] }] : path.endsWith('/pulls/12') ? { number: 12, state: merged ? 'closed' : 'open', merged, head: { sha: observedHead }, base: { ref: 'main' } } : { default_branch: 'main' };
    return new Response(JSON.stringify(result));
  };
  t.mock.method(globalThis, 'fetch', fetchImpl);
  return { project, card, state, plan, fetchImpl, posts: () => posts, setPost: (fn: typeof post) => { post = fn; }, merge: () => { merged = true; }, drift: () => { observedHead = 'b'.repeat(40); } };
}
test('normal review entrypoint settles its original run after automatic merge and never injects service secrets', async (t) => {
  const f = fixture(t);
  const run: any = { id: randomUUID(), cardId: f.card.id, companyId: f.card.companyId, kind: 'review', status: 'running' };
  f.state.rows(taskRuns).push(run);
  await reviewCard(f.card.id, { taskRunId: run.id });
  assert.equal(f.posts(), 1); assert.equal(run.status, 'success'); assert.equal(f.card.columnStatus, 'done');
  assert.equal(f.state.rows(mergeIntents)[0]?.state, 'verified');
  const prompt = dispatchInternals.projectGitProtocol(null, f.project, f.card, { slug: 'ordinary' } as any);
  assert.match(prompt, /MegaCorps performs the authorized merge/);
  assert.doesNotMatch(prompt, /synthetic-service-secret|GITEA_ADMIN_TOKEN/);
});
test('ambiguous accepted request is reconciled from the same intent, without a second POST', async (t) => {
  const f = fixture(t);
  f.setPost(async () => { f.merge(); throw new Error('response lost after acceptance'); });
  await parkForMerge(f.card, f.plan, { fetchImpl: f.fetchImpl });
  assert.equal(f.card.columnStatus, 'done'); assert.equal(f.posts(), 1);
  assert.equal(f.state.rows(mergeIntents)[0]?.state, 'verified');
  assert.equal(f.state.rows(externalEvents).filter((event) => event.status === 'success').length, 1);
});
test('head pushed between read and POST is rejected with 409 and reopens review without adopting new SHA', async (t) => {
  const f = fixture(t);
  f.setPost(async () => { f.drift(); return new Response('{}', { status: 409 }); });
  await parkForMerge(f.card, f.plan, { fetchImpl: f.fetchImpl });
  assert.equal(f.posts(), 1); assert.equal(f.card.columnStatus, 'in_review');
  assert.equal(f.state.rows(mergeIntents)[0]?.headSha, head); assert.equal(f.state.rows(mergeIntents)[0]?.state, 'drift');
});
for (const status of [405, 422]) test(`provider ${status} remains pending with bounded retries of one durable intent`, async (t) => {
  const f = fixture(t); f.setPost(async () => new Response('{}', { status }));
  await parkForMerge(f.card, f.plan, { fetchImpl: f.fetchImpl });
  const intent = f.state.rows(mergeIntents)[0]!, wait = f.state.rows(externalWaits)[0]!;
  assert.equal(f.card.columnStatus, 'waiting_on_external');
  assert.equal(await executeAuthorizedMerge(wait.id, { fetchImpl: f.fetchImpl }), false);
  for (let i = 0; i < 4; i++) { intent.lastAttemptAt = new Date(0); wait.lastPolledAt = new Date(0); await reconcileMergeWait(wait.id, { fetchImpl: f.fetchImpl }); }
  assert.equal(f.posts(), 3); assert.equal(intent.attemptCount, 3); assert.equal(f.state.rows(mergeIntents).length, 1); assert.equal(intent.headSha, head);
});
for (const change of ['cancel', 'delete', 'head', 'gate_version', 'wait', 'foreign', 'disabled'] as const) test(`${change} before claim cannot initiate provider mutation`, async (t) => {
  const f = fixture(t);
  const real = f.fetchImpl;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/user')) {
      if (change === 'cancel') f.card.columnStatus = 'cancelled';
      if (change === 'delete') f.card.deletedAt = new Date();
      if (change === 'head') f.drift();
      if (change === 'gate_version') f.card.mergeGateVersion++;
      if (change === 'wait') f.state.rows(externalWaits)[0]!.status = 'superseded';
      if (change === 'foreign') f.project.repoUrl = 'https://foreign.test/org/repo';
      if (change === 'disabled') f.project.autoMergeAfterApproval = false;
    }
    return real(url, init);
  };
  await parkForMerge(f.card, f.plan, { fetchImpl });
  assert.equal(f.posts(), 0);
});
