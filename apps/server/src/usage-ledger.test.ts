import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, agentRuntimes, companies, costEvents, kanbanCards, taskRuns, budgetPolicies, budgetThresholds } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { admitUsage, executeUsage, settleUsage, settleTaskRunUsage, summarizeUsage, usageBudgetState, utcPeriod, type AttemptScope } from './usage-ledger.ts';
import { moneyString, moneyUnits, transportUsage, unknownUsage, type UsageFacts } from './usage-facts.ts';
import { db } from './db/client.ts';

const august = new Date('2026-08-31T23:59:59Z'), september = new Date('2026-09-03T10:00:00Z');
function fixture(t: TestContext) {
  const company: any = { id: randomUUID() };
  const agent: any = { id: randomUUID(), companyId: company.id, isActive: true, isBusy: true, spentThisMonth: '0' };
  const card: any = { id: randomUUID(), companyId: company.id, assigneeId: agent.id, columnStatus: 'in_progress' };
  const state = memoryDb(t, [[companies, [company]], [agents, [agent]], [kanbanCards, [card]]]);
  const scope: AttemptScope = { companyId: company.id, agentId: agent.id, cardId: card.id, attemptKey: randomUUID(), source: 'fixture', reportingSource: 'synthetic-runtime-account' };
  return { state, agent, card, company, scope };
}
const facts = (cost: string, status: 'estimated' | 'actual' = 'actual'): UsageFacts => ({ ...unknownUsage('synthetic_runtime_report'), costStatus: status, costUsd: cost });

test('legacy unadmitted run does not invent its original runtime from the current agent binding', async t => {
  const { state, scope, agent } = fixture(t);
  const currentRuntime = { id: randomUUID(), companyId: scope.companyId }; agent.runtimeId = currentRuntime.id;
  state.rows(agentRuntimes).push(currentRuntime);
  const run: any = { id: randomUUID(), companyId: scope.companyId, agentId: agent.id, cardId: scope.cardId, status: 'cancelled' }; state.rows(taskRuns).push(run);
  await settleTaskRunUsage(run, facts('0.25'));
  assert.equal(state.rows(costEvents)[0]!.runtimeId, null);
  assert.match(state.rows(costEvents)[0]!.reportingSource, /legacy/);
});

test('admission rejects foreign or stale runtime binding while original-runtime late settlement survives reassignment', async t => {
  const { state, scope, agent } = fixture(t);
  const original = { id: randomUUID(), companyId: scope.companyId }, next = { id: randomUUID(), companyId: scope.companyId }, foreign = { id: randomUUID(), companyId: randomUUID() };
  state.rows(agentRuntimes).push(original, next, foreign);
  agent.runtimeId = original.id;
  await assert.rejects(admitUsage({ ...scope, runtimeId: foreign.id }), /usage_runtime_company_mismatch/);
  await assert.rejects(admitUsage({ ...scope, runtimeId: next.id }), /usage_runtime_binding_changed/);
  await admitUsage({ ...scope, runtimeId: original.id });
  agent.runtimeId = next.id;
  await settleUsage({ ...scope, runtimeId: original.id }, facts('0.5'));
  assert.equal(state.rows(costEvents)[0]!.runtimeId, original.id);
});

