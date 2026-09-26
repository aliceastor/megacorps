import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, kanbanCards, machineRunners, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { getAdapter } from './adapters/registry.ts';
import { buildReviewPrompt, buildTaskPrompt, dispatchCard, reviewCard } from './dispatch.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';

type Kind = 'dispatch' | 'review';
function fixture(t: TestContext, kind: Kind) {
  const companyId = randomUUID(), state = memoryDb(t, []);
  const { bossId, headId, departmentId } = readyCompany(state, companyId);
  const worker = { id: randomUUID(), companyId, name: 'Worker', slug: 'worker', departmentId, bossId: headId, adapterType: 'webhook', isActive: true, isBusy: false };
  state.rows(agents).push(worker);
  const actor = kind === 'review' ? state.rows(agents).find(row => row.id === bossId)! : worker;
  const card: any = { id: randomUUID(), companyId, projectId: null, title: 'Deliver the documented acceptance result', body: '## Acceptance\nUse the submitted evidence for the current assignment.', assigneeId: worker.id, reviewerId: kind === 'review' ? actor.id : headId, columnStatus: kind === 'review' ? 'in_review' : 'todo', tags: [], dependencyCardIds: [], protocolRepairState: {}, runRetryState: {} };
  state.rows(kanbanCards).push(card);
  function currentRun() {
    const queued = state.rows(taskRuns).find(row => row.cardId === card.id && row.kind === kind && row.status === 'queued');
    const run = queued ?? { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind, status: 'running', lockedBy: 'runner' };
    if (!queued) state.rows(taskRuns).push(run);
    run.status = 'running'; run.lockedBy = 'runner';
    return run;
  }
  const report = { kind: 'megacorps-report', status: 'completed', summary: 'Current rejected report includes the verified artifact and exact revision.', verdict: 'revision_requested', score: '3', artifactRefs: ['release.apk@sha256:current-head'], workProducts: [{ type: 'report', title: 'Recorded checks', url: 'https://artifacts.example.test/current-checks' }] };
  return { state, card, actor, currentRun, report };
}

for (const kind of ['dispatch', 'review'] as const) test(`actual ${kind} retries carry only the latest failed report and clear after accepted correction`, async t => {
  const { state, card, actor, currentRun, report } = fixture(t, kind);
  const first = { ...report, summary: 'Earlier failed format with a superseded intended decision.', verdict: 'approved', score: '8' };
  const second = { ...report };
  const corrected = { ...second, score: 3 };
  const replies = [first, second, corrected];
  const seen: Array<{ body: string; session: string | null | undefined }> = [];
  t.mock.method(getAdapter('webhook'), 'dispatch', async (executionAgent: { currentSessionId?: string | null }, task: { body?: string }) => {
    const index = seen.length;
    seen.push({ body: task.body ?? '', session: executionAgent.currentSessionId });
    return { success: true, output: `private transcript\n\n\`\`\`megacorps-report\n${JSON.stringify(replies[index])}\n\`\`\``, sessionId: 'repair-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = currentRun();
    if (kind === 'dispatch') await dispatchCard(card.id, 'manual', { taskRunId: run.id });
    else await reviewCard(card.id, { taskRunId: run.id });
    if (attempt < 2) {
      assert.equal(card.protocolRepairState[kind].rejectedReport, JSON.stringify(replies[attempt]));
      assert.match(card.protocolRepairState[kind].reason, /score.*received string/);
      assert.equal(run.status, 'failed');
    }
  }
  assert.equal(seen.length, 3);
  assert.doesNotMatch(seen[0]!.body, /Reporting correction for this assignment/);
  assert.ok(seen[1]!.body.includes(JSON.stringify(first)));
  assert.ok(seen[2]!.body.includes(JSON.stringify(second)));
  assert.ok(!seen[2]!.body.includes(JSON.stringify(first)), 'fresh repair cannot reinject the earlier approval or score');
  assert.deepEqual(seen.map(item => item.session ?? null), [null, 'repair-session', null]);
  assert.doesNotMatch(seen[1]!.body, /private transcript/);
  assert.equal(card.protocolRepairState[kind].mode, 'clear');
  assert.equal(card.protocolRepairState[kind].failures, 0);
  assert.equal(card.columnStatus, kind === 'review' ? 'todo' : 'in_review', 'format correction never revives the earlier approval or bypasses independent review');
  const clearPrompt = await (kind === 'review' ? buildReviewPrompt : buildTaskPrompt)(card);
  assert.doesNotMatch(clearPrompt, /^Reporting correction for this assignment/);
  assert.equal(state.rows(taskRuns).filter(row => row.agentId === actor.id && /agent_report_invalid/.test(row.error ?? '')).length, 2);
});

for (const via of ['runner', 'webhook'] as const) {
  for (const scenario of ['dispatch', 'review', 'recovery'] as const) {
    const kind = scenario === 'dispatch' ? 'dispatch' : 'review';
    for (const form of ['report', 'output'] as const) {
      test(`${via} ${scenario} ${form} validation failure retains its submitted report for the actual retry`, async t => {
        const { state, card, actor, currentRun, report } = fixture(t, kind);
        if (scenario === 'recovery') {
          card.columnStatus = 'needs_review';
          card.protocolRepairState.recovery = { mode: 'awaiting_manager', ownerId: actor.id, originalAssigneeId: card.assigneeId, originalReviewerId: null, stage: 'dispatch', reason: 'Original worker needs routing guidance.', round: 1, handledEventKeys: ['original-failure'], visitedOwnerIds: [actor.id], updatedAt: new Date().toISOString() };
        }
        const run = currentRun();
        const app = Fastify(); t.after(() => app.close());
        const payload = form === 'report' ? { report } : { output: `private transport transcript\n\n\`\`\`megacorps-report\n${JSON.stringify(report)}\n\`\`\`` };
        if (via === 'runner') {
          state.rows(machineRunners).push({ id: 'runner', companyId: card.companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-repair-runner') });
          await registerRunnerRoutes(app);
          const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${run.id}/complete`, headers: { 'x-megacorps-runner-key': 'synthetic-repair-runner' }, payload: { status: 'success', ...payload } });
          assert.equal(response.statusCode, scenario === 'recovery' ? 409 : 200, response.body);
        } else {
          const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-repair-webhook';
          t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
          await registerRoutes(app);
          const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-repair-webhook' }, payload: { cardId: card.id, taskRunId: run.id, status: 'done', ...payload } });
          assert.equal(response.statusCode, 409, response.body);
        }
        assert.equal(card.protocolRepairState[kind].rejectedReport, JSON.stringify(report));
        assert.match(card.protocolRepairState[kind].reason, /score.*received string/);
        let prompt = '';
        t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: { body?: string }) => { prompt = task.body ?? ''; return { success: true, output: JSON.stringify(report), sessionId: 'retry', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
        const retry = currentRun();
        if (kind === 'dispatch') await dispatchCard(card.id, 'manual', { taskRunId: retry.id });
        else await reviewCard(card.id, { taskRunId: retry.id });
        assert.ok(prompt.includes(JSON.stringify(report)));
        assert.match(prompt, /score.*received string/);
        assert.doesNotMatch(prompt, /private transport transcript/);
        if (scenario === 'recovery') assert.match(prompt, /Recovery review, round 1\/3/);
      });
    }
  }
}
