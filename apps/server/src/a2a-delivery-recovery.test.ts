import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db/client.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { companies, agents, kanbanCards, taskRuns, a2aExecutions, a2aExecutionAliases, workProducts, approvals, activityLog } from './db/schema.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { recoverMissingA2aDeliveryReceipt, terminalCompletedReport } from './a2a-delivery-recovery.ts';

const output = JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Accepted child delivery is complete.' });
async function fixture(t: Parameters<typeof memoryDb>[0]) {
  t.mock.method(db, 'execute', async () => [] as any);
  const completedAt = new Date(Date.now() - 60_000);
  const origin = { rowOrigin: '1120601', originAge: 178 };
  const root: any = { ...origin, firstEpoch: true, id: 'root', companyId: 'company', projectId: null, parentCardId: null, assigneeId: 'agent', columnStatus: 'done', title: 'Original assignment', body: 'Original instructions', completedAt, updatedAt: completedAt, updatedStamp: completedAt.toISOString(), completedStamp: completedAt.toISOString(), mergeGateVersion: 3 };
  const child: any = { id: 'child', companyId: 'company', projectId: null, parentCardId: root.id, assigneeId: 'child-agent', columnStatus: 'done', title: 'Accepted child' };
  const run: any = { ...origin, id: 'run', companyId: root.companyId, cardId: root.id, agentId: root.assigneeId, kind: 'dispatch', status: 'success', completedAt: new Date(completedAt.getTime() + 17), createdAt: new Date('2026-09-11T08:39:00Z'), output };
  const journal: any = { ...origin, key: 'task-run:run', agentId: root.assigneeId, companyId: root.companyId, active: false, record: { key: 'task-run:run', scope: JSON.stringify(['agent', 'task', 'root', 'management']), revision: 4, phase: 'terminal', outcome: { state: 'completed', text: output } } };
  const state = memoryDb(t, [[companies, [{ id: root.companyId }]], [agents, [{ id: 'agent', companyId: root.companyId, adapterType: 'a2a' }]], [kanbanCards, [root, child]], [taskRuns, [run]], [a2aExecutions, [journal]], [a2aExecutionAliases, [{ key: journal.key, executionKey: journal.key }]], [workProducts, [{ id: 'product', cardId: child.id, companyId: child.companyId, projectId: null, agentId: child.assigneeId, taskRunId: 'child-original-run', type: 'report', summary: 'Verified evidence' }]]]);
  child.deliveryAcceptance = await captureDeliveryAcceptance(child);
  return { root, child, run, journal, state };
}

test('repairs only the missing root receipt from original accepted child provenance, once', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.root);
  assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), true);
  assert.equal(f.root.deliveryAcceptance.inherited, true);
  assert.deepEqual(f.root.deliveryAcceptance.productIds, ['product']);
  assert.deepEqual({ ...f.root, deliveryAcceptance: undefined }, { ...before, deliveryAcceptance: undefined });
  assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
  assert.equal(f.state.rows(activityLog).length, 1);
  assert.equal(f.state.rows(activityLog)[0]!.details.taskRunId, f.run.id);
});

