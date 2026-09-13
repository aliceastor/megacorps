import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as executor from './authorized-merge.ts';
import { requestManagerMerge } from './manager-merge.ts';
import { memoryDb } from './test-support/memory-db.ts';
import * as schema from './db/schema.ts';

const head = 'a'.repeat(40);
test('durable merge claim rechecks every gate and policy before one exact-head attempt', async (t) => {
  assert.equal(typeof (executor as any).executeAuthorizedMerge, 'function');
  const { agents, positions, kanbanCards, projects, externalWaits, approvals, reviewRounds, mergeIntents, taskRuns } = schema as any;
  const old = process.env.GITEA_URL, token = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = old; if (token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = token; });
  const companyId = randomUUID(), departmentId = randomUUID();
  const project = { id: randomUUID(), companyId, autoMergeAfterApproval: true, completionRequiresMerge: true, repoProvider: 'gitea-local', managedRepoFullName: 'org/repo', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main' };
  const staff = { id: randomUUID(), companyId, positionId: randomUUID(), departmentId, isActive: true, giteaUsername: 'staff' };
  const manager = { id: randomUUID(), companyId, positionId: randomUUID(), departmentId, isActive: true, giteaUsername: 'head' };
  const identity = { id: randomUUID(), scope: randomUUID(), projectId: project.id, repoUrl: project.repoUrl, defaultBranch: 'main', headSha: head, externalId: '12', candidateKey: '["v2","pull_request",12]', capturedAt: new Date().toISOString() };
  const card = { id: randomUUID(), projectId: project.id, companyId, departmentId, assigneeId: staff.id, reviewerId: manager.id, reviewIdentity: identity, columnStatus: 'waiting_on_external', mergeGateVersion: 1, requiresApproval: false };
  const wait = { id: randomUUID(), cardId: card.id, companyId, status: 'waiting', provider: 'gitea', authorizedHeadSha: head, externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12' };
  const intent = { id: randomUUID(), waitId: wait.id, cardId: card.id, projectId: project.id, candidateDepartmentId: departmentId, headSha: head, repoFullName: 'org/repo', defaultBranch: 'main', gateVersion: 1, state: 'prepared', attemptCount: 0, decisionRequired: true };
  const acceptedReview = { id: identity.scope, companyId, cardId: card.id, agentId: manager.id, kind: 'review', status: 'success', reviewIdentity: identity, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', verdict: 'approved', summary: 'Independent artifact review passed.' }) };
  const state = memoryDb(t, [[agents, [staff, manager]], [positions, [{ id: staff.positionId, companyId, rank: 9, isActive: true, defaultDepartmentId: departmentId }, { id: manager.positionId, companyId, rank: 1, isActive: true, isDepartmentHead: true, defaultDepartmentId: departmentId }]], [kanbanCards, [card]], [projects, [project]], [externalWaits, [wait]], [mergeIntents, [intent]], [taskRuns, [acceptedReview]]]);
  let mutations = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') { mutations++; assert.equal(JSON.parse(String(init.body)).head_commit_id, head); return new Response(null, { status: 204 }); }
    const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/collaborators/service/permission') ? { permission: 'admin' } : path.includes('/collaborators/') && path.endsWith('/permission') ? { permission: 'write', user: { is_admin: false } } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [{ rule_name: '[m]ain', created_at: '2026-09-05T00:00:00Z', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] }, { rule_name: '**', created_at: '2026-09-05T00:00:02Z', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [] }] : path.endsWith('/pulls/12') ? { number: 12, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' } } : { default_branch: 'main' };
    return new Response(JSON.stringify(value));
  };
  await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl });
  assert.equal(mutations, 0, 'review approval without a manager decision cannot call the provider');
  await requestManagerMerge({ companyId, agentId: manager.id, source: 'management' }, { action: 'merge_pr', intentId: intent.id, headSha: head, reason: 'Independent review accepted this exact candidate.' });
  for (const [table, row] of [[approvals, { id: 'a', cardId: card.id, status: 'pending' }], [reviewRounds, { id: 'r', cardId: card.id, status: 'open' }], [kanbanCards, { id: 'child', parentCardId: card.id, columnStatus: 'in_progress', childRequirementLevel: 'required' }]] as any[]) {
    state.rows(table).push(row); await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl }); assert.equal(mutations, 0); state.rows(table).splice(state.rows(table).indexOf(row), 1);
  }
  for (const key of ['autoMergeAfterApproval', 'completionRequiresMerge'] as const) { project[key] = false; await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl }); assert.equal(mutations, 0); project[key] = true; }
  card.requiresApproval = true;
  await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl });
  assert.equal(mutations, 0, 'required client approval needs a durable approved human gate');
  card.requiresApproval = false;
  const newReview = { id: 'new-review', cardId: card.id, kind: 'review', status: 'queued' };
  state.rows(taskRuns).push(newReview);
  await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl });
  assert.equal(mutations, 0, 'a newly queued review is a new gate');
  state.rows(taskRuns).pop();
  await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl });
  await (executor as any).executeAuthorizedMerge(wait.id, { fetchImpl });
  assert.equal(mutations, 1); assert.equal(intent.state, 'accepted'); assert.equal(intent.attemptCount, 1); assert.equal(card.columnStatus, 'waiting_on_external', 'HTTP acceptance is not completion proof');
});
