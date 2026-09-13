import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { db } from './db/client.ts';
import * as s from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';

const approvedReport = JSON.stringify({ kind: 'megacorps-report', status: 'completed', verdict: 'approved', summary: 'Independently inspected the deliverable.' });

function fixture(t: TestContext, options: { review?: boolean; headIsAuthor?: boolean; busyHead?: boolean; includeBoss?: boolean } = {}) {
  const companyId = randomUUID(), otherCompanyId = randomUUID(), departmentId = randomUUID();
  const projectId = randomUUID(), cardId = randomUUID(), intentId = randomUUID(), waitId = randomUUID();
  const headPosition = { id: randomUUID(), companyId, rank: 1, isDepartmentHead: true, isCompanyBoss: false, defaultDepartmentId: departmentId, isActive: true };
  const staffPosition = { id: randomUUID(), companyId, rank: 2, isDepartmentHead: false, isCompanyBoss: false, defaultDepartmentId: departmentId, isActive: true };
  const bossPosition = { id: randomUUID(), companyId, rank: 0, isDepartmentHead: false, isCompanyBoss: true, defaultDepartmentId: null, isActive: true };
  const head = { id: randomUUID(), companyId, positionId: headPosition.id, departmentId, isActive: true, isBusy: options.busyHead ?? false, deletedAt: null };
  const reviewer = { id: randomUUID(), companyId, positionId: staffPosition.id, departmentId, isActive: true, deletedAt: null };
  const boss = { id: randomUUID(), companyId, positionId: bossPosition.id, departmentId: null, isActive: true, deletedAt: null };
  const author = options.headIsAuthor ? head : { id: randomUUID(), companyId, positionId: staffPosition.id, departmentId, isActive: true, deletedAt: null };
  const identity = { id: randomUUID(), scope: randomUUID(), projectId, repoUrl: 'https://git.test/org/repo', defaultBranch: 'main', headSha: 'a'.repeat(40), externalId: '12', candidateKey: '["v2","pull_request",12]', capturedAt: new Date().toISOString() };
  const card: any = { id: cardId, companyId, projectId, departmentId, assigneeId: author.id, columnStatus: 'waiting_on_external', mergeGateVersion: 4, reviewIdentity: identity, requiresApproval: false, deletedAt: null, title: 'Reviewed change' };
  const intent: any = { id: intentId, cardId, projectId, waitId, headSha: identity.headSha, defaultBranch: 'main', repoFullName: 'org/repo', gateVersion: 4, state: 'prepared', attemptCount: 0, decisionRequired: true, candidateDepartmentId: departmentId };
  const agents = [...new Map([author, head, reviewer, ...(options.includeBoss === false ? [] : [boss])].map(row => [row.id, row])).values()];
  const runs = options.review === false ? [] : [{ id: identity.scope, companyId, cardId, agentId: reviewer.id, kind: 'review', status: 'success', reviewIdentity: identity, output: approvedReport }];
  const state = memoryDb(t, [
    [s.agents, agents], [s.positions, [headPosition, staffPosition, bossPosition]], [s.kanbanCards, [card]],
    [s.mergeIntents, [intent]], [s.externalWaits, [{ id: waitId, companyId, cardId, provider: 'gitea', status: 'waiting', authorizedHeadSha: identity.headSha }]],
    [s.taskRuns, runs], [s.reviewRounds, []], [s.activityLog, []], [s.approvals, []], [s.companyMemberships, []], [s.cardComments, []], [s.notifications, []],
  ]);
  const action = { action: 'merge_pr' as const, intentId, headSha: identity.headSha, reason: 'Independent acceptance proves the exact candidate is ready.' };
  return { state, companyId, otherCompanyId, departmentId, card, intent, head, reviewer, boss, headPosition, staffPosition, action };
}

test('Head author may authorize only after acceptance by a different reviewer', async t => {
  const mod = await import('./manager-merge.ts');
  const f = fixture(t, { headIsAuthor: true, review: false });
  const actor = { companyId: f.companyId, agentId: f.head.id, source: 'management' as const };
  await assert.rejects(mod.requestManagerMerge(actor, f.action), /merge_independent_review_required/);
  f.state.rows(s.taskRuns).push({ id: f.card.reviewIdentity.scope, companyId: f.companyId, cardId: f.card.id, agentId: f.head.id, kind: 'review', status: 'success', reviewIdentity: f.card.reviewIdentity, output: approvedReport });
  await assert.rejects(mod.requestManagerMerge(actor, f.action), /merge_independent_review_required/);
  f.state.rows(s.taskRuns).push({ id: randomUUID(), companyId: f.companyId, cardId: f.card.id, agentId: f.reviewer.id, kind: 'review', status: 'success', reviewIdentity: f.card.reviewIdentity, output: approvedReport });
  assert.equal((await mod.requestManagerMerge(actor, f.action)).status, 'authorized');
});

