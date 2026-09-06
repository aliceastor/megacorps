import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, companies, agentRuntimes, projects, kanbanCards, cardComments, taskRuns, adapterSessions } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { runMessageDelegation, reviewMessageDelegation } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import type { TaskContext } from './adapters/hermes.ts';

type Kind = 'message' | 'message_review';
function fixture(t: TestContext, kind: Kind, continuation = false, bossReview = false) {
  const state = memoryDb(t, []), companyId = randomUUID();
  const { headId, bossId, departmentId } = readyCompany(state, companyId);
  Object.assign(state.rows(companies)[0]!, { slug: 'tenant', nfsShareUrl: 'nfs://fixture/share' });
  const runtime: any = { id: randomUUID(), companyId, adapterType: 'hermes-ssh', isActive: true, nfsMountRoot: '/shared', localWorkspaceRoot: '/local', config: {} };
  state.rows(agentRuntimes).push(runtime);
  const head = state.rows(agents).find(row => row.id === headId)!;
  Object.assign(head, { giteaUsername: 'parent-user', giteaToken: 'parent-synthetic-secret' });
  const worker: any = { id: randomUUID(), companyId, name: 'Worker', slug: 'worker', departmentId, bossId: headId, runtimeId: runtime.id, adapterType: 'hermes-ssh', isActive: true, isBusy: false, giteaUsername: 'worker-user', giteaToken: 'worker-synthetic-secret' };
  const reviewer: any = { ...worker, id: randomUUID(), name: 'Reviewer', slug: 'reviewer', giteaUsername: 'reviewer-user', giteaToken: 'reviewer-synthetic-secret' };
  state.rows(agents).push(worker, reviewer);
  const boss = state.rows(agents).find(row => row.id === bossId)!;
  Object.assign(boss, { runtimeId: runtime.id, adapterType: 'hermes-ssh', giteaUsername: 'boss-user', giteaToken: 'boss-synthetic-secret' });
  const actor = kind === 'message' ? worker : bossReview ? boss : reviewer;
  const project: any = { id: randomUUID(), companyId, name: 'Current project', repoProvider: 'gitea-local', repoUrl: 'https://gitea.example/tenant/current.git', defaultBranch: 'main', protectedBranches: ['main'], completionRequiresMerge: true, autoMergeAfterApproval: true, deletedAt: null };
  state.rows(projects).push(project);
  const card: any = { id: randomUUID(), companyId, projectId: project.id, title: 'Create the assigned counter', body: '## Acceptance\nA usable counter with readable errors.', assigneeId: headId, reviewerId: bossId, columnStatus: 'in_progress', tags: [], protocolRepairState: {}, runRetryState: {} };
  const request: any = { id: randomUUID(), cardId: card.id, action: 'delegate_request', body: 'Deliver a PR to https://gitea.example/tenant/stale.git', assigneeAgentId: worker.id, reviewerAgentId: actor.id === worker.id ? reviewer.id : actor.id, reviewerScope: 'phase', delegationStatus: kind === 'message' ? 'queued' : 'submitted' };
  const report: any = { ...request, id: randomUUID(), parentCommentId: request.id, action: 'delegate_report', body: 'Candidate is at https://gitea.example/tenant/stale.git' };
  const run: any = { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind, status: 'running', messageCommentId: kind === 'message' ? request.id : report.id };
  state.rows(kanbanCards).push(card); state.rows(cardComments).push(request, ...(kind === 'message_review' ? [report] : [])); state.rows(taskRuns).push(run);
  if (continuation) {
    state.rows(adapterSessions).push({ id: randomUUID(), companyId, agentId: actor.id, runtimeId: runtime.id, adapterType: 'hermes-ssh', scopeType: 'card', scopeId: card.id, kind, status: 'active', adapterSessionId: 'previous-session', updatedAt: new Date(0) });
    project.repoUrl = 'https://gitea.example/tenant/changed.git'; project.defaultBranch = 'release'; project.protectedBranches = ['release'];
  }
  let prompt = '', calls = 0;
  t.mock.method(getAdapter('hermes-ssh'), 'dispatch', async (_agent: unknown, task: TaskContext) => {
    calls++; prompt = task.body ?? '';
    return { success: true, output: '{"kind":"megacorps-report","status":"completed","summary":"Fixed synthetic response for prompt inspection.","verdict":"revision_requested"}', sessionId: 'fixed-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  return { state, card, project, actor, worker, reviewer, run, runtime, prompt: () => prompt, calls: () => calls, execute: () => kind === 'message' ? runMessageDelegation(card.id, { taskRunId: run.id }) : reviewMessageDelegation(card.id, { taskRunId: run.id }) };
}
for (const kind of ['message', 'message_review'] as const) {
  for (const continuation of [false, true]) test(`${kind} ${continuation ? 'continuation' : 'bootstrap'} carries current project authority and only its actor credentials`, async t => {
    const f = fixture(t, kind, continuation); await f.execute(); const prompt = f.prompt();
    assert.match(prompt, new RegExp(f.project.id));
    assert.ok(prompt.includes(f.project.repoUrl));
    assert.match(prompt, /current project.*overrides.*delegation.*thread/i);
    assert.ok(prompt.includes(f.actor.giteaToken)); assert.ok(prompt.includes(f.actor.giteaUsername));
    assert.ok(prompt.includes(`/shared/tenant/agents/${f.actor.slug}/project/current-project`));
    assert.doesNotMatch(prompt, /parent-synthetic-secret|boss-synthetic-secret/);
    assert.ok(!prompt.includes(kind === 'message' ? f.reviewer.giteaToken : f.worker.giteaToken));
    assert.match(prompt, /MegaCorps alone performs the authorized merge/);
    assert.match(prompt, /do not push directly to protected branches/i);
    if (continuation) { assert.match(prompt, /Continue this existing Message Board/); assert.match(prompt, /release/); }
  });
  test(`${kind} projectless remains usable with explicit no-repository guidance`, async t => {
    const f = fixture(t, kind); f.card.projectId = null; await f.execute();
    assert.match(f.prompt(), /No repository is configured for this project/);
    assert.doesNotMatch(f.prompt(), /synthetic-secret|tenant\/current.git/);
  });
  for (const invalid of ['missing', 'foreign', 'deleted']) test(`${kind} ${invalid} project never exposes project configuration`, async t => {
    const f = fixture(t, kind);
    if (invalid === 'missing') f.card.projectId = randomUUID();
    if (invalid === 'foreign') f.project.companyId = randomUUID();
    if (invalid === 'deleted') f.project.deletedAt = new Date();
    f.project.repoUrl = 'https://private.example/hidden/repo.git'; f.project.publishToken = 'hidden-project-secret';
    await f.execute();
    if (invalid === 'deleted') assert.match(f.prompt(), /assigned project.*unavailable/i);
    else { assert.equal(f.calls(), 0); assert.match(f.run.error ?? '', /project/); }
    assert.doesNotMatch(f.prompt(), /private.example|hidden-project-secret|synthetic-secret/);
  });
  test(`${kind} foreign runtime actor is rejected before adapter disclosure`, async t => {
    const f = fixture(t, kind); f.actor.companyId = randomUUID();
    await f.execute(); assert.equal(f.calls(), 0); assert.match(f.run.error ?? '', /same-company actor/);
  });
}
for (const continuation of [false, true]) test(`Boss message goal assessment ${continuation ? 'continuation' : 'bootstrap'} gets evidence scope without execution protocol or credentials`, async t => {
  const f = fixture(t, 'message_review', continuation, true); await f.execute(); const prompt = f.prompt();
  assert.ok(prompt.includes(f.project.repoUrl)); assert.ok(prompt.includes(f.project.id));
  assert.match(prompt, /GOAL ASSESSMENT/); assert.match(prompt, /Never clone, test or implement/);
  assert.match(prompt, /current project.*overrides.*delegation.*thread/i);
  assert.doesNotMatch(prompt, /Repository workflow:|Authenticated clone URL:|synthetic-secret|Your workspace \(clone|Validate with:|Inspect the actual current artifact/);
});
