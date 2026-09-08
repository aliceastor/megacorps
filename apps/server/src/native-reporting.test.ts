import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { agentReportSchema } from '@megacorps/shared';
import { agents, companies, departments, positions, kanbanCards, taskRuns, cardComments, workProducts, approvals, projects } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { dispatchCard, runMessageDelegation, buildReviewPrompt, dispatchInternals, childrenFromOutput, processChildSplits } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import { buildAgentPrompt, type TaskContext } from './adapters/hermes.ts';
import { extractAgentReport } from './agent-report.ts';

type Role = 'boss' | 'head' | 'worker' | 'message';
function fixture(t: TestContext, role: Role) {
  const companyId = randomUUID(), departmentId = randomUUID(), positionId = randomUUID();
  const base = { companyId, adapterType: 'webhook', isActive: true, isBusy: false };
  const boss: any = { ...base, id: randomUUID(), slug: 'boss', name: 'Boss', positionId };
  const head: any = { ...base, id: randomUUID(), slug: 'head', name: 'Head', departmentId };
  const worker: any = { ...base, id: randomUUID(), slug: 'worker', name: 'Worker', departmentId, bossId: head.id };
  const actor = role === 'boss' ? boss : role === 'head' ? head : worker;
  const target = role === 'boss' ? head : worker;
  const card: any = { id: randomUUID(), companyId, title: 'Deliver verified result', body: '## Acceptance\n- Durable evidence satisfies the requested result.', assigneeId: actor.id, reviewerId: role === 'worker' ? head.id : null, columnStatus: role === 'message' ? 'in_progress' : 'todo', tags: [], dependencyCardIds: [], protocolRepairState: {}, runRetryState: {}, splitRound: 0 };
  const comment: any = { id: randomUUID(), cardId: card.id, assigneeAgentId: actor.id, reviewerAgentId: head.id, action: 'delegate_request', body: 'Return a durable report of the assigned findings.', delegationStatus: 'queued', reviewerScope: 'phase' };
  const run: any = { id: randomUUID(), companyId, cardId: card.id, agentId: actor.id, kind: role === 'message' ? 'message' : 'dispatch', status: 'running', ...(role === 'message' ? { messageCommentId: comment.id } : {}) };
  const state = memoryDb(t, [[companies, [{ id: companyId, name: 'Fixture' }]], [positions, [{ id: positionId, companyId, name: 'Boss', isCompanyBoss: true }]], [departments, [{ id: departmentId, companyId, name: 'Engineering', headAgentId: head.id }]], [agents, [boss, head, worker]], [kanbanCards, [card]], [taskRuns, [run]], [cardComments, role === 'message' ? [comment] : []]]);
  return { card, actor, head, target, comment, run, state };
}

async function nativeRun(t: TestContext, role: Role) {
  const f = fixture(t, role); let prompt = '', calls = 0, httpCalls = 0;
  const split = role === 'boss' || role === 'head';
  // Fixed response, independent of prompt wording: this is a native pipeline
  // control, not a simulated LLM reaction to reporting instructions.
  const report = { kind: 'megacorps-report', version: 1, status: split ? 'progress' : 'completed', summary: 'Evidence is recorded for the assigned work.', workProducts: [{ type: 'report', title: 'Evidence', url: 'https://artifacts.example.test/evidence.md' }], ...(split ? { children: [{ title: 'Produce department evidence', body: '## Acceptance\n- Durable artifact meets all requested requirements.', assigneeSlug: f.target.slug }] } : {}) };
  assert.equal(agentReportSchema.safeParse(report).success, true);
  t.mock.method(globalThis, 'fetch', async () => { httpCalls++; throw new Error('Native reporting must not require HTTP'); });
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: any, task: TaskContext) => {
    calls++;
    prompt = buildAgentPrompt({ hermesProfile: f.actor.slug, currentSessionId: null }, task);
    return { success: true, output: JSON.stringify(report), sessionId: 'synthetic-native', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  if (role === 'message') await runMessageDelegation(f.card.id, { taskRunId: f.run.id });
  else await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  assert.equal(calls, 1);
  assert.equal(httpCalls, 0);
  return { ...f, prompt };
}

test('native report.delegations creates an authorized same-card assignment without HTTP', async t => {
  const f = fixture(t, 'head'); let httpCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { httpCalls++; throw new Error('No HTTP is needed'); });
  const report = { kind: 'megacorps-report', status: 'progress', summary: 'Delegate a bounded evidence check.', delegations: [{ to: f.target.slug, objective: 'Inspect the assigned artifact and return the concrete findings.' }] };
  assert.equal(agentReportSchema.safeParse(report).success, true);
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report), sessionId: 'synthetic-native-delegation', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  const requests = f.state.rows(cardComments).filter(row => row.action === 'delegate_request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.assigneeAgentId, f.target.id);
  assert.equal(requests[0]!.reviewerAgentId, f.actor.id);
  assert.equal(requests[0]!.cardId, f.card.id);
  assert.equal(f.state.rows(kanbanCards).length, 1);
  assert.notEqual(f.card.columnStatus, 'done');
  assert.equal(httpCalls, 0);
});

