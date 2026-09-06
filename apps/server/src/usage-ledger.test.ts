import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, agentRuntimes, companies, costEvents, kanbanCards, taskRuns, budgetPolicies, budgetThresholds } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { admitUsage, executeUsage, releaseUsage, settleUsage, settleTaskRunUsage, summarizeUsage, usageBudgetState, utcPeriod, type AttemptScope } from './usage-ledger.ts';
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

test('incremental cumulative cost keeps residual exposure across duplicates, corrections and cancellation', async t => {
  const { scope, state, agent } = fixture(t); agent.budgetMonthly = '1';
  await admitUsage(scope, { now: september });
  const progress = { now: september, phase: 'progress' as const };
  const entry = () => state.rows(costEvents)[0]!;
  const expiry = entry().reservationExpiresAt;
  await settleUsage(scope, facts('0.4'), progress);
  assert.equal(entry().reservationUsd, '0.60000000'); assert.equal(entry().settledAt ?? null, null);
  await settleUsage(scope, facts('0.4'), progress); assert.equal(entry().reservationUsd, '0.60000000');
  await settleUsage(scope, facts('0.2'), progress); assert.equal(entry().reservationUsd, '0.80000000');
  await settleUsage(scope, { ...unknownUsage('tokens_only'), tokenStatus: 'actual', inputTokens: 0 }, progress);
  assert.equal(entry().reservationUsd, '0.80000000'); assert.equal(entry().costUsd, '0.2'); assert.deepEqual(entry().reservationExpiresAt, expiry);
  await releaseUsage(scope); await releaseUsage(scope);
  assert.equal(entry().reservationUsd, null); assert.equal(entry().costUsd, '0.2'); const terminal = entry().settledAt;
  await settleUsage(scope, unknownUsage('late_progress'), progress);
  assert.equal(entry().reservationUsd, null); assert.equal(entry().costUsd, '0.2'); assert.deepEqual(entry().settledAt, terminal);
  await settleUsage(scope, facts('0.25'), progress);
  assert.equal(entry().reservationUsd, null); assert.equal(entry().costUsd, '0.25');
});
test('progress does not extend bounded reservation expiry and later terminal facts remain payable', async t => {
  const { scope, state, agent } = fixture(t); agent.budgetMonthly = '1';
  const start = new Date('2026-09-03T00:00:00Z');
  await admitUsage(scope, { now: start, timeoutSeconds: 1 });
  const expiry = state.rows(costEvents)[0]!.reservationExpiresAt;
  const progress = { now: september, phase: 'progress' as const };
  await settleUsage(scope, facts('0.25'), progress);
  assert.deepEqual(state.rows(costEvents)[0]!.reservationExpiresAt, expiry);
  assert.equal(summarizeUsage(state.rows(costEvents) as any, {}, september).reservedUsd, '0.00000000');
  await admitUsage({ ...scope, attemptKey: randomUUID() }, { now: september });
  await settleUsage(scope, facts('1.25'), { now: september });
  assert.equal(agent.spentThisMonth, '1.25000000'); assert.equal(state.rows(costEvents)[0]!.reservationUsd, null);
});
test('incremental actual overage stays booked and lower-rank progress cannot release allowance', async t => {
  const { scope, state, agent } = fixture(t); agent.budgetMonthly = '1';
  await admitUsage(scope, { now: september });
  const progress = { now: september, phase: 'progress' as const };
  await settleUsage(scope, facts('1.2'), progress);
  await settleUsage(scope, facts('0.1', 'estimated'), progress);
  await settleUsage(scope, unknownUsage('unknown_progress'), progress);
  assert.equal(state.rows(costEvents)[0]!.costUsd, '1.2'); assert.equal(state.rows(costEvents)[0]!.reservationUsd, '0.00000000');
  assert.equal(state.rows(costEvents)[0]!.settledAt ?? null, null);
  await assert.rejects(admitUsage({ ...scope, attemptKey: randomUUID() }, { now: september }), /budget_exceeded_agent/);
  await settleUsage(scope, facts('1.3'), { now: september });
  assert.equal(agent.spentThisMonth, '1.30000000'); assert.equal(state.rows(costEvents)[0]!.reservationUsd, null);
});

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
for (const provider of ['provider-a', null]) for (const repeatEventId of [false, true]) {
  test(`bound ${provider ?? 'unknown'} provider rejects namespace correction with event ID ${repeatEventId ? 'repeated' : 'omitted'}`, async t => {
    const { scope, state, agent, card } = fixture(t);
    await settleUsage(scope, { ...facts('1'), provider, providerEventId: 'event-1' });
    const before = structuredClone({ rows: state.rows(costEvents), agent, card });
    const correction = transportUsage({ version: 1, costStatus: 'actual', costUsd: '2', tokenStatus: 'actual', cacheReadTokens: 2,
      provider: 'provider-b', ...(repeatEventId ? { providerEventId: 'event-1' } : {}) }, 'correction')!;
    await assert.rejects(settleUsage(scope, correction), /usage_attempt_identity_conflict/);
    assert.deepEqual({ rows: state.rows(costEvents), agent, card }, before);
    await assert.rejects(settleUsage({ ...scope, attemptKey: randomUUID() }, { ...facts('1'), provider, providerEventId: 'event-1' }), /usage_provider_event_already_bound/);
    assert.equal(summarizeUsage(state.rows(costEvents) as any).totalUsd, '1.00000000');
  });
}
test('original provider event replay stays deduplicated after an omitted-ID namespace correction', async t => {
  const { scope, state } = fixture(t);
  const original = { ...facts('1'), provider: 'provider-a', providerEventId: 'event-1' };
  await settleUsage(scope, original);
  await settleUsage(scope, { ...unknownUsage('correction'), provider: 'provider-b', tokenStatus: 'actual', cacheReadTokens: 2 }).catch(() => {});
  await assert.rejects(settleUsage({ ...scope, attemptKey: randomUUID() }, original), /usage_provider_event_already_bound/);
  assert.equal(state.rows(costEvents).length, 1);
  assert.equal(summarizeUsage(state.rows(costEvents) as any).totalUsd, '1.00000000');
});
test('bound event survives provider-omitted correction and rejects a different explicit event', async t => {
  const { scope, state } = fixture(t);
  await settleUsage(scope, { ...facts('1'), provider: 'provider-a', providerEventId: 'event-1' });
  await settleUsage(scope, facts('2'));
  assert.equal(state.rows(costEvents)[0]!.providerEventId, 'event-1');
  assert.equal(state.rows(costEvents)[0]!.usage.providerEventId, 'event-1');
  await assert.rejects(settleUsage(scope, { ...facts('3'), providerEventId: 'event-2' }), /usage_attempt_provider_event_conflict/);
  assert.equal(summarizeUsage(state.rows(costEvents) as any).totalUsd, '2.00000000');
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
test('partial actual transport correction retains absent token facts and accepts explicit zero corrections', async t => {
  const { scope, state } = fixture(t);
  const report = (tokens: Record<string, number>) => transportUsage({ version: 1, costStatus: 'unknown', tokenStatus: 'actual', ...tokens }, 'runtime_tokens')!;
  await settleUsage(scope, report({ inputTokens: 9, outputTokens: 3, totalTokens: 12 }));
  await settleUsage(scope, report({ cacheReadTokens: 2 }));
  const usage = () => state.rows(costEvents)[0]!.usage;
  assert.deepEqual([usage().inputTokens, usage().outputTokens, usage().totalTokens, usage().cacheReadTokens], [9, 3, 12, 2]);
  await settleUsage(scope, report({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }));
  assert.deepEqual([usage().inputTokens, usage().outputTokens, usage().cacheReadTokens, usage().cacheWriteTokens, usage().reasoningTokens, usage().totalTokens], [0, 0, 0, 0, 0, 0]);
  assert.equal(usage().tokenStatus, 'actual');
});
test('mixed partial transport reports retain per-field provenance without upgrading old estimates', async t => {
  const { scope, state } = fixture(t);
  const report = (status: string, tokens: Record<string, number>, source: string) => transportUsage({ version: 1, costStatus: 'unknown', tokenStatus: status, ...tokens }, source)!;
  await settleUsage(scope, report('estimated', { inputTokens: 9, outputTokens: 3, totalTokens: 12 }, 'legacy_estimate'));
  // Simulate an existing persisted row predating per-field provenance.
  delete state.rows(costEvents)[0]!.usage.tokenProvenance;
  await settleUsage(scope, report('actual', { cacheReadTokens: 2 }, 'actual_cache'));
  const usage = () => state.rows(costEvents)[0]!.usage;
  assert.equal(usage().tokenStatus, 'estimated');
  assert.deepEqual([usage().inputTokens, usage().outputTokens, usage().totalTokens, usage().cacheReadTokens], [9, 3, 12, 2]);
  assert.equal(usage().tokenSource, 'legacy_estimate');
  assert.deepEqual(usage().tokenProvenance.inputTokens, { status: 'estimated', source: 'legacy_estimate' });
  assert.deepEqual(usage().tokenProvenance.cacheReadTokens, { status: 'actual', source: 'actual_cache' });
  await settleUsage(scope, report('estimated', { inputTokens: 8, totalTokens: 11, cacheReadTokens: 99 }, 'corrected_estimate'));
  assert.deepEqual([usage().inputTokens, usage().totalTokens, usage().cacheReadTokens], [8, 11, 2]);
  await settleUsage(scope, report('actual', { outputTokens: 4, totalTokens: 14 }, 'actual_total'));
  assert.deepEqual([usage().inputTokens, usage().outputTokens, usage().totalTokens, usage().cacheReadTokens], [8, 4, 14, 2]);
  assert.equal(usage().tokenStatus, 'actual');
  assert.equal(usage().tokenSource, 'actual_total');
  assert.deepEqual(usage().tokenProvenance.inputTokens, { status: 'estimated', source: 'corrected_estimate' });
});
test('cost-only transport correction cannot wipe tokens or upgrade their status from an empty token declaration', async t => {
  const { scope, state } = fixture(t);
  await settleUsage(scope, transportUsage({ version: 1, costStatus: 'unknown', tokenStatus: 'estimated', totalTokens: 12 }, 'estimated_tokens')!);
  const before = structuredClone(state.rows(costEvents)[0]!.usage);
  await settleUsage(scope, transportUsage({ version: 1, costStatus: 'actual', costUsd: '0.25', tokenStatus: 'actual' }, 'cost_only')!);
  const usage = state.rows(costEvents)[0]!.usage;
  assert.equal(usage.totalTokens, 12);
  assert.equal(usage.tokenStatus, 'estimated');
  assert.equal(usage.tokenSource, 'estimated_tokens');
  assert.deepEqual(usage.tokenProvenance, before.tokenProvenance);
  assert.equal(usage.costUsd, '0.25000000');
  assert.equal(usage.costSource, 'cost_only');
});
test('token reports without a total expose conservative mixed provenance and ignore client provenance overrides', async t => {
  const { scope, state } = fixture(t);
  await settleUsage(scope, transportUsage({ version: 1, costStatus: 'unknown', tokenStatus: 'actual', inputTokens: 9 }, 'actual_input')!);
  await settleUsage(scope, transportUsage({ version: 1, costStatus: 'unknown', tokenStatus: 'estimated', inputTokens: null, outputTokens: 3,
    tokenProvenance: { outputTokens: { status: 'actual', source: 'untrusted_override' } } }, 'estimated_output')!);
  const usage = state.rows(costEvents)[0]!.usage;
  assert.deepEqual([usage.inputTokens, usage.outputTokens, usage.totalTokens], [9, 3, null]);
  assert.equal(usage.tokenStatus, 'estimated');
  assert.equal(usage.tokenSource, 'mixed_token_provenance');
  assert.deepEqual(usage.tokenProvenance.inputTokens, { status: 'actual', source: 'actual_input' });
  assert.deepEqual(usage.tokenProvenance.outputTokens, { status: 'estimated', source: 'estimated_output' });
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
