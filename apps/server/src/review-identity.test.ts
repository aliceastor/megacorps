import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { signSession } from './auth.ts';
import { agents, approvals, companyMemberships, kanbanCards, machineRunners, projects, reviewRounds, taskRuns, users, workProducts, externalWaits, mergeIntents } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { getAdapter } from './adapters/registry.ts';
import { reviewCard } from './dispatch.ts';
import { ensureHumanGate, openPanelRound, reviewPanelSlot } from './review-rounds.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { registerRoutes } from './routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { beginReviewIdentity } from './review-identity.ts';

const A = 'a'.repeat(40), B = 'b'.repeat(40), repo = 'https://gitea.test/org/repo';
function fixture(t: TestContext, candidate: 'url' | 'short' | 'branch' = 'url') {
  const card: any = { id: randomUUID(), companyId: randomUUID(), projectId: randomUUID(), title: 'Review change', body: 'Verify all acceptance criteria.', columnStatus: 'in_review', assigneeId: 'author', reviewerId: 'reviewer', reviewerIds: ['reviewer'], requiresApproval: false, tags: [], dependencyCardIds: [], mergeGateVersion: 0, reviewRound: 0 };
  const author: any = { id: 'author', companyId: card.companyId, name: 'Author', slug: 'author', adapterType: 'webhook', isActive: true, isBusy: false };
  const reviewer: any = { ...author, id: 'reviewer', name: 'Reviewer', slug: 'reviewer' };
  const run: any = { id: randomUUID(), cardId: card.id, companyId: card.companyId, agentId: reviewer.id, kind: 'review', status: 'running' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [author, reviewer]], [taskRuns, [run]], [projects, [{ id: card.projectId, companyId: card.companyId, repoUrl: repo, defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: false }]], [workProducts, [{ id: 'product', cardId: card.id, projectId: card.projectId, companyId: card.companyId, agentId: author.id, type: candidate === 'branch' ? 'commit' : 'pull_request', title: 'Change', ...(candidate === 'branch' ? { branch: 'feature' } : { url: `${repo}/pulls/12`, ...(candidate === 'short' ? { commitSha: A.slice(0, 8) } : {}) }) }]]]);
  readyCompany(state, card.companyId);
  const oldUrl = process.env.GITEA_URL, oldToken = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic-review-identity';
  t.after(() => { if (oldUrl === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = oldUrl; if (oldToken === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = oldToken; });
  let head = A, reads = 0, posts = 0;
  t.mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    if (init?.method === 'POST') posts++;
    reads++;
    const url = String(input); assert.ok(url.startsWith('https://gitea.test/api/v1/repos/org/repo/'), url);
    return new Response(JSON.stringify(url.includes('/git/commits/') ? { sha: url.endsWith(A.slice(0, 8)) ? A : head } : { state: 'open', merged: false, number: 12, head: { sha: head }, base: { ref: 'main' }, html_url: `${repo}/pulls/12` }));
  });
  const approve = { success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Verified the pinned change.', verdict: 'approved' }), sessionId: 'review-result', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  const assertOutcome = (drift: boolean) => {
    assert.equal(posts, 0);
    assert.equal(state.rows(externalWaits).some(wait => wait.authorizedHeadSha === B), false);
    assert.equal(state.rows(mergeIntents).some(intent => intent.headSha === B), false);
    if (!drift) assert.ok(state.rows(externalWaits).some(wait => wait.authorizedHeadSha === A));
    else assert.equal(card.columnStatus, 'in_review', 'head drift requires a new review');
  };
  return { card, run, state, approve, drift: () => { head = B; }, reads: () => reads, assertOutcome };
}

for (const candidate of ['url', 'short', 'branch'] as const) for (const drift of [false, true]) test(`ordinary ${candidate} review consumes its pre-review full identity, drift=${drift}`, async t => {
  const f = fixture(t, candidate);
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: any, task: any) => {
    assert.ok(f.reads() > 0); assert.match(task.body, new RegExp(A));
    assert.equal(f.run.reviewIdentity?.headSha, A); assert.equal(f.card.reviewIdentity?.id, f.run.reviewIdentity?.id);
    if (drift) f.drift(); return f.approve;
  });
  await reviewCard(f.card.id, { taskRunId: f.run.id }); f.assertOutcome(drift);
});