test('cross-company and stale or non-current roles cannot authorize', async t => {
  const mod = await import('./manager-merge.ts');
  const f = fixture(t);
  await assert.rejects(mod.requestManagerMerge({ companyId: f.otherCompanyId, agentId: f.head.id, source: 'management' }, f.action), /merge_candidate_not_found/);
  for (const mutate of [
    () => { f.head.isActive = false; },
    () => { (f.head as {deletedAt:Date|null}).deletedAt = new Date(); },
    () => { f.head.positionId = f.staffPosition.id; },
    () => { f.head.departmentId = randomUUID(); },
  ]) {
    Object.assign(f.head, { isActive: true, deletedAt: null, positionId: f.headPosition.id, departmentId: f.departmentId });
    mutate();
    await assert.rejects(mod.requestManagerMerge({ companyId: f.companyId, agentId: f.head.id, source: 'management' }, f.action), /merge_role_denied/);
  }
  Object.assign(f.head, { isActive: true, deletedAt: null, positionId: f.headPosition.id, departmentId: f.departmentId });
  f.card.mergeGateVersion++;
  await assert.rejects(mod.requestManagerMerge({ companyId: f.companyId, agentId: f.head.id, source: 'management' }, f.action), /merge_candidate_changed/);
});

test('pending human gates block authorization', async t => {
  const mod = await import('./manager-merge.ts');
  const f = fixture(t);
  f.state.rows(s.approvals).push({ id: randomUUID(), cardId: f.card.id, status: 'pending', payload: { humanGate: true }, createdAt: new Date() });
  await assert.rejects(mod.requestManagerMerge({ companyId: f.companyId, agentId: f.head.id, source: 'management' }, f.action), /merge_approval_pending/);
});

test('Direct Chat requires a current operator and duplicate requests log once', async t => {
  const mod = await import('./manager-merge.ts');
  const f = fixture(t);
  const userId = randomUUID();
  const actor = { companyId: f.companyId, agentId: f.head.id, userId, source: 'chat' as const };
  const membership: any = { id: randomUUID(), companyId: f.companyId, userId, role: 'viewer', status: 'active' };
  f.state.rows(s.companyMemberships).push(membership);
  await assert.rejects(mod.requestManagerMerge(actor, f.action), /merge_user_permission_required/);
  membership.role = 'operator'; membership.status = 'revoked';
  await assert.rejects(mod.requestManagerMerge(actor, f.action), /merge_user_permission_required/);
  membership.status = 'active';
  assert.equal((await mod.requestManagerMerge(actor, f.action)).status, 'authorized');
  assert.equal((await mod.requestManagerMerge(actor, f.action)).status, 'already_authorized');
  assert.equal(f.state.rows(s.activityLog).filter(row => row.action === 'merge.manager_authorized').length, 1);
});

test('busy owning Head remains queued before Boss and failed decisions stop after three attempts', async t => {
  const mod = await import('./manager-merge.ts');
  const f = fixture(t, { busyHead: true });
  assert.equal(await mod.ensureMergeDecision(f.intent.waitId), true);
  let questions = f.state.rows(s.cardComments).filter(row => row.metadata?.mergeDecision);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.assigneeAgentId, f.head.id);
  assert.equal(questions[0]!.delegationStatus, 'queued');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const question = questions.at(-1)!;
    question.delegationStatus = 'failed';
    await mod.recoverMergeDecision(f.card, question as any, question.assigneeAgentId, `attempt ${attempt} failed`);
    await mod.ensureMergeDecision(f.intent.waitId);
    questions = f.state.rows(s.cardComments).filter(row => row.metadata?.mergeDecision);
  }
  assert.equal(questions.length, 3);
  assert.equal(questions[0]!.assigneeAgentId, f.head.id);
  assert.equal(questions[1]!.assigneeAgentId, f.head.id);
  assert.equal(questions[2]!.assigneeAgentId, f.boss.id);
  assert.equal(f.state.rows(s.notifications).filter(row => row.title === 'Merge decision needs human input').length, 1);
});
