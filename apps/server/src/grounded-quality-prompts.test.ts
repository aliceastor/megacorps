import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, kanbanCards, taskRuns, cardComments, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { dispatchCard, buildReviewPrompt, reviewMessageDelegation } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import type { TaskContext } from './adapters/hermes.ts';

function fixture(t: TestContext) {
  const companyId = randomUUID(), state = memoryDb(t, []);
  const { bossId, headId, departmentId } = readyCompany(state, companyId);
  const worker = { id: randomUUID(), companyId, name: 'Worker', slug: 'worker', departmentId, bossId: headId, adapterType: 'webhook', isActive: true, isBusy: false };
  state.rows(agents).push(worker);
  const card: any = { id: randomUUID(), companyId, projectId: null, title: 'Explain the assigned process', body: '## Acceptance\nExplain the actual process using the supplied evidence, with usable steps.', assigneeId: worker.id, reviewerId: headId, columnStatus: 'in_review', tags: [], dependencyCardIds: [], protocolRepairState: {}, runRetryState: {} };
  state.rows(kanbanCards).push(card);
  return { state, card, worker, bossId, headId };
}
function assertGrounding(prompt: string) {
  assert.match(prompt, /distinguish proposed.*assumptions from verified.*facts/i);
  assert.match(prompt, /tools, repositories.*attachments/i);
  assert.match(prompt, /preserve.*uncertainty.*child scope/i);
  assert.match(prompt, /ordinary choices.*do not require.*client/i);
}
function assertInspection(prompt: string) {
  assert.match(prompt, /inspect the actual current artifact.*content/i);
  assert.match(prompt, /cite.*path.*revision.*concrete checks/i);
  assert.match(prompt, /author summaries.*prior verdicts.*merge status.*insufficient/i);
  assert.match(prompt, /inaccessible.*missing verification.*(?:help|correction)/i);
  assert.match(prompt, /read-only.*do not execute.*unsafe/i);
}
function assertAssessmentLimits(prompt: string) {
  assert.match(prompt, /server-accepted.*not.*content verification/i);
  assert.match(prompt, /cite.*reviewer.*checks/i);
  assert.match(prompt, /preserve.*limitations/i);
  assert.match(prompt, /eligible head or reviewer/i);
  assert.match(prompt, /(?:must not|never) clone.*(?:run tests|test)/i);
  assert.match(prompt, /not.*independent.*(?:QA|quality review)/i);
  assert.doesNotMatch(prompt, /Inspect the actual current artifact/i, 'Boss is not made the professional artifact reviewer');
}

for (const role of ['boss', 'head'] as const) test(`${role} actual dispatch prompt keeps delegation assumptions distinct from facts`, async t => {
  const { state, card, bossId, headId } = fixture(t);
  card.assigneeId = role === 'boss' ? bossId : headId; card.reviewerId = null; card.columnStatus = 'todo';
  const run = { id: randomUUID(), cardId: card.id, companyId: card.companyId, agentId: card.assigneeId, kind: 'dispatch', status: 'running' };
  state.rows(taskRuns).push(run);
  let prompt = '';
  // Fixed transport response; this test inspects generated instructions, not simulated LLM compliance.
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: TaskContext) => { prompt = task.body ?? ''; return { success: true, output: '{"kind":"megacorps-report","status":"progress","summary":"The bounded planning work is underway."}', sessionId: 'fixed', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assertGrounding(prompt);
  assert.match(prompt, /required execution must be delegated/);
});

for (const continuation of [false, true]) test(`ordinary ${continuation ? 'continued' : 'fresh'} QA prompt requires actual artifact inspection`, async t => {
  const { card } = fixture(t);
  assertInspection(await buildReviewPrompt(card, { continuation }));
});

for (const boss of [false, true]) test(`${boss ? 'Boss assessment' : 'professional QA'} message review gets its own evidence duty`, async t => {
  const { state, card, worker, headId, bossId } = fixture(t);
  card.columnStatus = 'in_progress';
  const request = { id: randomUUID(), cardId: card.id, action: 'delegate_request', body: '## Acceptance\nRead the supplied report and identify the actual process.', assigneeAgentId: worker.id, reviewerAgentId: boss ? bossId : headId, reviewerScope: 'phase', delegationStatus: 'submitted' };
  const report = { ...request, id: randomUUID(), parentCommentId: request.id, action: 'delegate_report', body: 'The assigned process is documented at the supplied artifact.' };
  const run = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: request.reviewerAgentId, kind: 'message_review', status: 'running', messageCommentId: report.id };
  state.rows(cardComments).push(request, report); state.rows(taskRuns).push(run);
  let prompt = '';
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: TaskContext) => { prompt = task.body ?? ''; return { success: true, output: '{"kind":"megacorps-report","status":"completed","summary":"Fixed synthetic review response for prompt capture.","verdict":"approved"}', sessionId: 'fixed-review', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  await reviewMessageDelegation(card.id, { taskRunId: run.id });
  if (boss) assertAssessmentLimits(prompt); else assertInspection(prompt);
});

test('Boss review distinguishes inherited acceptance from independent content verification', async t => {
  const { card, bossId } = fixture(t); card.reviewerId = bossId;
  assertAssessmentLimits(await buildReviewPrompt(card));
});

test('actual Boss integration prompt limits claims even when descendant evidence is accepted', async t => {
  const { state, card, bossId, headId } = fixture(t);
  card.assigneeId = bossId; card.reviewerId = null; card.columnStatus = 'in_progress'; card.rollupStatus = 'integrating';
  const child: any = { id: randomUUID(), companyId: card.companyId, parentCardId: card.id, projectId: null, title: 'Completed department result', assigneeId: headId, columnStatus: 'done' };
  state.rows(kanbanCards).push(child);
  state.rows(workProducts).push({ id: randomUUID(), companyId: card.companyId, cardId: child.id, projectId: null, agentId: headId, type: 'report', title: 'Department evidence', summary: 'Concrete evidence from the completed department assignment.', url: 'https://artifacts.example.test/report' });
  child.deliveryAcceptance = await captureDeliveryAcceptance(child); assert.ok(child.deliveryAcceptance);
  const run = { id: randomUUID(), cardId: card.id, companyId: card.companyId, agentId: bossId, kind: 'dispatch', status: 'running' };
  state.rows(taskRuns).push(run);
  let prompt = '';
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: TaskContext) => { prompt = task.body ?? ''; return { success: true, output: '{"kind":"megacorps-report","status":"progress","summary":"Fixed synthetic integration response for prompt capture."}', sessionId: 'fixed-integration', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.match(prompt, /All required descendant evidence and gates are current and server-accepted/);
  assertAssessmentLimits(prompt);
});
