import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, kanbanCards, machineRunners, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { reviewCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { isStructuredReviewerHelp, requestCardRecovery } from './card-recovery.ts';
import { normalizeAgentResult } from './agent-results.ts';

for (const transport of ['native', 'webhook', 'runner'])
  for (const scenario of ['help', 'needs_review_help', 'malformed', 'conflicting', 'mixed', 'recovery_help', 'stale_help']) {
    test(`${transport} reviewer ${scenario} distinguishes supervisor help from report correction`, async (t) => {
      const companyId = randomUUID();
      const boss = {
        id: randomUUID(),
        companyId,
        slug: 'boss',
        name: 'Boss',
        role: 'boss',
        isActive: true,
        isBusy: true,
        adapterType: 'webhook',
        capabilities: [],
      };
      const reviewer = { ...boss, id: randomUUID(), slug: 'reviewer', name: 'Reviewer', role: 'head', bossId: boss.id, isBusy: false };
      const author = { ...boss, id: randomUUID(), slug: 'author', name: 'Author', role: 'worker', isBusy: false };
      const card: any = {
        id: randomUUID(),
        companyId,
        title: 'Review the current evidence',
        body: 'Original goal',
        assigneeId: author.id,
        reviewerId: reviewer.id,
        columnStatus: 'in_review',
        runRetryState: {},
        tags: [],
      };
      const runnerId = randomUUID();
      const run = {
        id: randomUUID(),
        cardId: card.id,
        companyId,
        agentId: reviewer.id,
        kind: 'review',
        status: 'running',
        lockedBy: runnerId,
      };
      const priorProduct = {
        id: randomUUID(),
        cardId: card.id,
        companyId,
        type: 'document',
        title: 'Original evidence',
        body: 'Retain this evidence.',
      };
      const state = memoryDb(t, [
        [companies, [{ id: companyId }]],
        [agents, [boss, reviewer, author]],
        [kanbanCards, [card]],
        [taskRuns, [run]],
        [workProducts, [priorProduct]],
        [machineRunners, [{ id: runnerId, companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('review-help-fixture') }]],
      ]);
      const newHeartbeatId = randomUUID();
      const newDispatch = {
        id: randomUUID(), cardId: card.id, companyId, agentId: author.id, kind: 'dispatch', status: 'running',
        heartbeatRunId: newHeartbeatId, createdAt: new Date('2026-09-09T01:00:00Z'),
      };
      const activateNewDispatch = () => {
        card.columnStatus = 'in_progress';
        card.executionLockId = newHeartbeatId;
        card.executionLockedByAgentId = author.id;
        card.activeHeartbeatRunId = newHeartbeatId;
        state.rows(taskRuns).push(newDispatch);
      };
      if (scenario === 'recovery_help')
        await requestCardRecovery(card, {
          reason: 'Permission decision required',
          eventKey: 'permission-failure',
          actorId: author.id,
          stage: 'dispatch',
          permissionBlocked: true,
        });
      const report = {
        kind: 'megacorps-report',
        status: 'input_required',
        summary: 'I need the supervisor to clarify how to access the review evidence.',
        request: { kind: 'help', question: scenario === 'malformed' ? '' : 'Where is the review evidence available?' },
        ...(scenario === 'mixed' ? { verdict: 'approved' } : {}),
      };
      const conflict = { kind: 'megacorps-report', status: 'completed', summary: 'Contradictory approval', verdict: 'approved' };
      const output = scenario === 'conflicting' ? JSON.stringify(conflict) : undefined;
      if (scenario === 'needs_review_help') card.columnStatus = 'needs_review';
      if (scenario === 'stale_help' && transport !== 'native') activateNewDispatch();
      const app = Fastify();
      t.after(() => app.close());
      if (transport === 'native') {
        t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
          if (scenario === 'stale_help') activateNewDispatch();
          return {
            success: true,
            output: JSON.stringify(scenario === 'conflicting' ? { ...report, verdict: 'approved' } : report),
            sessionId: 'review-help-session',
            tokensUsed: 0,
            costUsd: 0,
            durationSeconds: 1,
          };
        });
        await reviewCard(card.id, { taskRunId: run.id });
      } else if (transport === 'runner') {
        await registerRunnerRoutes(app);
        const response = await app.inject({
          method: 'POST',
          url: `/api/runner/task-runs/${run.id}/complete`,
          headers: { 'x-megacorps-runner-key': 'review-help-fixture' },
          payload: { status: 'success', report, output },
        });
        if (scenario === 'help') assert.equal(response.statusCode, 200, response.body);
      } else {
        const previous = process.env.WEBHOOK_SHARED_SECRET;
        process.env.WEBHOOK_SHARED_SECRET = 'review-help-fixture';
        t.after(() => {
          if (previous === undefined) delete process.env.WEBHOOK_SHARED_SECRET;
          else process.env.WEBHOOK_SHARED_SECRET = previous;
        });
        await registerRoutes(app);
        const response = await app.inject({
          method: 'POST',
          url: '/api/webhook/task-complete',
          headers: { 'x-megacorps-webhook-secret': 'review-help-fixture' },
          payload: { cardId: card.id, taskRunId: run.id, status: 'needs_review', report, output },
        });
        if (scenario === 'help') assert.equal(response.statusCode, 200, response.body);
      }
      assert.deepEqual(state.rows(workProducts), [priorProduct]);
      assert.equal(card.assigneeId, author.id);
      assert.notEqual(card.columnStatus, 'done');
      if (scenario === 'stale_help') {
        assert.equal(card.columnStatus, 'in_progress');
        assert.equal(card.executionLockId, newHeartbeatId);
        assert.equal(card.activeHeartbeatRunId, newHeartbeatId);
        assert.equal(card.protocolRepairState?.recovery, undefined);
        assert.equal(newDispatch.status, 'running');
        assert.notEqual(run.status, 'running', 'only the stale review run is settled');
      } else if (scenario === 'help' || scenario === 'needs_review_help') {
        assert.equal(card.protocolRepairState?.review, undefined, 'Valid help is not a protocol failure');
        assert.equal(card.protocolRepairState?.recovery?.stage, 'review');
        assert.equal(card.protocolRepairState.recovery.originalReviewerId, reviewer.id);
        assert.equal(card.protocolRepairState.recovery.ownerId, boss.id);
        assert.equal(card.protocolRepairState.recovery.round, 1);
        assert.equal(card.reviewerId, boss.id);
        assert.equal(card.columnStatus, 'needs_review');
        assert.equal(run.status, 'success');
        assert.equal(boss.isBusy, true, 'Queued help cannot steal a busy manager capacity');
        assert.equal(state.rows(taskRuns).filter((r) => r.kind === 'review' && r.status === 'queued' && r.agentId === boss.id).length, 1);
      } else {
        if (scenario === 'recovery_help') {
          assert.equal(card.protocolRepairState.recovery.ownerId, reviewer.id);
          assert.equal(card.protocolRepairState.recovery.round, 1);
          assert.equal(card.protocolRepairState.recovery.permissionBlocked, true);
          assert.equal(state.rows(taskRuns).filter((r) => r.agentId === boss.id).length, 0);
        } else assert.equal(card.protocolRepairState?.recovery, undefined);
        assert.equal(card.protocolRepairState?.review?.failures, 1);
        assert.equal(card.reviewerId, reviewer.id);
        assert.equal(run.status, 'failed');
      }
    });
  }

for (const request of [
  { kind: 'permission', question: 'Authorize the repository write.' },
  { kind: 'human', question: 'Human decision needed.' },
]) {
  test(`structured reviewer help excludes ${request.kind} requests`, () => {
    const result = normalizeAgentResult({
      report: { kind: 'megacorps-report', status: 'input_required', summary: 'A decision is required.', request },
    });
    assert.equal(isStructuredReviewerHelp(result), false);
  });
}
