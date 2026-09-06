import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetOk, getBudgetGuard } from './dispatch.ts';
import { memoryDb } from './test-support/memory-db.ts';

const agent: any = { id: 'agent-fixture', companyId: 'company-fixture', isActive: true, spentThisMonth: '12' };
const warning: any = { id: 'policy-fixture', companyId: agent.companyId, agentId: agent.id, monthlyLimitUsd: '10', warnAtPercent: 90, hardStop: false, isActive: true };

test('warning-only budget does not reject admission above its threshold', async () => {
  assert.equal(await budgetOk(agent, [warning]), true);
});
test('configured 90 percent warning is honored', async () => {
  assert.equal((await getBudgetGuard(agent, [warning])).warnAtPercent, 90);
});
test('disabled preloaded policy has no admission effect', async () => {
  assert.equal(await budgetOk(agent, [{ ...warning, hardStop: true, isActive: false }]), true);
});
test('admission uses the current UTC ledger period rather than a stale month cache', async t => {
  memoryDb(t, []);
  assert.equal(await budgetOk({ ...agent, budgetMonthly: '1', spentThisMonth: '1' }), true);
});
test('manual pause is enforced even with no configured budget', async t => {
  memoryDb(t, []);
  assert.equal(await budgetOk({ ...agent, isActive: false }), false);
});
