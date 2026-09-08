import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, approvals, cardComments, externalWaits, heartbeatRuns, kanbanCards, projects, reviewFindings, reviewRounds, taskRuns, workProducts } from './db/schema.ts';
import { dispatchCard, reviewCard, runMessageDelegation, reviewMessageDelegation, sweepPeerQuestions } from './dispatch.ts';
import { admitUsage, summarizeUsage, utcPeriod } from './usage-ledger.ts';
import { unknownUsage } from './usage-facts.ts';
import { getAdapter } from './adapters/registry.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { db } from './db/client.ts';
import { agentResultExecutionLog, normalizeAgentResult, persistAgentWorkProducts } from './agent-results.ts';
import { apiHelpCatalog } from './api-help.ts';
import { reviewPanelSlot } from './review-rounds.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { costEvents } from './db/schema.ts';

for (const kind of ['dispatch', 'message', 'panel'] as const) test(`${kind} budget preflight does not turn a budget stop into manual deactivation`, async t => {
  const { card, agent, run, state } = kind === 'panel' ? panelFixture(t, kind) : fixture(t);
  (agent as any).budgetMonthly = '1';
  state.rows(costEvents).push({ id: randomUUID(), companyId: card.companyId, agentId: agent.id, costUsd: '1', costStatus: 'actual', occurredAt: new Date() });
  if (kind === 'message') {
    const comment = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, action: 'delegate_request', body: 'Synthetic', delegationStatus: 'queued' };
    state.rows(cardComments).push(comment); run.kind = 'message'; (run as any).messageCommentId = comment.id;
  }
  let calls = 0; t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; throw new Error('must_not_execute'); });
  await assert.rejects(kind === 'dispatch' ? dispatchCard(card.id, 'manual', { taskRunId: run.id }) : kind === 'message' ? runMessageDelegation(card.id, { taskRunId: run.id }) : reviewPanelSlot(card.id, { taskRunId: run.id }), /agent_budget_exceeded/);
  assert.equal(calls, 0); assert.equal(agent.isActive, true, 'Budget stop must not overwrite manual activation');
});
test('direct-card budget preflight does not consume a provider retry or execution lock', async t => {
  const { card, agent, run, state } = fixture(t); card.taskBudgetLimit = '1';
  state.rows(costEvents).push({ id: randomUUID(), companyId: card.companyId, agentId: agent.id, cardId: card.id, costUsd: '1', costStatus: 'actual', occurredAt: new Date() });
  let calls = 0; t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; throw new Error('must_not_execute'); });
  await assert.rejects(dispatchCard(card.id, 'manual', { taskRunId: run.id }), /agent_budget_exceeded/);
  assert.equal(calls, 0); assert.equal(card.retryCount, 0); assert.ok(!card.executionLockId); assert.equal(agent.isActive, true);
});
test('allowance consumed between preflight and admission requeues without counting a provider failure', async t => {
  const { card, agent, run, state } = fixture(t); (agent as any).budgetMonthly = '1';
  const insert = db.insert.bind(db);
  t.mock.method(db, 'insert', ((table: any) => {
    if (table === heartbeatRuns) state.rows(costEvents).push({ id: randomUUID(), companyId: card.companyId, agentId: agent.id, costUsd: '1', costStatus: 'actual', occurredAt: new Date() });
    return insert(table);
  }) as typeof db.insert);
  let calls = 0; t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; throw new Error('must_not_execute'); });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(calls, 0); assert.equal(card.retryCount, 0); assert.equal(run.status, 'queued');
  assert.equal(agent.isActive, true); assert.equal(agent.isBusy, false); assert.ok(!card.executionLockId);
});
test('returned transport and same-attempt webhook dedupe before a later actual correction', async t => {
  const { card, agent, run, state } = fixture(t);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Synthetic completed work' }), sessionId: 'context', tokensUsed: 2, costUsd: 0.25, durationSeconds: 1 }));
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  const send = await webhook(t);
  const payload = { cardId: card.id, taskRunId: run.id, status: 'done', costUsd: 0.25, summary: 'Duplicate transport result' };
  assert.equal((await send(payload)).statusCode, 200);
  assert.equal(state.rows(costEvents).length, 1);
  const actual = { ...payload, usage: { version: 1, ...unknownUsage('synthetic'), costStatus: 'actual', costUsd: '0.35000019', providerEventId: 'stable-event' } };
  const firstActual = await send(actual); assert.equal(firstActual.statusCode, 200, firstActual.body); assert.equal((await send(actual)).statusCode, 200);
  assert.equal(state.rows(costEvents).length, 1); assert.equal(card.costUsd, '0.35000019'); assert.equal((agent as any).spentThisMonth, '0.35000019');
});
for (const retired of [false, true]) test(`late webhook settles original project despite ${retired ? 'soft deletion' : 'reassignment and old work-product scope'}`, async t => {
  const { card, agent, run, state } = fixture(t);
  const original = { id: randomUUID(), companyId: card.companyId, name: 'Original' }, later = { ...original, id: randomUUID(), name: 'Later' };
  state.rows(projects).push(original, later); card.projectId = original.id;
  await admitUsage({ companyId: card.companyId, agentId: agent.id, cardId: card.id, projectId: original.id, taskRunId: run.id, attemptKey: `task-run:${run.id}`, source: 'dispatch' });
  card.projectId = later.id; run.status = 'cancelled'; if (retired) card.deletedAt = new Date();
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', costUsd: 0.25, workProducts: [{ type: 'report', title: 'Original result', projectId: original.id }] });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().stale, true);
  assert.equal(state.rows(costEvents)[0]!.costUsd, '0.25000000'); assert.equal(state.rows(costEvents)[0]!.projectId, original.id);
  assert.equal(card.projectId, later.id); assert.equal(state.rows(workProducts).length, 0);
});
test('a webhook cannot combine one attempt key with another task-run identity', async t => {
  const { card, agent, run, state } = fixture(t);
  const key = `task-run:${run.id}`;
  await admitUsage({ companyId: card.companyId, agentId: agent.id, cardId: card.id, taskRunId: run.id, attemptKey: key, source: 'dispatch' });
  const other = { ...run, id: randomUUID() }; state.rows(taskRuns).push(other);
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: other.id, usageAttemptKey: key, status: 'done', costUsd: 0.25 });
  assert.equal(response.statusCode, 409, response.body); assert.equal(state.rows(costEvents)[0]!.costUsd, null);
});

