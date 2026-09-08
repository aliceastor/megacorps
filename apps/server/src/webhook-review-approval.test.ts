import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { activityLog, agents, approvals, cardComments, costEvents, departments, externalWaits, kanbanCards, mergeIntents, projects, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { registerRoutes } from './routes.ts';
import { beginReviewIdentity } from './review-identity.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';

const head = 'a'.repeat(40);
async function fixture(t: TestContext, bossReview = false) {
  const companyId = randomUUID(), authorId = randomUUID(), reviewerId = randomUUID();
  const project: any = { id: randomUUID(), companyId, repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo', managedRepoFullName: 'org/repo', defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: true, mergeReadiness: { ready: true } };
  const card: any = { id: randomUUID(), companyId, projectId: project.id, title: 'Reviewed artifact', body: '## Acceptance\n- Verified durable deliverable', assigneeId: authorId, reviewerId, columnStatus: 'in_progress', requiresApproval: false, tags: [], dependencyCardIds: [], mergeGateVersion: 0, reviewRound: 0 };
  const workerRun: any = { id: randomUUID(), companyId, cardId: card.id, agentId: authorId, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[projects, [project]], [kanbanCards, [card]], [taskRuns, [workerRun]], [agents, [{ id: authorId, companyId, name: 'Author', slug: 'author', isActive: true, isBusy: false, adapterType: 'webhook' }, { id: reviewerId, companyId, name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, adapterType: 'webhook' }]]]);
  const structure = readyCompany(state, companyId);
  if (bossReview) {
    const boss = state.rows(agents).find(row => row.id === reviewerId)!;
    Object.assign(boss, { positionId: structure.positionId, role: 'boss', bossId: null });
    state.rows(agents).find(row => row.id === structure.bossId)!.positionId = null;
    Object.assign(state.rows(agents).find(row => row.id === authorId)!, { departmentId: structure.departmentId, role: 'cto', bossId: reviewerId });
    state.rows(departments).find(row => row.id === structure.departmentId)!.headAgentId = authorId;
    card.departmentId = structure.departmentId;
    // A staffed Head reaches final review only after its worker's accepted
    // evidence; retain that real gate instead of a coordination-only bypass.
    const child: any = { ...card, id: randomUUID(), parentCardId: card.id, assigneeId: structure.headId, reviewerId: authorId, columnStatus: 'done' };
    const waitId = randomUUID();
    state.rows(kanbanCards).push(child);
    state.rows(workProducts).push({ id: randomUUID(), companyId, projectId: project.id, cardId: child.id, agentId: child.assigneeId, type: 'pull_request', title: 'Accepted worker artifact', url: 'https://gitea.test/org/repo/pulls/12', commitSha: head });
    state.rows(externalWaits).push({ id: waitId, companyId, cardId: child.id, provider: 'gitea', status: 'success', authorizedHeadSha: head });
    state.rows(mergeIntents).push({ id: randomUUID(), cardId: child.id, projectId: project.id, waitId, headSha: head, state: 'verified' });
    child.deliveryAcceptance = await captureDeliveryAcceptance(child);
    assert.ok(child.deliveryAcceptance, 'The Head fixture needs server-captured child acceptance.');
  }
  for (const agent of state.rows(agents)) agent.giteaUsername = agent.slug;
  const previous = { url: process.env.GITEA_URL, token: process.env.GITEA_ADMIN_TOKEN, webhook: process.env.WEBHOOK_SHARED_SECRET };
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-service'; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-review-hook';
  t.after(() => { for (const [key, value] of Object.entries({ GITEA_URL: previous.url, GITEA_ADMIN_TOKEN: previous.token, WEBHOOK_SHARED_SECRET: previous.webhook })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let posts = 0, fetches = 0, merged = false, currentHead = head;
  t.mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    fetches++;
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
  return { state, card, ordinary, reviewRun, post, report, app, posts: () => posts, fetches: () => fetches, drift: () => { currentHead = 'b'.repeat(40); } };
}

for (const placement of ['report', 'output'] as const) test(`contradictory approved Boss review in ${placement} has no completion effects and accepts correction on the same run`, async t => {
  const f = await fixture(t, true);
  const tables = [kanbanCards, taskRuns, approvals, workProducts, costEvents, cardComments, activityLog, mergeIntents, externalWaits];
  const before = structuredClone(tables.map(table => f.state.rows(table)));
  const beforeFetches = f.fetches();
  const approved = { ...f.report, verdict: 'approved', notes: ['Review evidence is ready for the normal completion gate.'] };
  const result = await f.post(f.reviewRun.id, { status: 'needs_review', costUsd: 0.25, ...(placement === 'report' ? { report: approved } : { report: undefined, output: JSON.stringify(approved) }) });
  assert.equal(result.statusCode, 409, `Contradictory callback must not create a human gate: ${result.body}`);
  assert.equal(result.json().error, 'review_status_conflict');
  assert.match(result.json().message, /done.*in_review/);
  assert.match(result.json().message, /input_required.*help.*escalate/i);
  assert.deepEqual(tables.map(table => f.state.rows(table)), before, 'Rejection must preserve card/run/approval/evidence/usage/comments/activity/waits/intents.');
  assert.equal(f.fetches(), beforeFetches, 'No provider GET or mutation for the rejected contradiction.');
  const corrected = await f.post(f.reviewRun.id, { status: placement === 'report' ? 'done' : 'in_review' });
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.notEqual(corrected.json().duplicate, true);
  assert.equal(f.ordinary.status, 'approved');
  assert.equal(f.card.columnStatus, 'done');
  assert.equal(f.posts(), 0, 'The Head inherits the accepted worker evidence without merging it again.');
  assert.equal(f.state.rows(approvals).some(row => row.payload?.humanGate === true), false);
});

for (const kind of ['permission', 'failed', 'rejected', 'help', 'escalate', 'explicit_escalation', 'legacy_help', 'legacy_approved'] as const) test(`outer needs_review preserves genuine ${kind} instead of status-conflict rejection`, async t => {
  const f = await fixture(t, true);
  const report: any = { ...f.report, verdict: 'approved' };
  if (kind === 'permission') report.request = { kind: 'permission', question: 'The requested command needs explicit permission.' };
  if (kind === 'failed' || kind === 'rejected') report.status = kind;
  if (kind === 'help') {
    delete report.verdict;
    Object.assign(report, { status: 'input_required', request: { kind: 'help', question: 'A manager must decide the remaining scope question.' } });
  }
  if (kind === 'escalate') report.verdict = 'escalate';
  if (kind === 'explicit_escalation') report.escalation = { reason: 'A manager must decide the remaining scope question.' };
  const legacy = kind === 'legacy_help' || kind === 'legacy_approved';
  const result = await f.post(f.reviewRun.id, { status: 'needs_review', report: legacy ? undefined : report, ...(legacy ? { output: kind === 'legacy_approved' ? 'VERDICT: APPROVED' : 'VERDICT: ESCALATE\nA manager must decide the remaining scope question.' } : {}) });
  assert.equal(result.statusCode, 200, result.body);
  assert.notEqual(result.json().error, 'review_status_conflict');
  assert.notEqual(f.card.columnStatus, 'done');
  assert.equal(f.posts(), 0);
  if (['permission', 'failed', 'rejected'].includes(kind)) {
    assert.equal(f.card.columnStatus, 'blocked');
    assert.equal(f.ordinary.status, 'pending');
    assert.equal(f.state.rows(approvals).some(row => row.payload?.humanGate === true), false);
  } else assert.equal(f.state.rows(approvals).some(row => row.payload?.humanGate === true), true);
});

test('dispatch completed report with outer needs_review retains existing guidance semantics', async t => {
  const f = await fixture(t, true);
  f.reviewRun.kind = 'dispatch';
  f.reviewRun.agentId = f.card.assigneeId;
  const result = await f.post(f.reviewRun.id, { status: 'needs_review' });
  assert.equal(result.statusCode, 200, result.body);
  assert.notEqual(result.json().error, 'review_status_conflict');
  assert.equal(f.card.columnStatus, 'needs_review');
  assert.equal(f.posts(), 0);
});

for (const stop of ['blocked', 'todo', 'cancelled', 'waiting_on_external'] as const) test(`completed approved review does not override explicit outer ${stop}`, async t => {
  const f = await fixture(t, true);
  const result = await f.post(f.reviewRun.id, { status: stop });
  assert.equal(result.statusCode, 200, result.body);
  assert.notEqual(result.json().error, 'review_status_conflict');
  assert.notEqual(f.card.columnStatus, 'done');
  assert.equal(f.posts(), 0);
});

for (const identity of ['foreign_caller', 'wrong_actor', 'foreign_run_company', 'foreign_run_card', 'stale_run', 'reassigned_reviewer'] as const) test(`review status conflict preserves ${identity} validation priority`, async t => {
  const f = await fixture(t, true);
  let caller: any;
  if (identity === 'foreign_caller') {
    caller = { id: randomUUID(), companyId: randomUUID(), apiToken: 'mcagt_synthetic_foreign_review' };
    f.state.rows(agents).push(caller);
  }
  if (identity === 'wrong_actor') {
    caller = f.state.rows(agents).find(row => row.id === f.card.assigneeId)!;
    caller.apiToken = 'mcagt_synthetic_wrong_review_actor';
  }
  if (identity === 'foreign_run_company') f.reviewRun.companyId = randomUUID();
  if (identity === 'foreign_run_card') f.reviewRun.cardId = randomUUID();
  if (identity === 'stale_run') f.reviewRun.status = 'cancelled';
  if (identity === 'reassigned_reviewer') f.card.reviewerId = randomUUID();
  const before = structuredClone([f.card, f.ordinary]);
  const fetches = f.fetches();
  const result = caller ? await f.app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { authorization: `Bearer ${caller.apiToken}` }, payload: { cardId: f.card.id, taskRunId: f.reviewRun.id, status: 'needs_review', report: { ...f.report, verdict: 'approved' } } }) : await f.post(f.reviewRun.id, { status: 'needs_review' });
  assert.equal(result.statusCode, identity === 'stale_run' ? 200 : ['foreign_caller', 'wrong_actor', 'foreign_run_company'].includes(identity) ? 403 : 409, result.body);
  assert.notEqual(result.json().error, 'review_status_conflict', 'An invalid/stale identity is not a correctable status conflict.');
  if (identity === 'stale_run') assert.equal(result.json().stale, true);
  assert.deepEqual([f.card, f.ordinary], before);
  assert.equal(f.fetches(), fetches);
});

test('status conflict preserves an already-pending human gate and its reassigned reviewer', async t => {
  const f = await fixture(t, true);
  f.card.reviewerId = null;
  f.state.rows(approvals).push({ id: randomUUID(), companyId: f.card.companyId, cardId: f.card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
  const before = structuredClone([f.card, f.state.rows(approvals)]);
  const result = await f.post(f.reviewRun.id, { status: 'needs_review' });
  assert.equal(result.statusCode, 409, result.body);
  assert.deepEqual([f.card, f.state.rows(approvals)], before);
  assert.equal(f.posts(), 0);
});

test('corrected approved callback retains a legitimate requiresApproval client gate', async t => {
  const f = await fixture(t, true);
  f.card.requiresApproval = true;
  await beginReviewIdentity(f.card, f.reviewRun.id, { taskRunId: f.reviewRun.id });
  const conflict = await f.post(f.reviewRun.id, { status: 'needs_review' });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error, 'review_status_conflict');
  assert.equal(f.state.rows(approvals).some(row => row.payload?.humanGate === true), false);
  const corrected = await f.post(f.reviewRun.id);
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.notEqual(f.card.columnStatus, 'done');
  assert.equal(f.state.rows(approvals).some(row => row.status === 'pending' && row.payload?.humanGate === true), true);
  assert.equal(f.posts(), 0);
});

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
