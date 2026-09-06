import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { activityLog, agents, approvals, externalWaits, kanbanCards, mergeIntents, projects, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { registerRoutes } from './routes.ts';
import { beginReviewIdentity } from './review-identity.ts';

const head = 'a'.repeat(40);
async function fixture(t: TestContext) {
  const companyId = randomUUID(), authorId = randomUUID(), reviewerId = randomUUID();
  const project: any = { id: randomUUID(), companyId, repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo', managedRepoFullName: 'org/repo', defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: true, mergeReadiness: { ready: true } };
  const card: any = { id: randomUUID(), companyId, projectId: project.id, title: 'Reviewed artifact', body: '## Acceptance\n- Verified durable deliverable', assigneeId: authorId, reviewerId, columnStatus: 'in_progress', requiresApproval: false, tags: [], dependencyCardIds: [], mergeGateVersion: 0, reviewRound: 0 };
  const workerRun: any = { id: randomUUID(), companyId, cardId: card.id, agentId: authorId, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[projects, [project]], [kanbanCards, [card]], [taskRuns, [workerRun]], [agents, [{ id: authorId, companyId, name: 'Author', slug: 'author', isActive: true, isBusy: false, adapterType: 'webhook' }, { id: reviewerId, companyId, name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, adapterType: 'webhook' }]]]);
  readyCompany(state, companyId);
  for (const agent of state.rows(agents)) agent.giteaUsername = agent.slug;
  const previous = { url: process.env.GITEA_URL, token: process.env.GITEA_ADMIN_TOKEN, webhook: process.env.WEBHOOK_SHARED_SECRET };
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-service'; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-review-hook';
  t.after(() => { for (const [key, value] of Object.entries({ GITEA_URL: previous.url, GITEA_ADMIN_TOKEN: previous.token, WEBHOOK_SHARED_SECRET: previous.webhook })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let posts = 0, merged = false, currentHead = head;
  t.mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') { assert.ok(path.endsWith('/pulls/12/merge')); posts++; merged = true; return new Response(null, { status: 204 }); }
    const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: path.includes('/service/') ? 'admin' : 'write', user: { is_admin: false } } : path.includes('/users/') ? { is_admin: false } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [
      { rule_name: '[m]ain', created_at: '2026-09-05T00:00:00Z', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] },
      { rule_name: '**', created_at: '2026-09-05T00:00:02Z', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [] },
    ] : path.endsWith('/pulls/12') ? { number: 12, state: merged ? 'closed' : 'open', merged, head: { sha: currentHead }, base: { ref: 'main' } } : { default_branch: 'main' };
    return new Response(JSON.stringify(value));
  });
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const report = { kind: 'megacorps-report', status: 'completed', summary: 'Verified the exact committed deliverable.', workProducts: [{ type: 'pull_request', title: 'Deliverable', url: 'https://gitea.test/org/repo/pulls/12', commitSha: head }] };
  const post = (runId: string, payload: any = {}) => app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-review-hook' }, payload: { cardId: card.id, taskRunId: runId, status: 'done', report: { ...report, verdict: 'approved' }, ...payload } });
  const worker = await post(workerRun.id, { report }); assert.equal(worker.statusCode, 200, worker.body);
  assert.equal(card.columnStatus, 'in_review');
  const ordinary = state.rows(approvals).find(row => row.type === 'task_review')!;
  assert.equal(ordinary.status, 'pending'); assert.notEqual(ordinary.payload?.humanGate, true);
  const reviewRun = state.rows(taskRuns).find(row => row.kind === 'review')!; reviewRun.status = 'running';
  await beginReviewIdentity(card, reviewRun.id, { taskRunId: reviewRun.id });
  return { state, card, ordinary, reviewRun, post, report, posts: () => posts, drift: () => { currentHead = 'b'.repeat(40); } };
}

test('worker webhook approval is settled by its accepted reviewer webhook before managed merge', async t => {
  const f = await fixture(t);
  const result = await f.post(f.reviewRun.id); assert.equal(result.statusCode, 200, result.body);
  assert.notEqual(result.json().duplicate, true);
  assert.equal(f.state.rows(mergeIntents)[0]?.headSha, head);
  assert.equal(f.ordinary.status, 'approved', 'Accepted review must settle its ordinary quality-review record.');
  assert.equal(f.posts(), 1); assert.equal(f.state.rows(mergeIntents)[0]?.state, 'verified'); assert.equal(f.card.columnStatus, 'done');
  const decided = structuredClone(f.ordinary);
  await f.post(f.reviewRun.id); assert.deepEqual(f.ordinary, decided); assert.equal(f.posts(), 1, 'Replay cannot merge again.');
  assert.equal(f.state.rows(activityLog).filter(row => row.action === 'approval.approved' && row.entityId === f.ordinary.id).length, 1);
});
for (const guard of ['human_gate', 'user_requested_review', 'unrelated_approval', 'foreign_company_approval', 'other_author_review', 'failed_review', 'head_drift', 'rejected_review', 'stale_run', 'reassigned_reviewer'] as const) test(`review approval closure preserves ${guard}`, async t => {
  const f = await fixture(t); let protectedApproval: any;
  if (['human_gate', 'user_requested_review', 'unrelated_approval', 'foreign_company_approval', 'other_author_review'].includes(guard)) {
    protectedApproval = { id: randomUUID(), companyId: guard === 'foreign_company_approval' ? randomUUID() : f.card.companyId, cardId: f.card.id, type: guard === 'unrelated_approval' ? 'budget' : 'task_review', status: 'pending', requestedByAgentId: guard === 'other_author_review' ? randomUUID() : f.card.assigneeId, requestedByUserId: guard === 'user_requested_review' ? randomUUID() : null, payload: guard === 'human_gate' ? { humanGate: true } : { reason: 'Independent approval' } };
    f.state.rows(approvals).push(protectedApproval);
  }
  if (guard === 'head_drift') f.drift();
  if (guard === 'stale_run') f.reviewRun.status = 'cancelled';
  if (guard === 'reassigned_reviewer') f.card.reviewerId = randomUUID();
  const result = await f.post(f.reviewRun.id, guard === 'rejected_review' ? { report: { ...f.report, verdict: 'revision_requested' } } : guard === 'failed_review' ? { report: { ...f.report, status: 'failed', verdict: 'approved' } } : {});
  assert.ok(result.statusCode < 500, result.body);
  if (protectedApproval) assert.equal(protectedApproval.status, 'pending');
  if (['head_drift', 'failed_review', 'rejected_review', 'stale_run', 'reassigned_reviewer', 'human_gate'].includes(guard)) assert.equal(f.ordinary.status, 'pending');
  else assert.equal(f.ordinary.status, 'approved');
  assert.equal(f.posts(), 0, 'Preserved gates or invalid review cannot initiate merge.');
  if (guard === 'head_drift') assert.equal(f.state.rows(externalWaits).some(row => row.authorizedHeadSha === 'b'.repeat(40)), false);
});