for (const kind of ['dispatch', 'review', 'message', 'message_review', 'peer', 'panel', 'verify'] as const) for (const success of [true, false]) test(`${kind} ${success ? 'success' : 'failure'} entrypoint keeps exact actual totals in original scopes`, async t => {
  const { card, agent, run, state } = kind === 'panel' || kind === 'verify' ? panelFixture(t, kind) : fixture(t);
  if (kind === 'review') { card.columnStatus = 'in_review'; card.assigneeId = 'author'; card.reviewerId = agent.id; run.kind = 'review'; }
  if (kind === 'message' || kind === 'message_review' || kind === 'peer') {
    const request = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, reviewerAgentId: agent.id, action: kind === 'peer' ? 'peer_question' : 'delegate_request', body: 'Synthetic scope', delegationStatus: 'queued' };
    state.rows(cardComments).push(request);
    const comment = kind === 'message_review' ? { ...request, id: randomUUID(), parentCommentId: request.id, action: 'delegate_report', delegationStatus: 'submitted' } : request;
    if (comment !== request) state.rows(cardComments).push(comment);
    run.kind = kind; (run as any).messageCommentId = comment.id;
  }
  let calls = 0;
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => { calls++; return { success, output: success ? JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Synthetic completed work', verdict: 'approved', findings: [] }) : 'synthetic provider failure', sessionId: 'reused-synthetic-session', tokensUsed: 10, costUsd: 0.12500019, durationSeconds: 1, usage: { ...unknownUsage('synthetic_runtime_report'), costStatus: 'actual', costUsd: '0.12500019' } }; });
  const app = Fastify(); t.after(() => app.close());
  const execute = () => kind === 'dispatch' ? dispatchCard(card.id, 'manual', { taskRunId: run.id }) : kind === 'review' ? reviewCard(card.id, { taskRunId: run.id }) : kind === 'message' ? runMessageDelegation(card.id, { taskRunId: run.id }) : kind === 'message_review' ? reviewMessageDelegation(card.id, { taskRunId: run.id }) : kind === 'peer' ? sweepPeerQuestions(app) : reviewPanelSlot(card.id, { taskRunId: run.id });
  try { await execute(); } catch (error) { assert.match(String(error), /synthetic provider failure/); }
  assert.equal(calls, 1, 'Actual entrypoint must reach one synthetic adapter operation');
  const rows = state.rows(costEvents);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.costUsd, '0.12500019');
  for (const filter of [{}, { agentId: agent.id }, { cardId: card.id }]) assert.equal(summarizeUsage(rows as any, { ...filter, period: utcPeriod() }).actualUsd, '0.12500019');
  assert.equal((agent as any).spentThisMonth, '0.12500019'); assert.equal(card.costUsd, '0.12500019');
});

