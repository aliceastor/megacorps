import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { agents, cardComments, companies, departments, kanbanCards, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { completeMessageTaskRunFromWebhook, sweepPeerQuestions } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';

test('delegated help routes to responsible head and resumes the original thread once after an answer', async (t) => {
  const card: any = { id: 'card', companyId: 'company', assigneeId: 'head', title: 'Build', columnStatus: 'in_progress', runRetryState: {}, tags: [] };
  const request: any = { id: 'request', cardId: 'card', agentId: 'head', action: 'delegate_request', body: 'Deliver artifact', assigneeAgentId: 'worker', reviewerAgentId: 'head', reviewerScope: 'final', delegationStatus: 'running' };
  const run = { id: 'run', cardId: 'card', companyId: 'company', agentId: 'worker', messageCommentId: 'request', kind: 'message', status: 'running' };
  const state = memoryDb(t, [[companies, [{ id: 'company', name: 'Acme' }]], [kanbanCards, [card]], [cardComments, [request]], [taskRuns, [run]], [departments, [{ id: 'department', companyId: 'company', name: 'Engineering', headAgentId: 'head' }]], [agents, [{ id: 'head', companyId: 'company', name: 'Head', slug: 'head', departmentId: 'department', adapterType: 'webhook', isActive: true, isBusy: false }, { id: 'worker', companyId: 'company', name: 'Worker', slug: 'worker', departmentId: 'department', adapterType: 'webhook', isActive: true, isBusy: false }]]]);
  const input: any = { status: 'needs_review', report: { kind: 'megacorps-report', status: 'input_required', summary: 'Need scope guidance', request: { kind: 'help', question: 'Which existing format is authoritative?' } } };
  await completeMessageTaskRunFromWebhook('run', input);
  await completeMessageTaskRunFromWebhook('run', input);
  const questions = state.rows(cardComments).filter(row => row.action === 'agent_question');
  assert.equal(questions.length, 1); assert.equal(questions[0]!.assigneeAgentId, 'head'); assert.equal(questions[0]!.parentCommentId, 'request');
  assert.equal(request.delegationStatus, 'waiting'); assert.equal(run.status, 'success');
  const app = Fastify(); t.after(() => app.close());
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'Use the existing v2 report format described in the company charter.', sessionId: 'help-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await sweepPeerQuestions(app); await sweepPeerQuestions(app);
  const queued = state.rows(taskRuns).filter(row => row.kind === 'message' && row.status === 'queued');
  assert.equal(queued.length, 1); assert.equal(queued[0]!.agentId, 'worker'); assert.equal(queued[0]!.messageCommentId, 'request');
  assert.equal(request.assigneeAgentId, 'worker'); assert.notEqual(request.delegationStatus, 'approved'); assert.notEqual(card.columnStatus, 'done');
});