for (const drift of [false, true]) test(`runner URL-only review uses persisted claim identity after handler restart, drift=${drift}`, async t => {
  const f = fixture(t); f.run.status = 'queued';
  f.state.rows(machineRunners).push({ id: 'runner', companyId: f.card.companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-identity-runner'), supportedRuntimes: [] });
  const headers = { 'x-megacorps-runner-key': 'synthetic-identity-runner' };
  const first = Fastify(); await registerRunnerRoutes(first);
  const claim = await first.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers, payload: {} });
  assert.equal(claim.statusCode, 200, claim.body); assert.equal(claim.json().reviewIdentity.headSha, A); assert.match(claim.json().companyContext, new RegExp(A));
  const captured = structuredClone(f.run.reviewIdentity); await first.close();
  if (drift) f.drift();
  // A newly registered HTTP composition reads the durable run; no old closure
  // or client-supplied identity is used by the completion request.
  const restarted = Fastify(); t.after(() => restarted.close()); await registerRunnerRoutes(restarted);
  const complete = await restarted.inject({ method: 'POST', url: `/api/runner/task-runs/${f.run.id}/complete`, headers, payload: { status: 'success', output: f.approve.output } });
  assert.equal(complete.statusCode, 200, complete.body); assert.deepEqual(f.run.reviewIdentity, captured); f.assertOutcome(drift);
});

for (const drift of [false, true]) test(`human URL-only gate presents and consumes its stored identity, drift=${drift}`, async t => {
  const f = fixture(t); f.card.requiresApproval = true;
  const user: any = { id: 'operator', email: 'operator@example.test', role: 'admin', status: 'active' };
  f.state.rows(users).push(user); f.state.rows(companyMemberships).push({ companyId: f.card.companyId, userId: user.id, role: 'admin', status: 'active' });
  await ensureHumanGate(f.card, null, 'Review the exact change.');
  const gate = f.state.rows(approvals)[0]!; assert.equal(gate.payload.reviewIdentity.headSha, A); assert.match(gate.payload.reason, new RegExp(A));
  if (drift) f.drift();
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const visible = await app.inject({ method: 'GET', url: '/api/approvals', headers: { cookie: `session=${await signSession(user)}` } });
  assert.equal(visible.statusCode, 200, visible.body);
  assert.match(visible.json().find((row: any) => row.id === gate.id).payload.reason, new RegExp(`Full reviewed head: ${A}`));
  const response = await app.inject({ method: 'PUT', url: `/api/approvals/${gate.id}`, headers: { cookie: `session=${await signSession(user)}` }, payload: { status: 'approved' } });
  assert.equal(response.statusCode, 200, response.body); f.assertOutcome(drift);
});

for (const drift of [false, true]) test(`blind panel URL-only slots share the original round identity, drift=${drift}`, async t => {
  const f = fixture(t); f.state.rows(taskRuns).length = 0;
  const opened = await openPanelRound(f.card, { kind: 'panel' }); assert.ok(opened.roundId);
  const round = f.state.rows(reviewRounds).find(row => row.id === opened.roundId)!;
  assert.equal(round.metadata.reviewIdentity.headSha, A);
  let reviews = 0;
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: any, task: any) => {
    reviews++; assert.match(task.body, new RegExp(A)); if (drift) f.drift(); return f.approve;
  });
  const runs = [...f.state.rows(taskRuns).filter(run => run.kind === 'panel_review')];
  for (const run of runs) { run.status = 'running'; await reviewPanelSlot(f.card.id, { taskRunId: run.id }); assert.equal(run.reviewIdentity?.id, round.metadata.reviewIdentity.id); }
  assert.ok(reviews > 0); f.assertOutcome(drift);
});

test('a resumed attempt retains A even when provider now reports B; a new URL-only review captures B', async t => {
  const f = fixture(t);
  const identity = await beginReviewIdentity(f.card, f.run.id, { taskRunId: f.run.id }); assert.equal(identity?.headSha, A);
  f.drift();
  assert.deepEqual(await beginReviewIdentity(structuredClone(f.card), f.run.id, { taskRunId: f.run.id }), identity);
  const next = { ...f.run, id: randomUUID(), reviewIdentity: null }; f.state.rows(taskRuns).push(next);
  assert.equal((await beginReviewIdentity(f.card, next.id, { taskRunId: next.id }))?.headSha, B);
  assert.equal(f.run.reviewIdentity.headSha, A);
});