function fixture(t: TestContext) {
  const card: any = { id: randomUUID(), companyId: randomUUID(), title: 'Build change', body: 'Implement the requested change.', assigneeId: randomUUID(), reviewerId: null, projectId: null, columnStatus: 'todo', requiresApproval: false, deletedAt: null, tags: [], dependencyCardIds: [], retryCount: 0 };
  const agent = { id: card.assigneeId, companyId: card.companyId, name: 'Builder', slug: 'builder', isActive: true, isBusy: false, bossId: null, adapterType: 'webhook', capabilities: [], deletedAt: null };
  const run = { id: randomUUID(), companyId: card.companyId, cardId: card.id, agentId: agent.id, kind: 'dispatch', status: 'running' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [agent]], [taskRuns, [run]]]);
  readyCompany(state, card.companyId);
  // These fixtures have no position/department rows; the roster's LEFT JOIN
  // keeps the agent rows intact. Keep this narrow support local to this suite.
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
  return { card, agent, run, state };
}

const report = (status: string, extra = {}) => ({ kind: 'megacorps-report', status, summary: 'Current result', ...extra });
const product = { type: 'pull_request', title: 'Change', url: 'https://github.com/example/repo/pull/1' };

test('cancelled dispatch preserves its paid late result without moving the card', async t => {
  const { card, run, state } = fixture(t);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    card.columnStatus = 'cancelled';
    card.executionLockId = null;
    card.activeHeartbeatRunId = null;
    return { success: true, output: 'Late synthetic response', sessionId: 'session', tokensUsed: 4, costUsd: 0.125, durationSeconds: 1 };
  });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(costEvents).length, 1, 'Late original dispatch usage must survive cancellation');
});

test('transport-level permission denial bypasses protocol and transport retries', async (t) => {
  const { card, run, state } = fixture(t);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: false, output: JSON.stringify(report('input_required', { summary: 'Permission denied: repository write requires authorization.', request: { kind: 'permission', question: 'Authorize the repository write.' }, workProducts: [product] })), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(card.columnStatus, 'needs_review');
  assert.notEqual(card.columnStatus, 'done');
  assert.equal(card.retryCount, 0);
  assert.equal(card.protocolRepairState?.dispatch, undefined);
  assert.match(card.lastError, /permission/i);
  assert.equal(state.rows(taskRuns).filter((task) => task.status === 'queued').length, 0);
  assert.equal(state.rows(workProducts).length, 0);
});

test('webhook malformed report consumes one persisted protocol attempt per run', async (t) => {
  const { card, run, state } = fixture(t);
  const send = await webhook(t);
  const payload = { cardId: card.id, taskRunId: run.id, status: 'done', report: report('bogus') };
  const response = await send(payload);
  assert.ok(response.statusCode < 500, response.body);
  assert.equal(card.protocolRepairState?.dispatch?.failures, 1);
  const comments = state.rows(cardComments).length;
  await send(payload);
  assert.equal(card.protocolRepairState.dispatch.failures, 1);
  assert.equal(state.rows(cardComments).length, comments);
});