test('estimate to actual replaces by delta, duplicate actual is idempotent, distinct attempts count separately', async t => {
  const { scope, state, agent, card } = fixture(t);
  await settleUsage(scope, facts('1.50000000', 'estimated'), { now: september });
  await settleUsage(scope, facts('2.00000019'), { now: september });
  await settleUsage(scope, facts('2.00000019'), { now: september });
  await settleUsage({ ...scope, attemptKey: randomUUID() }, facts('0.00000019'), { now: september });
  assert.equal(state.rows(costEvents).length, 2);
  assert.equal(agent.spentThisMonth, '2.00000038');
  assert.equal(card.costUsd, '2.00000038');
  assert.equal(summarizeUsage(state.rows(costEvents) as any).actualUsd, '2.00000038');
});
test('eight-place decimal arithmetic and UTC periods preserve fractional cost', () => {
  assert.equal(moneyString(moneyUnits('0.00000019') + moneyUnits('0.00000019')), '0.00000038');
  assert.deepEqual(utcPeriod(september), { key: '2026-09', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', timezone: 'UTC' });
});
test('late August actual on September day3 leaves current month zero and preserves manual pause and busy work', async t => {
  const { scope, state, agent, card } = fixture(t);
  await admitUsage(scope, { now: august });
  agent.isActive = false; card.columnStatus = 'cancelled';
  await settleUsage(scope, { ...facts('0.25000019'), occurredAt: august.toISOString() }, { now: september });
  assert.equal(agent.spentThisMonth, '0.00000000');
  assert.equal(agent.isActive, false); assert.equal(agent.isBusy, true); assert.equal(card.columnStatus, 'cancelled');
  assert.equal(summarizeUsage(state.rows(costEvents) as any, { period: utcPeriod(august) }).actualUsd, '0.25000019');
});
test('same provider event cannot rebind to a different attempt or agent', async t => {
  const { scope, state } = fixture(t);
  const usage = { ...facts('1.00000000'), providerEventId: 'stable-provider-event' };
  await settleUsage(scope, usage);
  await assert.rejects(settleUsage({ ...scope, attemptKey: randomUUID() }, usage), /usage_provider_event_already_bound/);
  await assert.rejects(settleUsage({ ...scope, companyId: randomUUID() }, usage), /usage_company_not_found/);
  assert.equal(state.rows(costEvents).length, 1);
});
test('card retries use cumulative direct cost and child cards do not double count parent totals', async t => {
  const { scope, card, state } = fixture(t);
  card.taskBudgetLimit = '2';
  await settleUsage(scope, facts('2'));
  await assert.rejects(admitUsage({ ...scope, attemptKey: randomUUID() }), /budget_exceeded_card/);
  const child = { ...card, id: randomUUID(), parentCardId: card.id, costUsd: null };
  state.rows(kanbanCards).push(child);
  await settleUsage({ ...scope, cardId: child.id, attemptKey: randomUUID() }, facts('0.5'));
  assert.equal(card.costUsd, '2.00000000');
  assert.equal(summarizeUsage(state.rows(costEvents) as any).totalUsd, '2.50000000');
});
test('company allowance is shared; unknown in-flight reservation prevents another agent borrowing it', async t => {
  const { scope, state, company } = fixture(t);
  state.rows(budgetPolicies).push({ id: randomUUID(), companyId: company.id, monthlyLimitUsd: '10', isActive: true, hardStop: true });
  const other = { id: randomUUID(), companyId: company.id, isActive: true };
  state.rows(agents).push(other);
  await admitUsage(scope, { now: september });
  await assert.rejects(admitUsage({ ...scope, agentId: other.id, cardId: null, attemptKey: randomUUID() }, { now: september }), /budget_exceeded_company/);
  await settleUsage(scope, facts('11'), { now: september });
  assert.equal((await usageBudgetState(other as any, undefined, september)).blocked, true);
});
test('expired unknown reservation releases allowance but its late actual is retained', async t => {
  const { scope, state, agent } = fixture(t); agent.budgetMonthly = '1';
  await admitUsage(scope, { now: new Date('2026-09-03T00:00:00Z'), timeoutSeconds: 1 });
  await admitUsage({ ...scope, attemptKey: randomUUID() }, { now: september });
  await settleUsage(scope, facts('1.1'), { now: september });
  assert.equal(state.rows(costEvents).length, 2);
  assert.equal(agent.spentThisMonth, '1.10000000');
});
test('90 percent warnings happen once and warning-only limits never hard-stop', async t => {
  const { scope, state, agent, company } = fixture(t);
  state.rows(budgetPolicies).push({ id: randomUUID(), companyId: company.id, monthlyLimitUsd: '10', isActive: true, hardStop: false, warnAtPercent: 90 });
  await settleUsage(scope, facts('8'), { now: september });
  assert.equal(state.rows(budgetThresholds).length, 0);
  await settleUsage(scope, facts('9'), { now: september });
  await settleUsage(scope, facts('11'), { now: september });
  assert.equal(state.rows(budgetThresholds).length, 1);
  assert.equal((await usageBudgetState(agent, undefined, september)).blocked, false);
});

test('cost and token provenance reconcile independently across late corrections', async t => {
  const { scope, state } = fixture(t);
  await settleUsage(scope, { ...facts('1'), tokenStatus: 'estimated', totalTokens: 10 });
  await settleUsage(scope, { ...unknownUsage('actual_tokens_only'), tokenStatus: 'actual', inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.equal(state.rows(costEvents)[0]!.usage.totalTokens, 12);
  assert.equal(state.rows(costEvents)[0]!.usage.costStatus, 'actual');
  await settleUsage(scope, facts('2'));
  assert.equal(state.rows(costEvents)[0]!.usage.totalTokens, 12);
  assert.equal(state.rows(costEvents)[0]!.usage.tokenStatus, 'actual');
});
test('active previous-month reservation still consumes new-month allowance', async t => {
  const { scope, agent } = fixture(t); agent.budgetMonthly = '1';
  await admitUsage(scope, { now: august, timeoutSeconds: 600 });
  await assert.rejects(admitUsage({ ...scope, attemptKey: randomUUID() }, { now: new Date('2026-09-01T00:00:01Z') }), /budget_exceeded_agent/);
});
test('settlement failure after provider return never becomes a provider-threw unknown settlement', async t => {
  const { scope } = fixture(t);
  const original = db.transaction.bind(db);
  let returned = false, settlementTransactions = 0;
  t.mock.method(db, 'transaction', (async (work: any) => {
    if (returned) { settlementTransactions++; throw new Error('synthetic settlement unavailable'); }
    return original(work);
  }) as typeof db.transaction);
  await assert.rejects(executeUsage(scope, async () => { returned = true; return { success: true, output: 'OK', sessionId: 's', durationSeconds: 1, costUsd: 1, tokensUsed: 0, usage: facts('1') }; }), /synthetic settlement unavailable/);
  assert.equal(settlementTransactions, 1);
});
test('small numeric transport costs agree with decimal string costs', () => {
  const transport = { version: 1, costStatus: 'actual', tokenStatus: 'unknown', costUsd: 0.00000019 };
  assert.equal(transportUsage(transport, 'fixture')?.costUsd, '0.00000019');
});
test('admitted runtime and reporting source cannot be changed by settlement', async t => {
  const { scope } = fixture(t);
  await admitUsage(scope);
  await assert.rejects(settleUsage({ ...scope, reportingSource: 'another-runtime-account' }, facts('1')), /usage_attempt_identity_conflict/);
});
test('unknown reservation takes the smaller of simultaneous hard caps', async t => {
  const { scope, agent, card } = fixture(t); agent.budgetMonthly = '10'; card.taskBudgetLimit = '1';
  const admitted = await admitUsage(scope);
  assert.equal(admitted.reservationUsd, '1.00000000');
});