for (const role of ['boss', 'head', 'worker', 'message'] as const) {
  test(`${role} native returned report records evidence and authorized work without a webhook`, async t => {
    const f = await nativeRun(t, role);
    assert.ok(f.state.rows(workProducts).some(row => row.cardId === f.card.id && row.url === 'https://artifacts.example.test/evidence.md'));
    if (role === 'boss' || role === 'head') {
      const children = f.state.rows(kanbanCards).filter(row => row.parentCardId === f.card.id);
      assert.equal(children.length, 1); assert.equal(children[0]!.assigneeId, f.target.id);
      assert.equal(f.card.rollupStatus, 'waiting_on_children');
    } else if (role === 'worker') assert.equal(f.card.columnStatus, 'in_review', 'Native completion still requires its assigned reviewer.');
    else assert.ok(f.state.rows(cardComments).some(row => row.action === 'delegate_report' && row.parentCommentId === f.comment.id));
  });
  test(`${role} actual generated task prompt makes native reporting sufficient`, async t => {
    const { prompt } = await nativeRun(t, role);
    assert.doesNotMatch(prompt, /When you complete this task, POST|POST status|through the normal MegaCorps webhook|include workProducts in the webhook/i);
    assert.match(prompt, /No HTTP request is needed to report progress, delegation, or results/);
    assert.doesNotMatch(prompt, /Optional webhook body:/);
    assert.match(prompt, /does not authorize a denied task action or remove a real permission blocker/);
  });
}

test('actual worker dispatch uses a scoped contract without unrelated review and HTTP instructions', async t => {
  const { prompt } = await nativeRun(t, 'worker');
  assert.doesNotMatch(prompt, /Ordinary review example|Optional webhook body:|legacy DELEGATE block/);
});

for (const role of ['boss', 'head', 'worker', 'message'] as const) test(`${role} receives current goal before historical company reference material`, async t => {
  const { prompt } = await nativeRun(t, role);
  assert.ok(prompt.indexOf('Deliver verified result') >= 0);
  assert.ok(prompt.indexOf('Deliver verified result') < prompt.indexOf('Company knowledge (current selected documents)'), 'The current goal must precede reference documents');
});

test('ordinary review prompt returns a native report and repository protocol uses returned evidence', async t => {
  const f = fixture(t, 'worker');
  f.card.columnStatus = 'in_review';
  const body = await buildReviewPrompt(f.card);
  const prompt = buildAgentPrompt({ hermesProfile: f.head.slug, currentSessionId: null }, { id: f.card.id, taskRunId: f.run.id, title: f.card.title, body });
  assert.doesNotMatch(prompt, /When you complete this task, POST|POST status/);
  const git = dispatchInternals.projectGitProtocol(null, { id: randomUUID(), repoUrl: 'https://gitea.example.test/org/repo', defaultBranch: 'main' } as any, f.card, f.actor);
  assert.doesNotMatch(git, /workProducts in the webhook/);
  assert.match(git, /workProducts in (?:your|the) (?:returned )?structured report/);
});

test('native prompt examples pass the real report schema and extraction parser', () => {
  const prompt = buildAgentPrompt({ hermesProfile: 'worker', currentSessionId: null }, { id: 'card', title: 'Deliver', body: 'Return the evidence.' });
  const examples = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)];
  assert.ok(examples.length > 0);
  for (const [, example] of examples) {
    assert.equal(agentReportSchema.safeParse(JSON.parse(example!)).success, true);
    const extracted = extractAgentReport(example!);
    assert.ok(extracted && 'report' in extracted);
  }
  assert.match(prompt, /verdict approved \| revision_requested \| escalate/);
  assert.match(prompt, /does not authorize a denied task action or remove a real permission blocker/);
  assert.match(prompt, /report\.children means the top-level "children" key/);
  assert.match(prompt, /Do not add another "report" wrapper/);
});

test('actual Boss dispatch consumes observed nested children and waits without an empty-progress requeue', async t => {
  const f = fixture(t, 'boss');
  const output = JSON.stringify({ kind: 'megacorps-report', version: 1, status: 'progress', summary: 'Delegate the guide.', notes: ['The assigned head will return the evidence.'], report: { children: [{ title: 'Write the guide', assigneeSlug: f.target.slug, body: '## Acceptance\n- Deliver a complete, verified guide for the intended audience.' }] } });
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output, sessionId: 'synthetic-envelope', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  const children = f.state.rows(kanbanCards).filter(row => row.parentCardId === f.card.id);
  assert.equal(children.length, 1, 'The real observed envelope must not silently discard its child.');
  assert.equal(children[0]!.assigneeId, f.target.id);
  assert.equal(f.card.rollupStatus, 'waiting_on_children');
  assert.equal(f.state.rows(taskRuns).filter(row => row.cardId === f.card.id && row.status === 'queued').length, 0);
  assert.ok(f.state.rows(cardComments).some(row => row.action === 'comment' && row.body === 'The assigned head will return the evidence.'));
  const repeated = await processChildSplits(f.card, f.actor, childrenFromOutput(output), f.run.id);
  assert.deepEqual(repeated.created, []);
  assert.match(repeated.errors.join('\n'), /split_authority_changed/, 'A repeated result after lease settlement must not regain split authority.');
  assert.equal(f.state.rows(kanbanCards).filter(row => row.parentCardId === f.card.id).length, 1);
});

