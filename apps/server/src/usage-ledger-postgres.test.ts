import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL 16 usage ledger admission, settlement and merge-fence diagnostics', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; real ledger transactions run in CI' : false, timeout: 60_000 }, async t => {
  const { db } = await isolatedPostgres(t);
  const { companies, agents, projects, kanbanCards, taskRuns, costEvents, budgetPolicies, budgetThresholds, externalWaits, mergeIntents } = await import('./db/schema.ts');
  const { admitUsage, settleUsage, summarizeUsage, utcPeriod } = await import('./usage-ledger.ts');
  const { unknownUsage } = await import('./usage-facts.ts');
  const now = new Date('2026-09-03T10:00:00Z');
  const facts = (cost: string, status: 'actual' | 'estimated' = 'actual') => ({ ...unknownUsage('synthetic_runtime_report'), costStatus: status, costUsd: cost });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'Usage fixture', slug: `usage-${randomUUID()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: 'Original worker', slug: 'original', role: 'worker', adapterType: 'webhook' }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: 'Usage project' }).returning();
    const [card] = await db.insert(kanbanCards).values({ companyId: company!.id, projectId: project!.id, title: 'Direct execution', body: '', columnStatus: 'in_progress' }).returning();
    const scope = { companyId: company!.id, agentId: agent!.id, cardId: card!.id, projectId: project!.id, attemptKey: randomUUID(), source: 'fixture', reportingSource: `runtime-account:${randomUUID()}` };
    return { company: company!, agent: agent!, card: card!, project: project!, scope };
  }
  await t.test('company-first admission permits only one concurrent unknown call against a shared allowance', async () => {
    const f = await fixture();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: 'Other worker', slug: 'other', role: 'worker', adapterType: 'webhook' }).returning();
    await db.insert(budgetPolicies).values({ companyId: f.company.id, name: 'Shared allowance', monthlyLimitUsd: '1', hardStop: true });
    const outcomes = await Promise.allSettled([admitUsage(f.scope, { now }), admitUsage({ ...f.scope, agentId: other!.id, cardId: null, attemptKey: randomUUID() }, { now })]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const failure = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(failure.reason), /budget_exceeded_company/);
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.reservationUsd, '1.00000000');
  });
  await t.test('parallel settlements, factual deltas and provider-event replay remain exact', async () => {
    const f = await fixture();
    await db.insert(budgetPolicies).values({ companyId: f.company.id, name: 'Warning', monthlyLimitUsd: '10', hardStop: false, warnAtPercent: 90 });
    const second = { ...f.scope, attemptKey: randomUUID() }, third = { ...f.scope, attemptKey: randomUUID() };
    await Promise.all([settleUsage(f.scope, facts('8'), { now }), settleUsage(second, facts('1.50000019', 'estimated'), { now }), settleUsage(third, facts('1.50000019'), { now })]);
    const report = { ...facts('2.00000019'), providerEventId: 'stable-real-event' };
    await Promise.all([settleUsage(second, report, { now }), settleUsage(second, report, { now })]);
    await assert.rejects(settleUsage({ ...second, attemptKey: randomUUID() }, report, { now }), /usage_provider_event_already_bound/);
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id));
    assert.equal(rows.length, 3); assert.equal(summarizeUsage(rows, { period: utcPeriod(now) }, now).actualUsd, '11.50000038');
    assert.equal((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]!.spentThisMonth, '11.50000038');
    assert.equal((await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id)))[0]!.costUsd, '11.50000038');
    assert.equal((await db.select().from(budgetThresholds).where(eq(budgetThresholds.companyId, f.company.id))).length, 1);
  });
  for (const state of ['accepted', 'uncertain'] as const) await t.test(`${state} merge permits original cancelled-attempt usage without changing authority`, async () => {
    const f = await fixture();
    const [run] = await db.insert(taskRuns).values({ companyId: f.company.id, cardId: f.card.id, agentId: f.agent.id, kind: 'dispatch', status: 'cancelled' }).returning();
    await db.update(projects).set({ repoProvider: 'gitea-local', managedRepoFullName: 'org/repo', defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: true }).where(eq(projects.id, f.project.id));
    await db.update(kanbanCards).set({ columnStatus: 'waiting_on_external' }).where(eq(kanbanCards.id, f.card.id));
    const [wait] = await db.insert(externalWaits).values({ cardId: f.card.id, companyId: f.company.id, waitingFor: 'merge', provider: 'gitea', status: 'waiting', authorizedHeadSha: 'a'.repeat(40), externalId: '12' }).returning();
    const [before] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id));
    const [intent] = await db.insert(mergeIntents).values({ cardId: f.card.id, projectId: f.project.id, waitId: wait!.id, headSha: 'a'.repeat(40), repoFullName: 'org/repo', defaultBranch: 'main', gateVersion: before!.mergeGateVersion, state: 'prepared' }).returning();
    await db.update(mergeIntents).set({ state }).where(eq(mergeIntents.id, intent!.id));
    await settleUsage({ ...f.scope, taskRunId: run!.id }, facts('0.25000019'), { now });
    const [after] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, f.card.id));
    assert.deepEqual({ ...after, costUsd: before!.costUsd }, before);
    assert.equal(after!.costUsd, '0.25000019');
    assert.equal((await db.select().from(taskRuns).where(eq(taskRuns.id, run!.id)))[0]!.status, 'cancelled');
    assert.equal((await db.select().from(mergeIntents).where(eq(mergeIntents.id, intent!.id)))[0]!.state, state);
    function conflict(error: any): boolean { return error?.code === 'MC409' || Boolean(error?.cause && conflict(error.cause)); }
    await assert.rejects(db.update(kanbanCards).set({ columnStatus: 'cancelled' }).where(eq(kanbanCards.id, f.card.id)), conflict);
  });
});
