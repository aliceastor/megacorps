import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { agents, cardComments, kanbanCards, taskRuns } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { reviewCard } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { normalizeAgentResult } from './agent-results.ts';
import { protocolFallback, protocolRepairSession, recordProtocolFailure, resetProtocolRepair } from './protocol-repair.ts';
import { departments, positions } from './db/schema.ts';

test('malformed review has persisted same-session then fresh-context repair, then one actionable blocker', async (t) => {
  const card: any = { id: randomUUID(), companyId: 'company', title: 'Review deliverable', assigneeId: 'author', reviewerId: 'reviewer', columnStatus: 'in_review', tags: [], runRetryState: {} };
  const agent = { id: 'reviewer', companyId: 'company', name: 'Reviewer', slug: 'reviewer', isActive: true, isBusy: false, adapterType: 'webhook', capabilities: [] };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [agent]]]);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: '{"kind":"megacorps-report","status":"bogus","summary":"Invalid answer"}', sessionId: 'session-1', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const id = randomUUID(); state.rows(taskRuns).push({ id, cardId: card.id, companyId: card.companyId, agentId: agent.id, kind: 'review', status: 'running' });
    await reviewCard(card.id, { taskRunId: id });
    assert.equal(card.protocolRepairState?.review?.failures, attempt);
    assert.equal(card.protocolRepairState.review.mode, attempt === 1 ? 'same_session' : attempt === 2 ? 'fresh_context' : 'blocked');
    assert.deepEqual(card.runRetryState, {}, 'protocol errors do not consume transport retry budget');
  }
  assert.equal(card.columnStatus, 'blocked');
  assert.match(card.lastError, /report|reply/i);
  assert.equal(state.rows(cardComments).filter((comment) => comment.action === 'protocol_help_required').length, 1);
});

test('duplicate run repair is durable, and vague/adapter-failed output cannot reset it', async (t) => {
  const card: any = { id: 'card', companyId: 'company', columnStatus: 'in_review', reviewerId: 'reviewer', runRetryState: { review: { failures: 2, nextRunAt: '2027-01-01T00:00:00.000Z' } } };
  const actor: any = { id: 'reviewer', companyId: 'company', isActive: true, adapterType: 'webhook' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [actor]]]);
  const input = { card, actor, kind: 'review' as const, runKey: 'run-1', reason: 'Missing verdict', sessionId: 'old-session' };
  await recordProtocolFailure(input);
  const restarted = structuredClone(card);
  await recordProtocolFailure({ ...input, card: restarted });
  assert.equal(card.protocolRepairState.review.failures, 1);
  assert.equal(state.rows(cardComments).length, 1);
  assert.equal(protocolRepairSession(restarted, 'review', actor.id), 'old-session');
  await resetProtocolRepair(card.id, 'review', normalizeAgentResult({ report: { kind: 'megacorps-report', status: 'progress', summary: 'Still working' } }), true);
  assert.equal(card.protocolRepairState.review.failures, 1, 'vague progress does not erase the protocol streak');
  const valid = normalizeAgentResult({ report: { kind: 'megacorps-report', status: 'progress', summary: 'Implemented the parser and verified two regression cases.' } });
  await resetProtocolRepair(card.id, 'review', valid, false);
  assert.equal(card.protocolRepairState.review.failures, 1);
  await recordProtocolFailure({ ...input, card: structuredClone(card), runKey: 'run-2' });
  assert.equal(protocolRepairSession(card, 'review', actor.id), null);
  await resetProtocolRepair(card.id, 'review', valid, true);
  assert.equal(card.protocolRepairState.review.failures, 0);
  assert.equal(card.runRetryState.review.failures, 2);
});

for (const scenario of ['eligible_head', 'self', 'boss', 'cycle', 'paused', 'busy', 'visited']) {
  test(`protocol fallback eligibility: ${scenario}`, async (t) => {
    const card: any = { id: 'card', companyId: 'company', assigneeId: 'author' };
    const actor: any = { id: 'actor', companyId: 'company', departmentId: 'department', bossId: scenario === 'self' ? 'actor' : 'head', adapterType: 'webhook' };
    const head: any = { id: 'head', companyId: 'company', role: 'head', positionId: 'head-position', bossId: scenario === 'cycle' ? actor.id : null, isActive: scenario !== 'paused', isBusy: scenario === 'busy', adapterType: 'webhook' };
    memoryDb(t, [[agents, [actor, head]], [departments, [{ id: 'department', headAgentId: scenario === 'self' ? actor.id : head.id }]], [positions, scenario === 'boss' ? [{ id: head.positionId, companyId: 'company', isCompanyBoss: true }] : []]]);
    assert.equal(await protocolFallback(card, actor, scenario === 'visited' ? [head.id] : []), scenario === 'eligible_head' ? head.id : null);
  });
}

test('invalid escalated help stops with the existing actionable request', async (t) => {
  const actor: any = { id: 'actor', companyId: 'company', bossId: 'head', adapterType: 'webhook' };
  const head: any = { id: 'head', companyId: 'company', role: 'head', isActive: true, isBusy: false, adapterType: 'webhook' };
  const card: any = { id: 'card', companyId: 'company', assigneeId: 'author', reviewerId: actor.id, columnStatus: 'in_review' };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [actor, head]]]);
  for (let n = 1; n <= 3; n++) await recordProtocolFailure({ card: structuredClone(card), actor, kind: 'review', runKey: `run-${n}`, reason: 'Invalid reply' });
  assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.reviewerId, head.id);
  await recordProtocolFailure({ card: structuredClone(card), actor: head, kind: 'review', runKey: 'help-run', reason: 'Invalid help reply' });
  assert.equal(card.columnStatus, 'blocked');
  assert.equal(state.rows(cardComments).filter((comment) => comment.action === 'protocol_help_required').length, 1);
});