test('direct dispatch cannot finish without required merge evidence', async (t) => {
  const { card, run, state } = fixture(t);
  card.projectId = randomUUID();
  state.rows(projects).push({ id: card.projectId, companyId: card.companyId, completionRequiresMerge: true, repoUrl: null });
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report('completed', { summary: 'Implemented the requested product change.' })), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.notEqual(card.columnStatus, 'done');
  assert.equal(card.completedAt, null);
});

test('completed implementation report preserves an explicit external wait and its evidence', async (t) => {
  const { card, run, state } = fixture(t);
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'waiting_on_external', summary: 'CI running', pollIntervalSeconds: 60, report: report('completed', { workProducts: [product] }) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(card.columnStatus, 'waiting_on_external');
  assert.equal(card.completedAt, null);
  assert.equal(state.rows(externalWaits).length, 1);
  assert.equal(state.rows(externalWaits)[0]?.pollIntervalSeconds, 60);
  assert.equal(state.rows(externalWaits)[0]?.externalUrl, product.url);
  assert.equal(state.rows(workProducts).length, 1);
});

for (const duringWrite of [false, true]) {
  test(`permission webhook preserves a human gate ${duringWrite ? 'created between read and write' : 'already pending'}`, async (t) => {
    const { card, run, state } = fixture(t);
    card.columnStatus = 'in_review'; card.executionLog = 'Human is deciding'; run.kind = 'review';
    card.updatedAt = new Date('2026-08-01T00:00:00Z');
    card.runRetryState = { review: { failures: 4, nextRunAt: '2026-10-01T00:00:00.000Z' } };
    const before = structuredClone(card);
    const approval = { id: randomUUID(), cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } };
    if (duringWrite) {
      const update = db.update.bind(db);
      t.mock.method(db, 'update', ((table: any) => {
        const query = update(table);
        const set = query.set.bind(query);
        query.set = ((values: any) => {
          if (table === kanbanCards && values.columnStatus === 'blocked') state.rows(approvals).push(approval);
          return set(values);
        }) as typeof query.set;
        return query;
      }) as typeof db.update);
    } else state.rows(approvals).push(approval);
    const send = await webhook(t);
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', output: 'Clone pending approval' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().newStatus, 'in_review');
    assert.deepEqual(card, before);
    assert.deepEqual(state.rows(approvals), [approval]);
    assert.equal(run.status, 'failed');
    const settled = structuredClone(run);
    const duplicate = await send({ cardId: card.id, taskRunId: run.id, status: 'done', output: 'Clone pending approval' });
    assert.ok(duplicate.statusCode < 500, duplicate.body);
    assert.deepEqual(card, before);
    assert.deepEqual(run, settled);
  });
}

for (const prefix of ['- ', '### ']) {
  test(`actual review honors ${JSON.stringify(prefix)} final verdict over historical rejection`, async (t) => {
    const { card, agent, run } = fixture(t);
    card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: `Previously cannot approve.\n${prefix}Final verdict: APPROVED.`, sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await reviewCard(card.id, { taskRunId: run.id });
    assert.equal(card.columnStatus, 'done');
  });
}

test('actual review requests repair for conflicting decorated final verdicts', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: '- Final verdict: APPROVED.\n### Final verdict: REJECTED.', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewCard(card.id, { taskRunId: run.id });
  assert.equal(card.columnStatus, 'in_review');
  assert.match(card.lastError, /review_verdict/);
  assert.ok(state.rows(cardComments).some((comment) => /corrected response/.test(comment.body)));
});

function panelFixture(t: TestContext, roundKind: 'panel' | 'verify') {
  const data = fixture(t);
  const { card, agent, run, state } = data;
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'panel_review';
  const round = { id: randomUUID(), cardId: card.id, companyId: card.companyId, status: 'open', kind: roundKind, round: 1, reviewerIds: [agent.id, 'other-reviewer'], metadata: {} };
  const slot = { id: randomUUID(), cardId: card.id, action: 'review_slot', metadata: { roundId: round.id, reviewerId: agent.id, done: false } };
  (run as any).messageCommentId = slot.id;
  state.rows(reviewRounds).push(round);
  state.rows(cardComments).push(slot, { id: randomUUID(), cardId: card.id, action: 'review_slot', metadata: { roundId: round.id, reviewerId: 'other-reviewer', done: false } });
  // This fixture has no prior findings to replace; a second unfinished slot
  // keeps successful submissions from closing the round during the assertion.
  t.mock.method(db, 'delete', ((table: any) => ({ where: async () => { assert.equal(table, reviewFindings); assert.equal(state.rows(table).length, 0); return []; } })) as unknown as typeof db.delete);
  return { ...data, round, slot };
}

