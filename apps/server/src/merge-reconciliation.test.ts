import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { externalEvents, externalWaits, kanbanCards, projects, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { handleGiteaWebhookEvent, parkForMerge, reconcileMergeWait, type MergeGatePlan } from './merge-gate.ts';
import { sweepExternalWaitPolls } from './external-events.ts';

const head = 'a'.repeat(40);
function fixture(t: TestContext) {
  const oldUrl = process.env.GITEA_URL, oldToken = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-provider-token';
  t.after(() => { if (oldUrl === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = oldUrl; if (oldToken === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = oldToken; });
  const card: any = { id: 'card', companyId: 'company', projectId: 'project', columnStatus: 'in_review', parentCardId: null, reviewerId: null };
  const project: any = { id: 'project', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main', completionRequiresMerge: true };
  const state = memoryDb(t, [[kanbanCards, [card]], [projects, [project]]]);
  const plan: Extract<MergeGatePlan, { disposition: 'wait' }> = { disposition: 'wait', project, candidate: { kind: 'pull_request', pullRequestUrl: 'https://gitea.test/org/repo/pulls/12', pullRequestNumber: 12, branch: 'feature', headSha: head, workProductId: 'wp' }, headSha: head, defaultBranch: 'main', waitingFor: 'merge into main', externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12' };
  const pull = { number: 12, state: 'closed', merged: true, head: { sha: head }, base: { ref: 'main' } };
  const payload = { action: 'closed', pull_request: pull, repository: { full_name: 'org/repo' } };
  return { card, project, state, plan, pull, payload };
}

test('event before wait is reconciled from current provider state immediately after park', async (t) => {
  const { card, state, plan, pull, payload } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pull)));
  await handleGiteaWebhookEvent({ eventName: 'pull_request', payload });
  assert.equal(card.columnStatus, 'in_review');
  await parkForMerge(card, plan);
  assert.equal(card.columnStatus, 'done');
  assert.equal(state.rows(externalWaits)[0]?.authorizedHeadSha, head);
  assert.equal(state.rows(externalWaits)[0]?.status, 'success');
});

test('repeat parking and duplicate merged event cannot create another wait or completion', async (t) => {
  const { card, state, plan, pull, payload } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...pull, state: 'open', merged: false })));
  await Promise.all([parkForMerge(card, plan), parkForMerge(card, plan)]);
  assert.equal(state.rows(externalWaits).length, 1);
  await Promise.all([handleGiteaWebhookEvent({ eventName: 'pull_request', payload }), handleGiteaWebhookEvent({ eventName: 'pull_request', payload })]);
  assert.equal(card.columnStatus, 'done');
  assert.equal(state.rows(externalEvents).filter((event) => event.status === 'success').length, 1);
  await parkForMerge(card, plan);
  assert.equal(card.columnStatus, 'done');
});

test('merge sweep stays server-side, persists its budget, and never treats provider failure as done', async (t) => {
  const { card, state, plan } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await parkForMerge(card, plan);
  const wait = state.rows(externalWaits)[0]!;
  assert.equal(wait.pollCount, 1);
  assert.equal(card.columnStatus, 'waiting_on_external');
  const app: any = { log: { info() {}, warn() {} } };
  await sweepExternalWaitPolls(app);
  assert.equal(wait.pollCount, 1, 'minimum 30-second backoff survives a new sweep');
  wait.pollCount = 23; wait.lastPolledAt = new Date(0);
  await sweepExternalWaitPolls(app);
  assert.equal(wait.pollCount, 24);
  wait.lastPolledAt = new Date(0); await sweepExternalWaitPolls(app);
  assert.equal(wait.pollCount, 24);
  assert.equal(state.rows(taskRuns).length, 0);
  assert.match(card.lastError, /provider|Gitea/i);
});

test('merged event cannot resurrect a moved card or superseded wait', async (t) => {
  const { card, state, plan, pull, payload } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...pull, state: 'open', merged: false })));
  await parkForMerge(card, plan);
  card.columnStatus = 'cancelled';
  await handleGiteaWebhookEvent({ eventName: 'pull_request', payload });
  assert.equal(card.columnStatus, 'cancelled');
  state.rows(externalWaits)[0]!.status = 'superseded'; card.columnStatus = 'in_review';
  await handleGiteaWebhookEvent({ eventName: 'pull_request', payload });
  assert.equal(card.columnStatus, 'in_review');
});

for (const outcome of ['drift', 'closed_unmerged']) {
  test(`reconciliation sends ${outcome} to review or repair`, async (t) => {
    const { card, state, plan, pull } = fixture(t);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...pull, state: 'open', merged: false })));
    await parkForMerge(card, plan);
    const wait = state.rows(externalWaits)[0]!; wait.lastPolledAt = new Date(0);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...pull, merged: outcome !== 'closed_unmerged', head: { sha: outcome === 'drift' ? 'b'.repeat(40) : head } })));
    await reconcileMergeWait(wait.id);
    assert.equal(card.columnStatus, outcome === 'drift' ? 'in_review' : 'blocked');
    assert.equal(wait.status, outcome === 'drift' ? 'superseded' : 'failure');
    assert.equal(wait.authorizedHeadSha, head);
  });
}

test('simultaneous webhook and reconciliation commit only one success event', async (t) => {
  const { card, state, plan, pull, payload } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...pull, state: 'open', merged: false })));
  await parkForMerge(card, plan);
  const wait = state.rows(externalWaits)[0]!; wait.lastPolledAt = new Date(0);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pull)));
  await Promise.all([reconcileMergeWait(wait.id), handleGiteaWebhookEvent({ eventName: 'pull_request', payload })]);
  assert.equal(card.columnStatus, 'done');
  assert.equal(state.rows(externalEvents).filter((event) => event.status === 'success').length, 1);
});

test('legacy authorized waits without a poll interval are adopted by the server sweep', async (t) => {
  const { card, state, pull } = fixture(t);
  card.columnStatus = 'waiting_on_external';
  state.rows(externalWaits).push({ id: 'legacy', cardId: card.id, companyId: card.companyId, provider: 'gitea', status: 'waiting', externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12', authorizedHeadSha: head, pollIntervalSeconds: null, pollCount: 0, createdAt: new Date(0), lastPolledAt: null });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pull)));
  await sweepExternalWaitPolls({ log: { info() {}, warn() {} } } as any);
  assert.equal(card.columnStatus, 'done');
});
