import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, companies, departments, positions, kanbanCards, machineRunners, taskRuns, approvals } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { dispatchCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
test('runner claim rejects incomplete structure and includes current common role context once setup is ready', async t => {
  const companyId = randomUUID(), headId = randomUUID(), bossId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const card: any = { id: randomUUID(), companyId, title: 'Build', body: 'Acceptance: works', assigneeId: headId, columnStatus: 'todo', tags: [] };
  const run: any = { id: randomUUID(), companyId, cardId: card.id, agentId: headId, kind: 'dispatch', status: 'queued' };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Claim company' }]], [agents, [{ id: headId, companyId, name: 'Head', slug: 'head', departmentId, isActive: true, adapterType: 'webhook' }]], [kanbanCards, [card]], [taskRuns, [run]], [machineRunners, [{ id: 'runner', companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-claim') }]]]);
  const app = Fastify(); t.after(() => app.close()); await registerRunnerRoutes(app);
  const claim = () => app.inject({ method: 'POST', url: '/api/runner/task-runs/claim', headers: { 'x-megacorps-runner-key': 'synthetic-claim' }, payload: {} });
  assert.equal((await claim()).json().taskRun, null); assert.match(run.error, /Boss|department/); assert.equal(run.status, 'queued');
  state.rows(positions).push({ id: positionId, companyId, isCompanyBoss: true });
  state.rows(agents).push({ id: bossId, companyId, positionId, name: 'Boss', isActive: true, adapterType: 'webhook' });
  state.rows(departments).push({ id: departmentId, companyId, headAgentId: headId, name: 'Engineering', headRolePrompt: 'Current head charter' });
  const ready = await claim(); assert.equal(ready.statusCode, 200, ready.body); assert.equal(ready.json().taskRun.id, run.id);
  assert.match(ready.json().companyContext, /Current head charter/); assert.match(ready.json().companyContext, /SELF-CHECK|self-check/);
});

for (const via of ['dispatch', 'webhook', 'runner'] as const) for (const role of ['boss', 'sole_head', 'staffed_head', 'checked_head', 'critical_head'] as const) test(`${via} enforces ${role} structural delivery requirements`, async (t) => {
  const companyId = randomUUID(), bossId = randomUUID(), headId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const actorId = role === 'boss' ? bossId : headId;
  const common = { companyId, adapterType: 'webhook', isActive: true, isBusy: false, capabilities: [] };
  const card: any = { id: randomUUID(), companyId, title: 'Build requested deliverable', body: '## Acceptance\n- Deliver verified result', columnStatus: 'in_progress', assigneeId: actorId, requiresApproval: false, tags: [], dependencyCardIds: [] };
  if (role === 'critical_head') { card.reviewMode = 'panel'; card.reviewerIds = []; }
  const run = { id: randomUUID(), cardId: card.id, companyId, agentId: actorId, kind: 'dispatch', status: 'running', lockedBy: 'runner' };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Fixture' }]], [positions, [{ id: positionId, companyId, name: 'Boss', isCompanyBoss: true }]], [departments, [{ id: departmentId, companyId, name: 'Engineering', headAgentId: headId }]], [agents, [{ ...common, id: bossId, name: 'Boss', slug: 'boss', positionId }, { ...common, id: headId, name: 'Head', slug: 'head', departmentId }, ...(role === 'staffed_head' ? [{ ...common, id: randomUUID(), name: 'Employee', slug: 'employee', departmentId }] : [])]], [kanbanCards, [card]], [taskRuns, [run]], [machineRunners, [{ id: 'runner', companyId, name: 'Runner', apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
  const checked = role === 'checked_head' || role === 'critical_head';
  const report = { kind: 'megacorps-report', status: 'completed', summary: checked ? 'SELF-CHECK: Verified the durable report against every acceptance criterion.' : 'Work completed', ...(checked ? { artifactRefs: ['https://example.test/durable-report'] } : {}) };
  const app = Fastify(); t.after(() => app.close());
  if (via === 'dispatch') {
    t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report), sessionId: 'test', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
    await dispatchCard(card.id, 'manual', { taskRunId: run.id });
  } else {
    const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-webhook';
    t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
    if (via === 'webhook') await registerRoutes(app); else await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: via === 'webhook' ? '/api/webhook/task-complete' : `/api/runner/task-runs/${run.id}/complete`, headers: via === 'webhook' ? { 'x-megacorps-webhook-secret': 'synthetic-webhook' } : { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { ...(via === 'webhook' ? { cardId: card.id, taskRunId: run.id } : {}), status: via === 'webhook' ? 'done' : 'success', report } });
    assert.ok(response.statusCode < 500, response.body);
  }
  assert.notEqual(card.columnStatus, 'done');
  if (checked) {
    assert.equal(card.columnStatus, 'in_review');
    assert.equal(card.reviewerId, bossId);
    if (role === 'critical_head') assert.ok(state.rows(approvals).some(row => row.status === 'pending' && row.payload?.humanGate), 'independent reviewer shortage requires client decision');
    return;
  }
  assert.ok(card.protocolRepairState?.dispatch?.failures || card.runRetryState?.dispatch?.failures, 'structural correction uses a bounded repair budget: ' + JSON.stringify({lastError: card.lastError, retryCount: card.retryCount, repair:card.protocolRepairState, retries:card.runRetryState}));
});