for (const kind of ['panel', 'verify'] as const) test(`late ${kind} slot callback retains usage after workflow completion`, async t => {
  const { card, run, state } = panelFixture(t, kind);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    run.status = 'cancelled';
    return { success: false, output: 'synthetic paid failure', sessionId: 'session', tokensUsed: 4, costUsd: 0.125, durationSeconds: 1 };
  });
  await reviewPanelSlot(card.id, { taskRunId: run.id });
  assert.equal(run.status, 'cancelled');
  assert.equal(state.rows(costEvents).length, 1, 'A late panel or verification result must settle');
});

for (const via of ['returned', 'webhook'] as const) for (const roundKind of ['panel', 'verify'] as const) for (const status of ['failed', 'rejected', 'progress', 'input_required', 'permission', 'invalid']) {
  test(`${via} ${roundKind} review cannot submit ${status} work with an approved verdict`, async (t) => {
    const { card, agent, run, round, slot } = panelFixture(t, roundKind);
    const data = report(status === 'permission' ? 'input_required' : status === 'invalid' ? 'bogus' : status, { verdict: 'approved', score: 8, findings: [], verifications: [{ findingKey: 'K1', status: 'verified' }], ...(status === 'permission' ? { request: { kind: 'permission', question: 'Allow clone?' } } : {}) });
    if (via === 'returned') {
      let called = false;
      t.mock.method(getAdapter('webhook'), 'dispatch', async () => { called = true; return { success: true, output: JSON.stringify(data), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
      await reviewPanelSlot(card.id, { taskRunId: run.id });
      assert.equal(called, true, 'fixture must reach the actual adapter result consumer');
      assert.equal(run.status, 'failed');
    } else {
      const send = await webhook(t);
      const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: data });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
      assert.equal(run.status, 'running');
    }
    assert.notEqual((round.metadata as any).verdicts?.[agent.id], 'approved');
    assert.equal(slot.metadata.done, false);
    assert.equal(card.columnStatus, 'in_review');
  });
}

for (const via of ['returned', 'webhook'] as const) for (const roundKind of ['panel', 'verify'] as const) {
  test(`${via} ${roundKind} review still submits a valid completed report`, async (t) => {
    const { card, agent, run, round, slot } = panelFixture(t, roundKind);
    const data = report('completed', { verdict: 'approved', score: 8, findings: [], verifications: [{ findingKey: 'K1', status: 'verified' }] });
    if (via === 'returned') {
      t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(data), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
      await reviewPanelSlot(card.id, { taskRunId: run.id });
    } else {
      const send = await webhook(t);
      const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: data });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal((round.metadata as any).verdicts?.[agent.id], 'approved');
    assert.equal(slot.metadata.done, true);
    assert.equal(run.status, 'success');
  });
}
const unsafeOutputs = [
  ['failed', JSON.stringify(report('failed')), 'failure'],
  ['permission', 'Cannot complete: clone pending approval', 'blocked'],
  ['invalid', JSON.stringify(report('bogus')), 'repair'],
  ['progress', JSON.stringify(report('progress')), 'progress'],
] as const;

for (const [label, output, outcome] of unsafeOutputs) {
  test(`dispatch entrypoint cannot finish ${label} output from a successful adapter`, async (t) => {
    const { card, run, state } = fixture(t);
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output, sessionId: 'test-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await dispatchCard(card.id, 'manual', { taskRunId: run.id });
    assert.notEqual(card.columnStatus, 'done');
    assert.equal(state.rows(approvals).length, 0);
    if (outcome === 'blocked') { assert.equal(card.columnStatus, 'needs_review'); assert.match(card.lastError, /approval|permission/i); assert.equal(state.rows(workProducts).length, 0); }
    if (outcome === 'repair') assert.ok(state.rows(cardComments).some((row) => /report.*invalid|report.*repair/.test(row.body)));
    if (outcome === 'failure') assert.equal(state.rows(taskRuns).find((row) => row.id === run.id)?.status, 'failed');
  });
}

