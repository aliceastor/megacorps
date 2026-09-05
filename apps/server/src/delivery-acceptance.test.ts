import assert from 'node:assert/strict';
import test from 'node:test';
import { approvals, kanbanCards, projects, workProducts, externalWaits, mergeIntents } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { acceptedDescendantEvidence, captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { guardedCompletionUpdate } from './completion-guard.ts';

test('management acceptance aggregates original descendant provenance and guarded completion rejects stale descendants', async (t) => {
  const parent: any = { id: 'boss-card', companyId: 'c', projectId: null, columnStatus: 'in_progress' };
  const head: any = { id: 'head-card', parentCardId: parent.id, companyId: 'c', projectId: null, columnStatus: 'done', assigneeId: 'head' };
  const child: any = { id: 'member-card', parentCardId: head.id, companyId: 'c', projectId: null, columnStatus: 'done', assigneeId: 'member' };
  memoryDb(t, [[kanbanCards, [parent, head, child]], [workProducts, [{ id: 'p', cardId: child.id, companyId: 'c', projectId: null, agentId: 'member', taskRunId: 'original-run', type: 'report', summary: 'Durable findings' }]]]);
  child.deliveryAcceptance = await captureDeliveryAcceptance(child);
  head.deliveryAcceptance = await captureDeliveryAcceptance(head);
  assert.ok(head.deliveryAcceptance, 'manager needs no duplicate authored artifact');
  assert.equal((await acceptedDescendantEvidence(parent)).products[0]?.taskRunId, 'original-run');
  child.assigneeId = 'replacement';
  assert.equal((await acceptedDescendantEvidence(parent)).ready, false);
  assert.equal(await guardedCompletionUpdate(parent, { columnStatus: 'done' }), undefined);
  assert.equal(parent.columnStatus, 'in_progress');
});

test('accepted child artifacts retain provenance, and reassign/reopen/evidence/gate changes invalidate inheritance', async (t) => {
  const parent: any = { id: 'parent', companyId: 'company', projectId: 'project' };
  const child: any = { id: 'child', companyId: 'company', projectId: 'project', parentCardId: 'parent', assigneeId: 'head', columnStatus: 'done', title: 'Report', body: 'Acceptance: answer', childRequirementLevel: 'required' };
  const product: any = { id: 'product', cardId: 'child', companyId: 'company', projectId: 'project', agentId: 'head', taskRunId: 'author-run', type: 'report', title: 'Durable report', url: 'https://example.test/report', summary: 'Verified answer' };
  const state = memoryDb(t, [[kanbanCards, [parent, child]], [projects, [{ id: 'project', companyId: 'company', completionRequiresMerge: false }]], [workProducts, [product]]]);
  child.deliveryAcceptance = await captureDeliveryAcceptance(child);
  const inherited = await acceptedDescendantEvidence(parent);
  assert.equal(inherited.ready, true); assert.equal(inherited.products[0]?.agentId, 'head'); assert.equal(inherited.products[0]?.taskRunId, 'author-run');
  for (const patch of [{ assigneeId: 'other' }, { columnStatus: 'todo' }, { body: 'Different brief' }, { projectId: 'other' }]) {
    const original = { ...child }; Object.assign(child, patch); assert.equal((await acceptedDescendantEvidence(parent)).ready, false); Object.assign(child, original);
  }
  product.summary = 'Replaced evidence'; assert.equal((await acceptedDescendantEvidence(parent)).ready, false); product.summary = 'Verified answer';
  state.rows(approvals).push({ id: 'pending', cardId: 'child', status: 'pending' }); assert.equal((await acceptedDescendantEvidence(parent)).ready, false);
});

test('managed child requires matching verified exact-head intent in addition to a successful wait', async (t) => {
  const child: any = { id: 'child', companyId: 'company', projectId: 'project', assigneeId: 'head', columnStatus: 'done' };
  const state = memoryDb(t, [[projects, [{ id: 'project', companyId: 'company', completionRequiresMerge: true, autoMergeAfterApproval: true }]], [workProducts, [{ id: 'p', cardId: 'child', companyId: 'company', projectId: 'project', agentId: 'head' }]], [externalWaits, [{ id: 'wait', companyId: 'company', cardId: 'child', provider: 'gitea', status: 'success', authorizedHeadSha: 'a'.repeat(40) }]]]);
  assert.equal(await captureDeliveryAcceptance(child), null);
  state.rows(mergeIntents).push({ id: 'intent', cardId: 'child', projectId: 'project', waitId: 'wait', state: 'verified', headSha: 'b'.repeat(40) });
  assert.equal(await captureDeliveryAcceptance(child), null);
  state.rows(mergeIntents)[0]!.headSha = 'a'.repeat(40);
  assert.equal((await captureDeliveryAcceptance(child))?.authorizedHeadSha, 'a'.repeat(40));
});
