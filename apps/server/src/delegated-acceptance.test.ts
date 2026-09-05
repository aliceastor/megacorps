import assert from 'node:assert/strict';
import test from 'node:test';
import { cardComments, kanbanCards, workProducts, agents, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { acceptDelegatedDelivery, acceptedDelegatedProducts } from './delegated-acceptance.ts';
import { reviewMessageDelegation } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
test('failed returned message review cannot approve a report even when output contains an approval verdict', async t => {
  const card: any = { id: 'card', companyId: 'company', title: 'Deliver', body: 'Acceptance: works', assigneeId: 'head', columnStatus: 'in_progress', tags: [] };
  const report: any = { id: 'report', cardId: 'card', parentCommentId: 'request', action: 'delegate_report', body: 'Evidence', assigneeAgentId: 'worker', reviewerAgentId: 'head', delegationStatus: 'submitted', reviewerScope: 'final' };
  memoryDb(t, [[kanbanCards, [card]], [agents, [{ id: 'head', companyId: 'company', name: 'Head', slug: 'head', adapterType: 'webhook', isActive: true, isBusy: false }]], [cardComments, [{ id: 'request', cardId: 'card', action: 'delegate_request', body: 'Deliver', assigneeAgentId: 'worker', reviewerAgentId: 'head', delegationStatus: 'submitted' }, report]], [taskRuns, [{ id: 'review-run', companyId: 'company', cardId: 'card', agentId: 'head', messageCommentId: 'report', kind: 'message_review', status: 'running' }]]]);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: false, output: 'VERDICT: APPROVED\nTransport failed before verification.', sessionId: 'review', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewMessageDelegation('card', { taskRunId: 'review-run' });
  assert.notEqual(report.delegationStatus, 'approved'); assert.equal(report.acceptedDelivery, undefined);
});
test('only server-accepted delegated reports contribute current original worker evidence', async (t) => {
  const card: any = { id: 'c', companyId: 'co', projectId: null, assigneeId: 'head' };
  const request: any = { id: 'request', cardId: 'c', action: 'delegate_request', agentId: 'head', assigneeAgentId: 'worker', reviewerAgentId: 'head', delegationStatus: 'approved', body: 'Build' };
  const report: any = { id: 'report', cardId: 'c', parentCommentId: 'request', action: 'delegate_report', agentId: 'worker', assigneeAgentId: 'worker', reviewerAgentId: 'head', delegationStatus: 'approved', body: 'Verified report', metadata: { taskRunId: 'run' } };
  const product: any = { id: 'p', cardId: 'c', companyId: 'co', projectId: null, agentId: 'worker', taskRunId: 'run', type: 'report', summary: 'Concrete evidence' };
  memoryDb(t, [[kanbanCards, [card]], [cardComments, [request, report]], [workProducts, [product]], [taskRuns, [{ id: 'run', companyId: 'co', cardId: 'c', agentId: 'worker', kind: 'message', messageCommentId: 'request', status: 'success' }]], [agents, [{ id: 'worker', companyId: 'co' }, { id: 'head', companyId: 'co' }]]]);
  report.metadata.acceptedDelivery = 'operator-lookalike-proof';
  assert.deepEqual(await acceptedDelegatedProducts(card), []);
  await acceptDelegatedDelivery(card, report.id);
  assert.equal((await acceptedDelegatedProducts(card))[0]?.agentId, 'worker');
  request.assigneeAgentId = 'other'; assert.deepEqual(await acceptedDelegatedProducts(card), []);
  request.assigneeAgentId = 'worker'; product.summary = 'Replaced'; assert.deepEqual(await acceptedDelegatedProducts(card), []);
});