test('dispatch persists report-only work products with trusted identities and preserves artifacts', async (t) => {
  const { card, agent, run, state } = fixture(t);
  let productsAtCompletion = -1;
  const update = db.update.bind(db);
  t.mock.method(db, 'update', ((table: any) => {
    const query = update(table);
    const set = query.set.bind(query);
    query.set = ((values: any) => {
      if (table === kanbanCards && values.columnStatus === 'done') productsAtCompletion = state.rows(workProducts).length;
      return set(values);
    }) as typeof query.set;
    return query;
  }) as typeof db.update);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report('completed', { workProducts: [{ ...product, cardId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), taskRunId: randomUUID() }] })), artifacts: [{ artifactId: 'a1', name: 'Screenshot', uri: 'https://example.com/screenshot.png' }], sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(state.rows(workProducts).length, 2);
  assert.equal(productsAtCompletion, 2, 'evidence must exist before the completion stage changes');
  const stored = state.rows(workProducts).find((row) => row.url === product.url)!;
  assert.ok(stored);
  assert.equal(stored.cardId, card.id);
  assert.equal(stored.companyId, card.companyId);
  assert.equal(stored.agentId, agent.id);
  assert.equal(stored.taskRunId, run.id);
});

async function webhook(t: TestContext) {
  const prior = process.env.WEBHOOK_SHARED_SECRET;
  process.env.WEBHOOK_SHARED_SECRET = 'synthetic-task-one-secret';
  t.after(() => { if (prior === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = prior; });
  const app = Fastify();
  t.after(() => app.close());
  await registerRoutes(app);
  return (payload: any) => app.inject({ method: 'POST', url: '/api/webhook/task-complete', headers: { 'x-megacorps-webhook-secret': 'synthetic-task-one-secret' }, payload });
}

test('stale original webhook records supplied usage before its workflow acknowledgement', async t => {
  const { card, run, state } = fixture(t);
  card.columnStatus = 'cancelled'; run.status = 'cancelled';
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', costUsd: 0.25 });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().stale, true);
  assert.equal(state.rows(costEvents).length, 1, 'Stale same-original-attempt webhook usage remains billable');
  assert.equal(card.columnStatus, 'cancelled');
});

for (const [label, output] of unsafeOutputs) {
  test(`webhook entrypoint cannot finish ${label} report in returned content`, async (t) => {
    const { card, run, state } = fixture(t);
    const send = await webhook(t);
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', output });
    assert.ok(response.statusCode < 500, response.body);
    assert.notEqual(card.columnStatus, 'done');
    assert.equal(state.rows(approvals).length, 0);
  });
}

for (const status of ['progress', 'input_required', 'completed']) {
  test(`message webhook preserves ${status} semantics and report work products`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const comment = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, action: 'delegate_request', body: 'Build change', delegationStatus: 'queued' };
    state.rows(cardComments).push(comment);
    run.kind = 'message'; (run as any).messageCommentId = comment.id;
    const send = await webhook(t);
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report(status, { workProducts: [product] }) });
    assert.equal(response.statusCode, 200, response.body);
    if (status !== 'completed') assert.ok(!['approved', 'submitted'].includes(comment.delegationStatus));
    assert.equal(state.rows(workProducts).length, 1);
  });
}

test('review webhook honors a structured current rejection over approval prose', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', summary: 'APPROVED', report: report('completed', { verdict: 'revision_requested' }) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(card.columnStatus, 'todo');
  assert.equal(state.rows(taskRuns).find((row) => row.id === run.id)?.status, 'failed');
});

test('API help teaches the normalized report states, requests and work products', () => {
  const catalog = apiHelpCatalog();
  const endpoint = catalog.endpoints.find((item) => item.path === '/api/webhook/task-complete');
  assert.match(JSON.stringify(endpoint?.body), /checkpointKind/);
  assert.match(JSON.stringify(endpoint?.body), /progress/);
  assert.ok((endpoint?.body as any)?.report?.workProducts);
});

