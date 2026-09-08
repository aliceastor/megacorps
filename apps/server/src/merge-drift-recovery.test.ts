import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, approvals, companies, kanbanCards, mergeIntents, machineRunners, projects, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { noteMergeEvidenceRequired } from './merge-gate.ts';
import { applyRecoveryReport, finishHumanRecovery } from './card-recovery.ts';
import { reviewRounds } from './db/schema.ts';
import { reviewCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';

const plan = {
  disposition: 'blocked' as const,
  reason: 'head_drift' as const,
  detail: 'The reported/reviewed commit differs from the provider head. Review the current head before authorizing it.',
};
function fixture(t: any) {
  const companyId = randomUUID();
  const author: any = { id: randomUUID(), companyId, name: 'Author', slug: 'author', isActive: true };
  const reviewer: any = { id: randomUUID(), companyId, name: 'Reviewer', slug: 'reviewer', isActive: true };
  const boss: any = { id: randomUUID(), companyId, name: 'Boss', slug: 'boss', isActive: true, isBusy: true };
  reviewer.bossId = boss.id;
  const card: any = {
    id: randomUUID(),
    companyId,
    title: 'Review exact current head',
    columnStatus: 'in_review',
    assigneeId: author.id,
    reviewerId: reviewer.id,
    runRetryState: {},
    protocolRepairState: {},
    reviewIdentity: { id: 'original-review', headSha: 'a'.repeat(40) },
  };
  const evidence: any = {
    id: randomUUID(),
    cardId: card.id,
    companyId,
    type: 'commit',
    title: 'Reported commit',
    metadata: { sha: 'a'.repeat(40) },
  };
  const state = memoryDb(t, [
    [companies, [{ id: companyId }]],
    [agents, [author, reviewer, boss]],
    [kanbanCards, [card]],
    [workProducts, [evidence]],
  ]);
  return { card, reviewer, boss, state, evidence };
}
test('repeated exact same head drift uses bounded recovery instead of unlimited ordinary reviews', async (t) => {
  const { card, reviewer, boss, state, evidence } = fixture(t);
  const originalEvidence = structuredClone(evidence);
  await noteMergeEvidenceRequired(card, plan);
  assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.reviewerId, boss.id);
  assert.equal(card.protocolRepairState.recovery.stage, 'review');
  assert.equal(card.protocolRepairState.recovery.originalReviewerId, reviewer.id);
  assert.equal(card.protocolRepairState.recovery.round, 1);
  const queued = state.rows(taskRuns).filter((r) => r.status === 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.agentId, boss.id);
  await noteMergeEvidenceRequired(structuredClone(card), plan);
  assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.protocolRepairState.recovery.round, 1);
  assert.equal(state.rows(taskRuns).length, 1);
  await applyRecoveryReport(card, boss.id, {
    kind: 'megacorps-report',
    version: 1,
    status: 'completed',
    summary: 'Review current evidence',
    recovery: {
      action: 'rework',
      reason: 'The review used a stale commit',
      instructions: 'Review the real provider head and report its exact SHA',
    },
  });
  assert.equal(card.reviewerId, reviewer.id);
  assert.equal(card.columnStatus, 'in_review');
  card.reviewIdentity = { id: 'second-review', headSha: 'a'.repeat(40) };
  await noteMergeEvidenceRequired(card, plan);
  assert.equal(card.protocolRepairState.recovery.mode, 'awaiting_human');
  assert.equal(card.protocolRepairState.recovery.round, 1);
  assert.equal(state.rows(approvals).filter((r) => r.status === 'pending' && r.payload?.humanGate).length, 1);
  assert.deepEqual(state.rows(workProducts), [originalEvidence]);
  assert.equal(state.rows(mergeIntents).length, 0);
  assert.notEqual(card.columnStatus, 'done');
});
for (const decision of ['manager', 'human'])
  test(`head drift ${decision} guidance reopens required panel before ordinary review`, async (t) => {
    const { card, reviewer, boss, state } = fixture(t);
    card.reviewMode = 'panel';
    card.reviewerIds = [reviewer.id];
    card.reviewRound = 1;
    for (const agent of state.rows(agents)) agent.adapterType = 'webhook';
    state
      .rows(reviewRounds)
      .push({
        id: randomUUID(),
        cardId: card.id,
        companyId: card.companyId,
        kind: 'panel',
        status: 'closed',
        round: 1,
        reviewerIds: [reviewer.id],
      });
    await noteMergeEvidenceRequired(card, plan);
    const report: any = {
      kind: 'megacorps-report',
      status: 'completed',
      summary: 'Review current head',
      recovery: {
        action: decision === 'human' ? 'raise_to_human' : 'rework',
        reason: 'Review was stale',
        instructions: 'Review the current provider head independently',
      },
    };
    let result = await applyRecoveryReport(card, boss.id, report);
    if (decision === 'human') {
      assert.equal(state.rows(reviewRounds).filter((r) => r.status === 'open').length, 0);
      const gate = state.rows(approvals).find((r) => r.status === 'pending' && r.payload?.kind === 'recovery');
      result = await finishHumanRecovery(card, gate!.id, randomUUID(), {
        status: 'approved',
        instructions: 'Repeat the independent panel against current provider head',
      });
    }
    assert.equal(result?.continueKind, null, 'ordinary reviewer must not bypass the required panel');
    const fresh = state.rows(reviewRounds).filter((r) => r.status === 'open');
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.round, 2);
    assert.equal(card.protocolRepairState.recovery.originalReviewerId, reviewer.id);
    assert.equal(state.rows(mergeIntents).length, 0);
    assert.notEqual(card.columnStatus, 'done');
  });

