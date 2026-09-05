import assert from 'node:assert/strict';
import test from 'node:test';
import * as executor from './authorized-merge.ts';
import { memoryDb } from './test-support/memory-db.ts';
import * as schema from './db/schema.ts';

const head = 'a'.repeat(40);
test('durable merge claim rechecks every gate and policy before one exact-head attempt', async (t) => {
  assert.equal(typeof (executor as any).executeAuthorizedMerge, 'function');
  const { kanbanCards, projects, externalWaits, approvals, reviewRounds, mergeIntents, taskRuns } = schema as any;
  const old = process.env.GITEA_URL, token = process.env.GITEA_ADMIN_TOKEN;
  process.env.GITEA_URL = 'https://gitea.test'; process.env.GITEA_ADMIN_TOKEN = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = old; if (token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = token; });
  const project = { id: 'p', autoMergeAfterApproval: true, completionRequiresMerge: true, repoProvider: 'gitea-local', managedRepoFullName: 'org/repo', repoUrl: 'https://gitea.test/org/repo', defaultBranch: 'main' };
  const card = { id: 'c', projectId: 'p', companyId: 'co', columnStatus: 'waiting_on_external', mergeGateVersion: 1, requiresApproval: false };
  const wait = { id: 'w', cardId: 'c', companyId: 'co', status: 'waiting', provider: 'gitea', authorizedHeadSha: head, externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12' };
  const intent = { id: 'i', waitId: 'w', cardId: 'c', projectId: 'p', headSha: head, repoFullName: 'org/repo', defaultBranch: 'main', gateVersion: 1, state: 'prepared', attemptCount: 0 };
  const state = memoryDb(t, [[kanbanCards, [card]], [projects, [project]], [externalWaits, [wait]], [mergeIntents, [intent]]]);
  let mutations = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') { mutations++; assert.equal(JSON.parse(String(init.body)).head_commit_id, head); return new Response(null, { status: 204 }); }
    const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: 'admin' } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [{ rule_name: 'main', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] }] : path.endsWith('/pulls/12') ? { number: 12, state: 'open', merged: false, head: { sha: head }, base: { ref: 'main' } } : { default_branch: 'main' };
    return new Response(JSON.stringify(value));
  };
  for (const [table, row] of [[approvals, { id: 'a', cardId: 'c', status: 'pending' }], [reviewRounds, { id: 'r', cardId: 'c', status: 'open' }], [kanbanCards, { id: 'child', parentCardId: 'c', columnStatus: 'in_progress', childRequirementLevel: 'required' }]] as any[]) {
    state.rows(table).push(row); await (executor as any).executeAuthorizedMerge('w', { fetchImpl }); assert.equal(mutations, 0); state.rows(table).splice(state.rows(table).indexOf(row), 1);
  }
  for (const key of ['autoMergeAfterApproval', 'completionRequiresMerge'] as const) { project[key] = false; await (executor as any).executeAuthorizedMerge('w', { fetchImpl }); assert.equal(mutations, 0); project[key] = true; }
  card.requiresApproval = true;
  await (executor as any).executeAuthorizedMerge('w', { fetchImpl });
  assert.equal(mutations, 0, 'required client approval needs a durable approved human gate');
  card.requiresApproval = false;
  const newReview = { id: 'new-review', cardId: 'c', kind: 'review', status: 'queued' };
  state.rows(taskRuns).push(newReview);
  await (executor as any).executeAuthorizedMerge('w', { fetchImpl });
  assert.equal(mutations, 0, 'a newly queued review is a new gate');
  state.rows(taskRuns).pop();
  await (executor as any).executeAuthorizedMerge('w', { fetchImpl });
  await (executor as any).executeAuthorizedMerge('w', { fetchImpl });
  assert.equal(mutations, 1); assert.equal(intent.state, 'accepted'); assert.equal(intent.attemptCount, 1); assert.equal(card.columnStatus, 'waiting_on_external', 'HTTP acceptance is not completion proof');
});