for (const inOutput of [false, true]) for (const duplicate of [false, true]) {
  test(`webhook persists report work products once (${inOutput ? 'output' : 'report'} field, duplicate=${duplicate})`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const send = await webhook(t);
    const data = report('completed', { workProducts: [{ ...product, agentId: randomUUID(), taskRunId: randomUUID() }] });
    const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', ...(inOutput ? { output: JSON.stringify(data) } : { report: data }), ...(duplicate ? { workProducts: [product] } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.rows(workProducts).length, 1);
    assert.equal(state.rows(workProducts)[0]?.agentId, agent.id);
    assert.equal(state.rows(workProducts)[0]?.taskRunId, run.id);
  });
}

test('webhook returns correction feedback for a present invalid report without product side effects', async (t) => {
  const { card, run, state } = fixture(t);
  const send = await webhook(t);
  const response = await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report('bogus'), workProducts: [product] });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().message, /report.*invalid|report.*repair/);
  assert.equal(state.rows(workProducts).length, 0);
});

test('webhook cannot overwrite a cancelled run or attach its stale products', async (t) => {
  const { card, run, state } = fixture(t);
  card.columnStatus = 'cancelled'; run.status = 'cancelled';
  const send = await webhook(t);
  await send({ cardId: card.id, taskRunId: run.id, status: 'done', report: report('completed', { workProducts: [product] }) });
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(workProducts).length, 0);
});

test('late dispatch output preserves a stage changed outside the run and inserts no products', async (t) => {
  const { card, run, state } = fixture(t);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    card.columnStatus = 'cancelled'; card.executionLockId = null; card.activeHeartbeatRunId = null;
    return { success: true, output: JSON.stringify(report('completed', { workProducts: [product] })), sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  assert.equal(card.columnStatus, 'cancelled');
  assert.equal(state.rows(workProducts).length, 0);
  assert.equal(state.rows(heartbeatRuns)[0]?.status, 'cancelled');
});

test('normalizer keeps structured status authoritative and maps typed requests without mutating input', () => {
  assert.equal(normalizeAgentResult({ output: 'Permission denied', report: report('completed') }).outcome, 'completed');
  assert.equal(normalizeAgentResult({ report: report('completed', { request: { kind: 'permission', question: 'Allow clone?' } }) }).outcome, 'permission');
  const input = report('input_required', { request: { kind: 'checkpoint', checkpointKind: 'interim', question: 'Keep this direction?', options: ['Keep', 'Revise'] } });
  const original = structuredClone(input);
  assert.equal(normalizeAgentResult({ report: input }).report?.checkpoint?.kind, 'interim');
  assert.deepEqual(input, original);
  assert.equal(normalizeAgentResult({ output: 'Completed', needsInput: { question: 'Which format?' } }).outcome, 'input_required');
});

test('persistence rejects a forged recovery report outside the recovery handler before evidence inserts', async (t) => {
  const { card, agent, run, state } = fixture(t);
  const forged = normalizeAgentResult({ report: report('completed', {
    recovery: { action: 'rework', reason: 'Claimed recovery.', instructions: 'Retry outside recovery context.' },
    workProducts: [product], artifactRefs: ['forged-reference'],
  }) }).report!;
  await assert.rejects(
    persistAgentWorkProducts(card, agent.id, run.id, forged.workProducts ?? [], null, forged),
    /recovery_context_required/,
  );
  assert.equal(state.rows(workProducts).length, 0);
});

test('normalizer applies optional-null repair and precise diagnostics to explicit reports', () => {
  const input = report('progress', { children: [{ title: 'Child', body: 'Deliver a bounded result with concrete acceptance evidence.', assigneeSlug: 'worker', dependsOn: null }] });
  const original = structuredClone(input);
  const valid = normalizeAgentResult({ report: input });
  assert.equal(valid.outcome, 'progress');
  assert.equal(Object.hasOwn(valid.report!.children![0]!, 'dependsOn'), false);
  assert.deepEqual(input, original);
  assert.deepEqual(valid.corrections, ['Omitted optional null field children[0].dependsOn.']);
  assert.match(agentResultExecutionLog('original output', valid), /report normalization: Omitted optional null field children\[0\]\.dependsOn\./);

  const secret = 'secret-invalid-explicit-type';
  const invalid = normalizeAgentResult({ report: report('completed', { workProducts: [{ type: secret, title: null }] }) });
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.reason!, /workProducts\[0\]\.type/);
  assert.match(invalid.reason!, /workProducts\[0\]\.title/);
  assert.match(invalid.reason!, /received string/i);
  assert.match(invalid.reason!, /received null/i);
  assert.doesNotMatch(invalid.reason!, new RegExp(secret));
});

