import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, kanbanCards, taskRuns, cardComments } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { dispatchCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { registerRoutes } from './routes.ts';

const progress = { kind: 'megacorps-report', status: 'progress', summary: 'The department child is still working; waiting for its verified delivery evidence.' };
function repair(actorId: string) { return { actorId, failures: 2, mode: 'fresh_context', sessionId: null, runKeys: ['previous-one', 'previous-two'], visitedActorIds: [actorId], fallbackId: null, updatedAt: new Date().toISOString() }; }
async function fixture(t: TestContext, helper = false) {
  const companyId = randomUUID(), state = memoryDb(t, []);
  const { headId, departmentId } = readyCompany(state, companyId);
  const actor = helper ? { id: randomUUID(), companyId, name: 'Worker', slug: 'worker', departmentId, bossId: headId, isActive: true, isBusy: false, adapterType: 'webhook' } : state.rows(agents).find(row => row.id === headId)!;
  if (helper) state.rows(agents).push(actor);
  const card: any = { id: randomUUID(), companyId, title: 'Verified department delivery', assigneeId: actor.id, columnStatus: 'todo', tags: [], dependencyCardIds: [], runRetryState: {}, protocolRepairState: {}, requiresApproval: false };
  state.rows(kanbanCards).push(card);
  const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-progress-webhook';
  t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
  const app = Fastify(); t.after(() => app.close()); await registerRoutes(app);
  const send = (payload: object) => app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-progress-webhook' }, payload });
  return { state, card, actor, headId, send };
}

for (const helper of [false, true]) test(`in-flight progress cannot replenish malformed dispatch budget (${helper ? 'one helper' : 'no helper'})`, async t => {
  const { state, card, actor, headId, send } = await fixture(t, helper);
  const sessions: Array<string | null | undefined> = [];
  let runId = '', previousRunId = '';
  t.mock.method(getAdapter('webhook'), 'dispatch', async (executionAgent: { currentSessionId?: string | null }) => {
    sessions.push(executionAgent.currentSessionId);
    if (previousRunId) {
      const before = structuredClone(card.protocolRepairState);
      const stale = await send({ cardId: card.id, taskRunId: previousRunId, status: 'done', report: { ...progress, status: 'completed' } });
      assert.equal(stale.statusCode, 200, stale.body);
      assert.deepEqual(card.protocolRepairState, before, 'a completed prior run cannot reset this run budget');
    }
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const response = await send({ cardId: card.id, taskRunId: runId, status: 'in_progress', report: progress });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(state.rows(taskRuns).find(row => row.id === runId)?.status, 'running', 'progress is accepted without finishing the adapter run');
    }
    return { success: true, output: '{"kind":"megacorps-report","status":"progress",}', sessionId: 'original-context', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    previousRunId = runId;
    const queued = state.rows(taskRuns).find(row => row.cardId === card.id && row.kind === 'dispatch' && row.status === 'queued');
    const run = queued ?? { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: actor.id, kind: 'dispatch', status: 'running' };
    if (!queued) state.rows(taskRuns).push(run);
    run.status = 'running'; runId = run.id;
    await dispatchCard(card.id, 'loop', { taskRunId: runId });
    assert.equal(card.protocolRepairState.dispatch.failures, attempt);
    assert.equal(card.protocolRepairState.dispatch.mode, attempt === 1 ? 'same_session' : attempt === 2 ? 'fresh_context' : helper ? 'escalated' : 'blocked');
    assert.deepEqual(card.runRetryState, {}, 'protocol failure does not spend transport retries');
  }
  assert.deepEqual(sessions.map(value => value ?? null), [null, 'original-context', null]);
  assert.equal(state.rows(taskRuns).filter(row => row.cardId === card.id && row.kind === 'dispatch' && row.status === 'queued').length, 0);
  const helpRuns = state.rows(taskRuns).filter(row => row.cardId === card.id && row.kind === 'review' && row.status === 'queued');
  assert.equal(helpRuns.length, helper ? 1 : 0);
  if (helper) assert.equal(helpRuns[0]?.agentId, headId);
  assert.equal(state.rows(cardComments).filter(row => row.action === 'protocol_help_required').length, 1);
});

for (const withRun of [false, true]) test(`accepted final webhook still clears only its repair kind (${withRun ? 'task run' : 'webhook only'})`, async t => {
  const { state, card, actor, send } = await fixture(t);
  card.columnStatus = 'in_progress';
  card.protocolRepairState = { dispatch: repair(actor.id), review: repair(randomUUID()) };
  const priorReview = structuredClone(card.protocolRepairState.review);
  const run = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: actor.id, kind: 'dispatch', status: 'running' };
  if (withRun) state.rows(taskRuns).push(run);
  const payload = { cardId: card.id, ...(withRun ? { taskRunId: run.id } : {}), status: 'done', report: { kind: 'megacorps-report', status: 'completed', summary: 'SELF-CHECK: Completed the standalone department report and verified all acceptance criteria against the attached report.' }, workProducts: [{ type: 'report', title: 'Verified report', summary: 'Concrete completed report and checks.' }] };
  const response = await send(payload);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(card.columnStatus, 'in_review', 'accepted author completion still requires independent review');
  assert.equal(card.protocolRepairState.dispatch.failures, 0);
  assert.deepEqual(card.protocolRepairState.review, priorReview);
  const after = structuredClone(card.protocolRepairState);
  const duplicate = await send(payload); assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(card.protocolRepairState, after);
});

test('a structurally rejected final callback cannot erase two prior protocol failures', async t => {
  const { state, card, actor, send } = await fixture(t);
  card.columnStatus = 'in_progress'; card.protocolRepairState.dispatch = repair(actor.id);
  const run = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: actor.id, kind: 'dispatch', status: 'running' };
  state.rows(taskRuns).push(run);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: { kind: 'megacorps-report', status: 'completed', summary: 'Completed the report but provided no required self-check or delivery evidence.' } });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(card.protocolRepairState.dispatch.failures, 3);
  assert.equal(card.protocolRepairState.dispatch.mode, 'blocked');
  assert.equal(state.rows(taskRuns).filter(row => row.kind === 'dispatch' && row.status === 'queued').length, 0);
});
