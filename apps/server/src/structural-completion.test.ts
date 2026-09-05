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

for (const requiresApproval of [true, false]) test(`ownerless accepted-child cascade routes goal assessment without bypassing client approval (${requiresApproval})`, async t => {
  const parent: any = { id: 'parent', companyId: 'c', projectId: null, title: 'Goal', assigneeId: null, reviewerId: null, columnStatus: 'in_progress', requiresApproval, requiredChildPolicy: 'all_required_accepted' };
  const child: any = { id: 'child', parentCardId: parent.id, companyId: 'c', projectId: null, title: 'Findings', assigneeId: 'worker', columnStatus: 'done' };
  const { workProducts } = await import('./db/schema.ts');
  const state = memoryDb(t, [[kanbanCards, [parent, child]], [workProducts, [{ id: 'product', cardId: child.id, companyId: 'c', projectId: null, agentId: 'worker', type: 'report', summary: 'Verified findings' }]]]);
  const { readyCompany } = await import('./test-support/ready-company.ts');
  const { bossId } = readyCompany(state, 'c');
  const { captureDeliveryAcceptance } = await import('./delivery-acceptance.ts');
  const { cascadeParentStatus } = await import('./dispatch.ts');
  child.deliveryAcceptance = await captureDeliveryAcceptance(child); assert.ok(child.deliveryAcceptance);
  await cascadeParentStatus(parent.id);
  assert.notEqual(parent.columnStatus, 'done');
  assert.equal(parent.assigneeId, bossId, 'normal structural Boss routing supplies goal assessment');
  assert.equal(parent.requiresApproval, requiresApproval);
  assert.equal(state.rows(taskRuns).filter(row => row.cardId === parent.id && row.kind === 'dispatch' && row.status === 'queued').length, 1);
  assert.equal(state.rows(approvals).length, 0, 'owner routing does not invent an early client gate');
});

for (const interruption of ['unavailable_boss', 'concurrent_human_gate'] as const) test(`ownerless cascade preserves ${interruption}`, async t => {
  const parent: any = { id: 'parent', companyId: 'c', projectId: null, title: 'Goal', assigneeId: null, reviewerId: null, columnStatus: 'in_progress', requiresApproval: true, requiredChildPolicy: 'all_required_accepted' };
  const child: any = { id: 'child', parentCardId: parent.id, companyId: 'c', projectId: null, title: 'Report', assigneeId: 'worker', columnStatus: 'done' };
  const { workProducts } = await import('./db/schema.ts');
  const state = memoryDb(t, [[kanbanCards, [parent, child]], [workProducts, [{ id: 'p', companyId: 'c', projectId: null, cardId: child.id, agentId: 'worker', type: 'report', summary: 'Accepted findings' }]]]);
  const { readyCompany } = await import('./test-support/ready-company.ts');
  const { bossId } = readyCompany(state, 'c');
  const { captureDeliveryAcceptance } = await import('./delivery-acceptance.ts');
  child.deliveryAcceptance = await captureDeliveryAcceptance(child); assert.ok(child.deliveryAcceptance);
  if (interruption === 'unavailable_boss') state.rows(agents).find(row => row.id === bossId)!.isBusy = true;
  else {
    const { db } = await import('./db/client.ts');
    const update = db.update.bind(db);
    t.mock.method(db, 'update', ((table: any) => ({ set(values: any) {
      if (table === kanbanCards && (values.assigneeId || values.columnStatus === 'done')) state.rows(approvals).push({ id: 'human', cardId: parent.id, type: 'task_review', status: 'pending', payload: { humanGate: true } });
      return update(table).set(values);
    } })) as any);
  }
  const { cascadeParentStatus } = await import('./dispatch.ts');
  await cascadeParentStatus(parent.id);
  assert.notEqual(parent.columnStatus, 'done'); assert.equal(parent.assigneeId, null);
  assert.equal(state.rows(taskRuns).filter(row => row.cardId === parent.id && row.status === 'queued').length, 0);
  if (interruption === 'unavailable_boss') { assert.equal(parent.columnStatus, 'blocked'); assert.match(parent.lastError, /Boss|owner/); }
  else { assert.equal(parent.columnStatus, 'in_progress'); assert.equal(state.rows(approvals)[0]?.status, 'pending'); }
});