test('duplicate normalized child delivery during the same active dispatch creates work only once', async t => {
  const f = fixture(t, 'head');
  const output = JSON.stringify({ kind: 'megacorps-report', status: 'progress', summary: 'Delegate the deliverable.', report: { children: [{ title: 'Write guide', assigneeSlug: f.target.slug, body: '## Acceptance\n- Deliver a complete verified guide for the intended audience.' }] } });
  let firstIds: string[] = [];
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => {
    // Two arrivals of the same fixed report while the original lease is live:
    // existing split ingestion followed by the native adapter final response.
    const first = await processChildSplits(f.card, f.actor, childrenFromOutput(output), f.run.id);
    assert.deepEqual(first.errors, []); assert.equal(first.created.length, 1);
    firstIds = first.created;
    return { success: true, output, sessionId: 'synthetic-duplicate-envelope', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  assert.deepEqual(f.state.rows(kanbanCards).filter(row => row.parentCardId === f.card.id).map(row => row.id), firstIds);
  assert.equal(f.state.rows(cardComments).filter(row => row.action === 'split_opened').length, 1);
  assert.equal(f.card.rollupStatus, 'waiting_on_children');
});

for (const invalid of ['foreign_company', 'outside_hierarchy', 'invalid_body', 'recursive', 'conflict'] as const) test(`actual nested-child dispatch preserves ${invalid} rejection`, async t => {
  const f = fixture(t, 'boss');
  const child = { title: 'Write guide', assigneeSlug: f.target.slug, body: '## Acceptance\n- Deliver a complete verified guide for its intended audience.' };
  const report: any = { kind: 'megacorps-report', status: 'progress', summary: 'Delegate the guide.', report: { children: [child] } };
  if (invalid === 'foreign_company') {
    child.assigneeSlug = 'foreign';
    f.state.rows(agents).push({ ...f.target, id: randomUUID(), companyId: randomUUID(), slug: 'foreign' });
  }
  if (invalid === 'outside_hierarchy') child.assigneeSlug = 'worker';
  if (invalid === 'invalid_body') child.body = 'too short';
  if (invalid === 'recursive') report.report = { report: { children: [child] } };
  if (invalid === 'conflict') report.report.status = 'failed';
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify(report), sessionId: 'synthetic-invalid-envelope', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  assert.equal(f.state.rows(kanbanCards).length, 1);
  assert.notEqual(f.card.columnStatus, 'done');
  assert.equal(f.card.protocolRepairState.dispatch?.failures, 1, 'Invalid nested intent must enter existing corrective feedback, not ordinary progress.');
});

test('wrapped Boss permission stops execution and creates a human recovery gate without child creation', async t => {
  const f = fixture(t, 'boss');
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Work result.', report: { request: { kind: 'permission', question: 'Authorize repository access.' }, children: [{ title: 'Write guide', assigneeSlug: f.target.slug, body: '## Acceptance\n- Deliver a verified guide for the intended audience.' }] } }), sessionId: 'synthetic-permission-envelope', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  assert.equal(f.card.columnStatus, 'in_review');
  assert.equal(f.card.protocolRepairState.recovery.mode, 'awaiting_human');
  assert.match(f.card.lastError, /agent_permission_blocked/);
  assert.equal(f.state.rows(kanbanCards).length, 1);
  assert.equal(f.state.rows(approvals).length, 1);
  assert.equal(f.state.rows(approvals)[0]!.status, 'pending');
  assert.equal(f.state.rows(approvals)[0]!.payload.humanGate, true);
  assert.equal(f.state.rows(taskRuns).filter(row => row.status === 'queued').length, 0, 'A denied operation is not retried');
});

for (const mergeRequired of [false, true]) test(`wrapped evidence respects ${mergeRequired ? 'merge' : 'review'} completion gate`, async t => {
  const f = fixture(t, 'worker');
  if (mergeRequired) {
    f.card.projectId = randomUUID();
    f.state.rows(projects).push({ id: f.card.projectId, companyId: f.card.companyId, completionRequiresMerge: true, repoUrl: null });
  }
  t.mock.method(getAdapter('webhook'), 'dispatch', async () => ({ success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Deliverable ready for review.', report: { workProducts: [{ type: 'report', title: 'Evidence', url: 'https://example.test/evidence' }] } }), sessionId: 'synthetic-evidence-envelope', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }));
  await dispatchCard(f.card.id, 'manual', { taskRunId: f.run.id });
  assert.equal(f.state.rows(workProducts).length, 1);
  assert.notEqual(f.card.columnStatus, 'done');
  if (!mergeRequired) assert.equal(f.card.columnStatus, 'in_review');
});
