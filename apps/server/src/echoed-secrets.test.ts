import assert from 'node:assert/strict';
import test from 'node:test';
import { agents, agentRuntimes, projects, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { persistAgentWorkProducts } from './agent-results.ts';
import { redactPromptForLog } from './prompt-logs.ts';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { kanbanCards, machineRunners, taskRuns, cardComments } from './db/schema.ts';
import { registerRoutes } from './routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { hashRunnerApiKey } from './runner-auth.ts';
import { addCardMessage } from './dispatch.ts';

test('known credential values are redacted even when echoed without a credential label', () => {
  assert.equal(redactPromptForLog('echo synthetic-plain-secret-1847', ['synthetic-plain-secret-1847']), 'echo [redacted]');
  assert.equal(redactPromptForLog('https://example.test/file?access_token=synthetic-query-secret'), 'https://example.test/file?access_token=[redacted]');
});

for (const via of ['webhook', 'runner', 'message'] as const) test(`${via} never persists echoed credentials in card, comment or metadata`, async (t) => {
  const sentinel = 'synthetic-echo-secret-398417';
  const card: any = { id: randomUUID(), companyId: randomUUID(), title: 'Report', columnStatus: 'in_progress', assigneeId: null };
  const run = { id: randomUUID(), cardId: card.id, companyId: card.companyId, kind: 'dispatch', status: 'running', lockedBy: 'runner' };
  const state = memoryDb(t, [[kanbanCards, [card]], [taskRuns, [run]], [agents, [{ id: randomUUID(), companyId: card.companyId, giteaToken: sentinel }]], [machineRunners, [{ id: 'runner', companyId: card.companyId, apiKeyHash: hashRunnerApiKey('synthetic-runner') }]]]);
  if (via === 'message') await addCardMessage({ cardId: card.id, action: 'delegate_request', body: `Echo ${sentinel}`, metadata: { sourceContext: `Ancestor ${sentinel}` } });
  else {
    const app = Fastify(); t.after(() => app.close());
    const old = process.env.WEBHOOK_SHARED_SECRET; process.env.WEBHOOK_SHARED_SECRET = 'synthetic-webhook';
    t.after(() => { if (old === undefined) delete process.env.WEBHOOK_SHARED_SECRET; else process.env.WEBHOOK_SHARED_SECRET = old; });
    if (via === 'webhook') await registerRoutes(app); else await registerRunnerRoutes(app);
    const response = await app.inject({ method: 'POST', url: via === 'webhook' ? '/api/webhook/task-complete' : `/api/runner/task-runs/${run.id}/complete`, headers: via === 'webhook' ? { 'x-megacorps-webhook-secret': 'synthetic-webhook' } : { 'x-megacorps-runner-key': 'synthetic-runner' }, payload: { ...(via === 'webhook' ? { cardId: card.id, taskRunId: run.id } : {}), status: via === 'webhook' ? 'done' : 'success', summary: `Completed ${sentinel}` } });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.ok(!JSON.stringify([state.rows(kanbanCards), state.rows(cardComments), state.rows(taskRuns)]).includes(sentinel));
});

test('canonical work products redact echoed company credentials recursively while retaining provenance', async (t) => {
  const sentinel = 'synthetic-work-secret-847129';
  const state = memoryDb(t, [[agents, [{ id: 'worker', companyId: 'company', giteaToken: sentinel }]], [projects, [{ id: 'project', companyId: 'company', publishToken: 'synthetic-publish-secret' }]], [agentRuntimes, []]]);
  await persistAgentWorkProducts({ id: 'card', companyId: 'company', projectId: 'project' }, 'worker', 'run', [{ type: 'report', title: `Results ${sentinel}`, metadata: { evidence: `Observed ${sentinel}`, nested: { Authorization: 'Bearer synthetic-header-secret', token: sentinel } } }]);
  const rows = state.rows(workProducts);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.agentId, 'worker'); assert.equal(rows[0]!.taskRunId, 'run');
  assert.ok(!JSON.stringify(rows).includes(sentinel)); assert.ok(!JSON.stringify(rows).includes('synthetic-header-secret'));
});

for (const mode of ['returned', 'exception'] as const) test(`ordinary review sanitizes ${mode} credentials before persistence and forwarding`, async t => {
  const sentinel = 'synthetic-review-secret-725184';
  const card: any = { id: 'review-card', companyId: 'c', title: 'Review', assigneeId: 'worker', reviewerId: 'reviewer', columnStatus: 'in_review', requiresApproval: false, tags: [], dependencyCardIds: [] };
  const reviewer = { id: 'reviewer', companyId: 'c', name: 'Reviewer', slug: 'reviewer', adapterType: 'webhook', isActive: true, isBusy: false, giteaToken: sentinel };
  const state = memoryDb(t, [[kanbanCards, [card]], [agents, [reviewer]], [taskRuns, [{ id: 'review-run', companyId: 'c', cardId: card.id, agentId: reviewer.id, kind: 'review', status: 'running' }]]]);
  const { getAdapter } = await import('./adapters/registry.ts');
  const { reviewCard } = await import('./dispatch.ts');
  const { heartbeatRuns, taskLogs } = await import('./db/schema.ts');
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    if (mode === 'exception') throw new Error(`Review failed while echoing ${sentinel}`);
    return { success: true, output: `VERDICT: APPROVED\nVerified ${sentinel}`, sessionId: 'safe-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  let forwarded: unknown;
  try { forwarded = await reviewCard(card.id, { taskRunId: 'review-run' }); } catch (error) { forwarded = String(error); }
  assert.ok(!JSON.stringify([forwarded, card, state.rows(taskRuns), state.rows(heartbeatRuns), state.rows(taskLogs), state.rows(cardComments)]).includes(sentinel));
  assert.equal(reviewer.giteaToken, sentinel, 'authorized execution credential remains configured');
  assert.equal(card.columnStatus === 'done', mode === 'returned');
});