test('normalizer rejects different simultaneous reports rather than combining their evidence', () => {
  const embedded = report('completed', { summary: 'Embedded current result', workProducts: [{ type: 'report', title: 'Embedded evidence' }] });
  const explicit = report('completed', { summary: 'Explicit current result', workProducts: [{ type: 'report', title: 'Explicit evidence' }] });
  const result = normalizeAgentResult({ output: JSON.stringify(embedded), report: explicit });
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason!, /conflicting current reports/);
  assert.deepEqual(result.workProducts, []);
});

test('normalizer audits a repair from either source when simultaneous reports agree', () => {
  const corrected = report('progress', { children: [{ title: 'Child', body: 'Deliver a bounded result with concrete acceptance evidence.', assigneeSlug: 'worker' }] });
  const embedded = structuredClone(corrected) as any;
  embedded.children[0].dependsOn = null;
  const result = normalizeAgentResult({ output: JSON.stringify(embedded), report: corrected });
  assert.equal(result.outcome, 'progress');
  assert.deepEqual(result.corrections, ['Omitted optional null field children[0].dependsOn.']);
});

test('conflicting current structured report verdicts require repair', () => {
  assert.equal(normalizeAgentResult({ output: JSON.stringify(report('completed', { verdict: 'revision_requested' })), report: report('completed', { verdict: 'approved' }) }).outcome, 'invalid');
});

test('a reviewer permission blocker parks the actual review without creating approval', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: 'Clone pending approval', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await reviewCard(card.id, { taskRunId: run.id });
  assert.equal(card.columnStatus, 'needs_review');
  assert.notEqual(card.columnStatus, 'done');
  assert.match(card.lastError, /permission|approval/);
  assert.equal(state.rows(approvals).length, 0);
  assert.equal(state.rows(workProducts).length, 0);
});

test('a late reviewer permission blocker preserves a human gate created during the same review stage', async (t) => {
  const { card, agent, run, state } = fixture(t);
  card.assigneeId = 'author'; card.reviewerId = agent.id; card.columnStatus = 'in_review'; run.kind = 'review';
  const approval = { id: randomUUID(), cardId: card.id, type: 'task_review', status: 'pending', payload: { humanGate: true } };
  let before: any;
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    state.rows(approvals).push(approval);
    card.updatedAt = new Date('2026-08-01T00:00:00Z');
    card.runRetryState = { review: { failures: 4, nextRunAt: '2026-10-01T00:00:00.000Z' } };
    before = structuredClone(card);
    return { success: true, output: 'Clone pending approval', sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await reviewCard(card.id, { taskRunId: run.id });
  assert.equal(card.columnStatus, 'in_review');
  assert.ok(before, 'actual reviewer transport must be reached');
  assert.deepEqual(card, before);
  assert.equal(run.status, 'failed');
  assert.deepEqual(state.rows(approvals), [approval]);
});

for (const [label, output] of unsafeOutputs) {
  test(`message delegation cannot submit or approve ${label} output`, async (t) => {
    const { card, agent, run, state } = fixture(t);
    const comment = { id: randomUUID(), cardId: card.id, assigneeAgentId: agent.id, action: 'delegate_request', body: 'Build change', delegationStatus: 'queued' };
    state.rows(cardComments).push(comment);
    run.kind = 'message'; (run as any).messageCommentId = comment.id;
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output, sessionId: 's', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await runMessageDelegation(card.id, { taskRunId: run.id });
    assert.ok(!['approved', 'submitted'].includes(comment.delegationStatus));
    assert.equal(state.rows(cardComments).filter((row) => row.action === 'delegate_report').length, 0);
  });
}