for (const guard of ['human', 'accepted_merge', 'stale_run'])
  test(`head drift recovery preserves ${guard} authority`, async (t) => {
    const { card, reviewer, state } = fixture(t);
    let taskRunId: string | undefined;
    if (guard === 'human')
      state
        .rows(approvals)
        .push({ id: randomUUID(), cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
    if (guard === 'accepted_merge') state.rows(mergeIntents).push({ id: randomUUID(), cardId: card.id, state: 'accepted' });
    if (guard === 'stale_run') {
      taskRunId = randomUUID();
      state
        .rows(taskRuns)
        .push({ id: taskRunId, cardId: card.id, companyId: card.companyId, agentId: reviewer.id, kind: 'review', status: 'success' });
    }
    const before = structuredClone(card);
    await noteMergeEvidenceRequired(card, plan, taskRunId);
    assert.deepEqual(card, before);
    assert.equal(state.rows(taskRuns).filter((r) => r.status === 'queued').length, 0);
  });

for (const transport of ['native', 'webhook', 'runner'])
  test(`${transport} head drift settles source review before bounded recovery queue`, async (t) => {
    const { card, reviewer, boss, state, evidence } = fixture(t);
    const project = {
      id: randomUUID(),
      companyId: card.companyId,
      repoProvider: 'gitea-local',
      repoUrl: 'https://gitea.test/org/repo',
      defaultBranch: 'main',
      completionRequiresMerge: true,
    };
    card.projectId = project.id;
    card.requiresApproval = false;
    card.tags = [];
    card.dependencyCardIds = [];
    Object.assign(reviewer, { adapterType: 'webhook', isBusy: false, capabilities: [] });
    Object.assign(evidence, {
      type: 'pull_request',
      projectId: project.id,
      url: 'https://gitea.test/org/repo/pulls/12',
      commitSha: 'a'.repeat(40),
    });
    state.rows(projects).push(project);
    const runnerId = randomUUID();
    const run = {
      id: randomUUID(),
      cardId: card.id,
      companyId: card.companyId,
      agentId: reviewer.id,
      kind: 'review',
      status: 'running',
      lockedBy: runnerId,
    };
    state.rows(taskRuns).push(run);
    state
      .rows(machineRunners)
      .push({ id: runnerId, companyId: card.companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('drift-runner-fixture') });
    const previous = {
      GITEA_URL: process.env.GITEA_URL,
      GITEA_ADMIN_TOKEN: process.env.GITEA_ADMIN_TOKEN,
      WEBHOOK_SHARED_SECRET: process.env.WEBHOOK_SHARED_SECRET,
    };
    process.env.GITEA_URL = 'https://gitea.test';
    process.env.GITEA_ADMIN_TOKEN = 'fixture-token';
    process.env.WEBHOOK_SHARED_SECRET = 'drift-webhook-fixture';
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    let mutations = 0;
    t.mock.method(globalThis, 'fetch', async (_url: any, init?: any) => {
      if (init?.method === 'POST') mutations++;
      return new Response(
        JSON.stringify({ number: 12, state: 'open', merged: false, head: { sha: 'b'.repeat(40), ref: 'feature' }, base: { ref: 'main' } }),
      );
    });
    const report = {
      kind: 'megacorps-report',
      status: 'completed',
      summary: 'Reviewed the supplied repository evidence and approve it.',
      verdict: 'approved',
    };
    const app = Fastify();
    t.after(() => app.close());
    if (transport === 'native') {
      t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({
        success: true,
        output: JSON.stringify(report),
        sessionId: 'review-drift',
        tokensUsed: 0,
        costUsd: 0,
        durationSeconds: 1,
      }));
      await reviewCard(card.id, { taskRunId: run.id });
    } else if (transport === 'webhook') {
      await registerRoutes(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhook/task-complete',
        headers: { 'x-megacorps-webhook-secret': 'drift-webhook-fixture' },
        payload: { cardId: card.id, taskRunId: run.id, status: 'done', report },
      });
      assert.equal(response.statusCode, 200, response.body);
    } else {
      await registerRunnerRoutes(app);
      const response = await app.inject({
        method: 'POST',
        url: `/api/runner/task-runs/${run.id}/complete`,
        headers: { 'x-megacorps-runner-key': 'drift-runner-fixture' },
        payload: { status: 'success', report },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(run.status, 'success');
    assert.equal(card.columnStatus, 'needs_review');
    assert.equal(card.protocolRepairState.recovery.originalReviewerId, reviewer.id);
    assert.equal(card.protocolRepairState.recovery.stage, 'review');
    assert.equal(state.rows(taskRuns).filter((r) => r.kind === 'review' && r.status === 'queued' && r.agentId === boss.id).length, 1);
    assert.equal(evidence.commitSha, 'a'.repeat(40));
    assert.equal(state.rows(mergeIntents).length, 0);
    assert.equal(mutations, 0);
  });
