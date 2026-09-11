import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { getAdapter } from './adapters/registry.ts';
import { a2aExecutionScope } from './a2a-execution-scope.ts';
import { createA2aExecutionStore } from './a2a-executions.ts';
import type { A2aInvocationRecord } from './a2a-polling.ts';
import { db } from './db/client.ts';
import { agents, a2aExecutionAliases, a2aExecutions, heartbeatRuns, kanbanCards, taskRuns } from './db/schema.ts';
import { dispatchCard } from './dispatch.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { admitUsage, cardUsageScope } from './usage-ledger.ts';

function fixture(t: TestContext) {
  const card: any = { id: randomUUID(), companyId: randomUUID(), title: 'Integrate child results', body: 'Produce the final integrated result.', assigneeId: randomUUID(), reviewerId: null, projectId: null, columnStatus: 'todo', requiresApproval: false, deletedAt: null, tags: [], dependencyCardIds: [], retryCount: 0 };
  const children: any[] = ['Research', 'Implementation'].map(title => ({ id: randomUUID(), companyId: card.companyId, parentCardId: card.id, title, columnStatus: 'done', childRequirementLevel: 'required', deletedAt: null }));
  const agent: any = { id: card.assigneeId, companyId: card.companyId, name: 'Integrator', slug: 'integrator', isActive: true, isBusy: false, bossId: null, adapterType: 'a2a', adapterConfig: {}, capabilities: [], deletedAt: null };
  const heartbeat: any = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: agent.id, status: 'running' };
  const run: any = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: agent.id, heartbeatRunId: heartbeat.id, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[kanbanCards, [card, ...children]], [agents, [agent]], [heartbeatRuns, [heartbeat]], [taskRuns, [run]], [a2aExecutions, []], [a2aExecutionAliases, []]]);
  readyCompany(state, card.companyId);
  const select = db.select.bind(db);
  t.mock.method(db, 'select', ((...args: any[]) => {
    const query: any = select(...args as []);
    const from = query.from.bind(query);
    query.from = (table: any) => {
      const chain = from(table);
      chain.leftJoin = (joined: any) => { assert.equal(state.rows(joined).length, 0); return chain; };
      return chain;
    };
    return query;
  }) as typeof db.select);
  return { card, agent, heartbeat, run, state };
}

test('main dispatch completion consumes its terminal A2A journal before the next same-card execution', async t => {
  const { card, agent, heartbeat, run, state } = fixture(t);
  const attemptKey = `task-run:${run.id}`;
  const scope = a2aExecutionScope(agent.id, { id: card.id, reportingMode: 'execution' });
  const record: A2aInvocationRecord = { key: attemptKey, scope, route: 'stable-route', contextId: 'old-context', baselineTaskIds: null, taskId: 'old-task', deadlineAt: Date.now() + 60_000, phase: 'terminal', revision: 1, outcome: { state: 'completed', contextId: 'old-context', taskId: 'old-task', text: 'Old result', report: null, artifacts: [] }, lastError: null };
  state.rows(a2aExecutions).push({ key: attemptKey, companyId: card.companyId, agentId: agent.id, scope, active: true, record });
  state.rows(a2aExecutionAliases).push({ key: attemptKey, executionKey: attemptKey });
  await admitUsage(cardUsageScope(card, agent, heartbeat.id, run.id, 'dispatch'));
  t.mock.method(getAdapter('a2a'), 'dispatch', async () => ({ success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Integrated child results.' }), sessionId: 'old-context', turnId: 'old-task', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));

  await dispatchCard(card.id, 'manual', { taskRunId: run.id });

  assert.equal(run.status, 'success');
  assert.equal(state.rows(a2aExecutions)[0]?.active, false);
  const nextKey = `task-run:${randomUUID()}`;
  const next = await createA2aExecutionStore(agent.id).begin({ key: nextKey, scope, route: 'stable-route', contextId: 'new-context', baselineTaskIds: null, taskId: null, deadlineAt: Date.now() + 60_000, phase: 'preparing', outcome: null, lastError: null });
  assert.equal(next.created, true);
  assert.equal(next.record.key, nextKey);
  assert.equal(state.rows(a2aExecutions).length, 2);
});
