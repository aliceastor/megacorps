import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, approvals, cardComments, companyMemberships, kanbanCards, machineRunners, projects, reviewRounds, taskRuns, users, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { signSession } from './auth.ts';
import { reviewCard } from './dispatch.ts';
import { tryCloseRound } from './review-rounds.ts';

for (const via of ['auto_review', 'webhook', 'runner', 'human', 'manual', 'panel'] as const) {
  test(`${via} cannot finish a project missing required merge evidence`, async (t) => {
    const card: any = { id: randomUUID(), companyId: randomUUID(), projectId: randomUUID(), title: 'Ship change', columnStatus: 'in_review', requiresApproval: false, reviewerId: null, assigneeId: null, tags: [], dependencyCardIds: [] };
    const run = { id: randomUUID(), cardId: card.id, companyId: card.companyId, kind: 'review', status: 'running', lockedBy: 'runner' };
    const approval = { id: randomUUID(), cardId: card.id, companyId: card.companyId, type: 'task_review', status: 'pending', payload: { humanGate: true } };
    const state = memoryDb(t, [[kanbanCards, [card]], [projects, [{ id: card.projectId, companyId: card.companyId, completionRequiresMerge: true, repoUrl: null }]], [taskRuns, [run]], [approvals, via === 'human' ? [approval] : []], [machineRunners, [{ id: 'runner', companyId: card.companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
    const app = Fastify(); t.after(() => app.close());
    if (via === 'auto_review') await reviewCard(card.id, { taskRunId: run.id });
    if (via === 'panel') {
      state.rows(reviewRounds).push({ id: 'round', cardId: card.id, companyId: card.companyId, status: 'open', kind: 'panel', round: 1, reviewerIds: ['reviewer'], metadata: { verdicts: { reviewer: 'approved' } } });
      state.rows(cardComments).push({ id: 'slot', cardId: card.id, action: 'review_slot', metadata: { roundId: 'round', reviewerId: 'reviewer', done: true } });
      await tryCloseRound('round');
    }
    if (via === 'runner') {
      await registerRunnerRoutes(app);
      const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${run.id}/complete`, headers: { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { status: 'success', summary: 'Approved', workProducts: [{ type: 'report', title: 'Reviewed result' }] } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(state.rows(workProducts).length, 1);
    }
    if (via === 'webhook') {
      const previous = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-webhook';
      t.after(() => { if (previous === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = previous; });
      await registerRoutes(app);
      const response = await app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-webhook' }, payload: { cardId: card.id, taskRunId: run.id, status: 'done', summary: 'Approved' } });
      assert.equal(response.statusCode, 200, response.body);
    }
    if (via === 'human' || via === 'manual') {
      const user = { id: randomUUID(), email: 'operator@example.test', role: 'admin' };
      state.rows(users).push(user);
      state.rows(companyMemberships).push({ userId: user.id, companyId: card.companyId, role: 'admin', status: 'active' });
      await app.register(cookie); await registerRoutes(app);
      const session = await signSession(user);
      const response = await app.inject({ method: 'PUT', url: via === 'human' ? `/api/approvals/${approval.id}` : `/api/cards/${card.id}`, headers: { cookie: `session=${session}` }, payload: via === 'human' ? { status: 'approved' } : { columnStatus: 'done' } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.notEqual(card.columnStatus, 'done');
    assert.equal(card.completedAt, null);
    assert.match(card.lastError, /repository/i);
  });
}

for (const status of ['failed', 'progress', 'input_required', 'bogus']) {
  test(`runner must normalize ${status} report before accepting success alias`, async (t) => {
    const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_progress', assigneeId: 'agent' };
    memoryDb(t, [[kanbanCards, [card]], [agents, [{ id: 'agent', companyId: 'company', isActive: true, adapterType: 'webhook' }]], [taskRuns, [{ id: 'run', cardId: 'card', companyId: 'company', kind: 'dispatch', status: 'running', lockedBy: 'runner' }]], [machineRunners, [{ id: 'runner', companyId: 'company', name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
    const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: '/api/runner/task-runs/run/complete', headers: { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { status: 'success', report: { kind: 'megacorps-report', status, summary: 'Current result' } } });
    assert.ok(response.statusCode < 500, response.body);
    assert.notEqual(card.columnStatus, 'done');
    if (status === 'bogus') assert.equal(card.protocolRepairState?.dispatch?.failures, 1);
  });
}
