import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, costEvents, kanbanCards, machineRunners, taskRuns, budgetPolicies } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { unknownUsage } from './usage-facts.ts';
import { summarizeUsage } from './usage-ledger.ts';

test('successful runner claim and completion share one durable original attempt', async t => {
  const { app, headers, run, card, agent, state } = await fixture(t);
  run.status = 'queued'; run.lockedBy = null;
  const claimed = await app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers, payload: {} });
  assert.equal(claimed.statusCode, 200, claimed.body); assert.equal(claimed.json().taskRun?.id, run.id);
  assert.equal(state.rows(costEvents).length, 1); assert.equal(state.rows(costEvents)[0]!.costStatus, 'unknown');
  const payload = { status: 'in_review', summary: 'Synthetic completed review', usage: { version: 1, ...unknownUsage('synthetic_runtime_report'), costStatus: 'actual', costUsd: '0.12500019', providerEventId: 'runner-event' } };
  const url = `/api/runner/task-runs/${run.id}/complete`;
  const completed = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(completed.statusCode, 200, completed.body);
  const duplicate = await app.inject({ method: 'POST', url, headers, payload }); assert.equal(duplicate.json().duplicate, true, duplicate.body);
  assert.equal(state.rows(costEvents).length, 1); assert.equal(summarizeUsage(state.rows(costEvents) as any).actualUsd, '0.12500019');
  assert.equal(card.costUsd, '0.12500019'); assert.equal(agent.spentThisMonth, '0.12500019'); assert.equal(run.costUsd, '0.12500019');
});

async function fixture(t: TestContext) {
  const company: any = { id: randomUUID(), name: 'Runner fixture' };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true, isBusy: false, adapterType: 'webhook', name: 'Reviewer' };
  const runner: any = { id: randomUUID(), companyId: company.id, apiKeyHash: hashRunnerApiKey('synthetic-runner-key'), status: 'online', name: 'Runner', supportedRuntimes: [] };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, reviewerId: agent.id, columnStatus: 'in_review', projectId: null, title: 'Fixture review' };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, cardId: card.id, kind: 'review', status: 'running', lockedBy: runner.id };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [machineRunners, [runner]], [kanbanCards, [card]], [taskRuns, [run]]]);
  const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
  const headers = { 'x-megacorps-runner-key': 'synthetic-runner-key' };
  return { state, company, agent, runner, card, run, app, headers };
}

test('actual runner completion accounts first stale estimate, duplicate and late actual without replaying cancelled card', async t => {
  const { app, headers, run, card, state } = await fixture(t);
  card.columnStatus = 'cancelled';
  const send = (payload: any) => app.inject({ method: 'POST', url: `/api/runner/task-runs/${run.id}/complete`, headers, payload });
  const estimate = { status: 'failed', costUsd: 0.25 };
  const first = await send(estimate);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(costEvents).length, 1, 'First stale runner estimate must settle');
  assert.equal((await send(estimate)).json().duplicate, true);
  const actual = { status: 'failed', usage: { version: 1, ...unknownUsage(), costStatus: 'actual', costUsd: '0.35000019', provider: 'synthetic-provider', providerEventId: 'event-1' } };
  assert.equal((await send(actual)).statusCode, 200);
  assert.equal((await send(actual)).statusCode, 200);
  assert.equal(state.rows(costEvents).length, 1);
  assert.equal(state.rows(costEvents)[0]!.costUsd, '0.35000019');
  assert.equal(state.rows(costEvents)[0]!.costStatus, 'actual');
  assert.equal(card.columnStatus, 'cancelled');
});
for (const paused of [true, false]) test(`runner claim rejects ${paused ? 'manual pause' : 'spent company cap'}`, async t => {
  const { app, headers, run, agent, state, company } = await fixture(t);
  run.status = 'queued'; run.lockedBy = null;
  if (paused) agent.isActive = false;
  else {
    state.rows(budgetPolicies).push({ id: randomUUID(), companyId: company.id, isActive: true, monthlyLimitUsd: '1', hardStop: true });
    state.rows(costEvents).push({ id: randomUUID(), companyId: company.id, agentId: randomUUID(), costStatus: 'actual', costUsd: '1', occurredAt: new Date() });
  }
  const response = await app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().taskRun, null);
  assert.equal(run.status, 'queued');
});
test('foreign runner or foreign company cannot correct original attempt', async t => {
  const { app, run, state, company } = await fixture(t);
  for (const foreignCompany of [false, true]) {
    state.rows(machineRunners).push({ id: randomUUID(), companyId: foreignCompany ? randomUUID() : company.id, apiKeyHash: hashRunnerApiKey(`synthetic-foreign-${foreignCompany}`), status: 'online' });
    const response = await app.inject({ method: 'POST', url: `/api/runner/task-runs/${run.id}/complete`, headers: { 'x-megacorps-runner-key': `synthetic-foreign-${foreignCompany}` }, payload: { status: 'failed', costUsd: 1 } });
    assert.equal(response.statusCode, foreignCompany ? 404 : 409);
  }
  assert.equal(state.rows(costEvents).length, 0);
});