for (const failure of ['edited-root', 'newer-run', 'active-run', 'pending-gate', 'ambiguous-output', 'mismatched-output', 'active-journal', 'wrong-journal', 'no-accepted-children', 'late-completion', 'wrong-actor', 'non-root', 'existing-receipt']) test(`does not repair ${failure}`, async t => {
  const f = await fixture(t);
  if (failure === 'wrong-actor') f.run.agentId = 'other-agent';
  if (failure === 'non-root') f.root.parentCardId = 'another-root';
  if (failure === 'existing-receipt') f.root.deliveryAcceptance = { existing: true };
  if (failure === 'edited-root') { f.root.updatedStamp = '2026-09-11 08:40:45.540001+00'; }
  if (failure === 'newer-run') f.state.rows(taskRuns).push({ ...f.run, id: 'newer', createdAt: new Date('2026-09-11T08:50:00Z'), status: 'failed' });
  if (failure === 'active-run') f.state.rows(taskRuns).push({ ...f.run, id: 'active', createdAt: new Date('2026-09-11T08:38:00Z'), status: 'running' });
  if (failure === 'pending-gate') f.state.rows(approvals).push({ id: 'pending', cardId: f.child.id, status: 'pending' });
  if (failure === 'ambiguous-output') f.run.output = f.journal.record.outcome.text = output + '\n{"kind":"megacorps-report","status":"failed"}';
  if (failure === 'mismatched-output') f.journal.record.outcome.text = output + ' changed';
  if (failure === 'active-journal') f.journal.active = true;
  if (failure === 'wrong-journal') f.journal.agentId = 'replacement';
  if (failure === 'no-accepted-children') f.child.deliveryAcceptance = null;
  if (failure === 'late-completion') f.run.completedAt = new Date(f.root.completedAt.getTime() + 6_000);
  assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
  assert.deepEqual(f.root.deliveryAcceptance, failure === 'existing-receipt' ? { existing: true } : undefined);
  assert.equal(f.state.rows(activityLog).length, 0);
});

test('the newest standalone or fenced report must itself be valid and completed', () => {
  assert.ok(terminalCompletedReport(output));
  assert.ok(terminalCompletedReport('Earlier explanation\n```json\n' + output + '\n```'));
  assert.equal(terminalCompletedReport(output + '\n{"kind":"megacorps-report","status":'), null);
  assert.equal(terminalCompletedReport(output + '\n{"ordinary":"later response"}'), null);
  assert.equal(terminalCompletedReport(output + '\nUnverified trailing explanation'), null);
});

test('an audit failure rolls the receipt back atomically', async t => {
  const f = await fixture(t);
  const insert = db.insert.bind(db);
  t.mock.method(db, 'insert', ((table: any) => {
    if (table === activityLog) throw new Error('audit_unavailable');
    return insert(table);
  }) as typeof db.insert);
  await assert.rejects(recoverMissingA2aDeliveryReceipt(f.root.id), /audit_unavailable/);
  assert.equal(f.root.deliveryAcceptance, undefined);
  assert.equal(f.state.rows(activityLog).length, 0);
});

test('an incomplete outer JSON object cannot promote its nested report to final authority', () => {
  assert.equal(terminalCompletedReport('{"kind":"not-final","example":\n' + output), null);
});

test('an incomplete JSON array or prose-prefixed container cannot promote its nested report', () => {
  assert.equal(terminalCompletedReport('[\n' + output), null);
  assert.equal(terminalCompletedReport('Earlier explanation\n{"example":\n' + output), null);
});

test('a legitimately revoked root receipt cannot be recreated after children are reaccepted', async t => {
  const f = await fixture(t);
  f.root.deliveryAcceptance = await captureDeliveryAcceptance(f.root);
  assert.ok(f.root.deliveryAcceptance);
  f.root.deliveryAcceptance = null;
  f.root.mergeGateVersion++;
  f.root.rowOrigin = '1120602';
  f.child.deliveryAcceptance = await captureDeliveryAcceptance(f.child);
  assert.ok(f.child.deliveryAcceptance);
  assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
  assert.equal(f.root.deliveryAcceptance, null);
});

for (const failure of ['system-xmin', 'run-origin', 'journal-origin', 'old-origin', 'future-origin', 'wrapped-epoch', 'old-completion']) test(`rejects unsafe row provenance: ${failure}`, async t => {
  const f = await fixture(t);
  if (failure === 'system-xmin') f.root.rowOrigin = f.run.rowOrigin = f.journal.rowOrigin = '2';
  if (failure === 'run-origin') f.run.rowOrigin = '1120602';
  if (failure === 'journal-origin') f.journal.rowOrigin = '1120602';
  if (failure === 'old-origin') f.root.originAge = 1_000_001;
  if (failure === 'future-origin') f.root.originAge = -1;
  if (failure === 'wrapped-epoch') f.root.firstEpoch = false;
  if (failure === 'old-completion') f.root.completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  assert.equal(await recoverMissingA2aDeliveryReceipt(f.root.id), false);
  assert.equal(f.root.deliveryAcceptance, undefined);
});
