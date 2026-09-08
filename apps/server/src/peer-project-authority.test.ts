import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { agents, cardComments, heartbeatRuns, kanbanCards, projects } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { sweepPeerQuestions } from './dispatch.ts';
import { getAdapter } from './adapters/registry.ts';
import type { TaskContext } from './adapters/hermes.ts';

function fixture(t: TestContext, role: 'member' | 'head' | 'boss' = 'member') {
  const state = memoryDb(t, []), companyId = randomUUID();
  const { headId, bossId, departmentId } = readyCompany(state, companyId);
  const member = { id: randomUUID(), companyId, name: 'Member', slug: 'member', departmentId, bossId: headId, adapterType: 'webhook', isActive: true, isBusy: false };
  state.rows(agents).push(member);
  const actor = state.rows(agents).find(row => row.id === (role === 'head' ? headId : role === 'boss' ? bossId : member.id))!;
  for (const row of state.rows(agents)) Object.assign(row, { giteaUsername: `${row.slug}-user`, giteaToken: `${row.slug}-synthetic-secret` });
  const project: any = { id: randomUUID(), companyId, name: 'Current project', repoProvider: 'github', repoUrl: 'https://repo.example/tenant/fresh.git', defaultBranch: 'release', publishToken: 'publish-synthetic-secret', deletedAt: null };
  state.rows(projects).push(project);
  const card: any = { id: randomUUID(), companyId, projectId: project.id, title: 'Current assignment', body: 'Old brief names https://repo.example/tenant/old.git', columnStatus: 'in_progress', assigneeId: headId, tags: [], deletedAt: null };
  const history = { id: randomUUID(), cardId: card.id, agentId: headId, action: 'comment', body: 'Earlier thread names https://repo.example/tenant/old.git', createdAt: new Date(0) };
  const question: any = { id: randomUUID(), cardId: card.id, parentCommentId: history.id, agentId: headId, assigneeAgentId: actor.id, action: 'peer_question', body: 'Which repository is current? The earlier instruction names https://repo.example/tenant/old.git.', delegationStatus: 'queued', metadata: {}, createdAt: new Date(1) };
  state.rows(kanbanCards).push(card); state.rows(cardComments).push(history, question);
  let prompt = '', calls = 0;
  const answer = 'Fixed synthetic informational answer, independent of prompt text.';
  let response = { success: true, output: answer };
  t.mock.method(getAdapter('webhook'), 'dispatch', async (_agent: unknown, task: TaskContext) => {
    calls++; prompt = task.body ?? ''; assert.equal(task.kind, 'chat');
    return { ...response, sessionId: 'synthetic-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 };
  });
  const app = Fastify(); t.after(() => app.close());
  return { state, actor, project, card, question, answer, respond: (value: typeof response) => { response = value; }, prompt: () => prompt, calls: () => calls, execute: () => sweepPeerQuestions(app) };
}

function assertInformational(prompt: string) {
  assert.match(prompt, /Reply with the answer text only/);
  assert.match(prompt, /posted back.*automatically/);
  assert.match(prompt, /do not call any webhook, do not create or update cards, and do not delegate/);
  assert.match(prompt, /informational.*not authorization to.*implement/i);
  assert.doesNotMatch(prompt, /Repository workflow:|Authenticated clone URL:|synthetic-secret|git clone|git remote get-url|git push|Validate with:|Your workspace \(clone/);
}

for (const role of ['member', 'head', 'boss'] as const) test(`${role} peer receives current project authority while remaining answer-only`, async t => {
  const f = fixture(t, role);
  assert.equal(await f.execute(), 1); assert.equal(f.calls(), 1);
  const prompt = f.prompt();
  assert.ok(prompt.includes(f.project.id), 'Current project UUID must reach the actual peer adapter');
  assert.ok(prompt.includes(f.project.name)); assert.ok(prompt.includes(f.project.repoUrl));
  assert.match(prompt, /Expected default branch: release/);
  assert.match(prompt, /current project.*overrides.*question.*card.*thread.*digest/i);
  assert.ok(prompt.includes(f.question.body), 'Keep the original question despite conflicting context');
  assertInformational(prompt);
  if (role !== 'boss') assert.doesNotMatch(prompt, /do not perform professional artifact QA yourself/);
  else assert.match(prompt, /strategy|strategic/i);
  const replies = f.state.rows(cardComments).filter(row => row.action === 'peer_answer');
  assert.equal(replies.length, 1); assert.equal(replies[0]!.body, f.answer); assert.equal(replies[0]!.parentCommentId, f.question.id);
  assert.equal(f.question.delegationStatus, 'done'); assert.equal(f.actor.isBusy, false);
  assert.equal(f.state.rows(heartbeatRuns)[0]!.status, 'success');
  assert.equal(await f.execute(), 0); assert.equal(f.calls(), 1, 'No duplicate answering');
});

test('projectless peer gives explicit no-project guidance without selecting the stale question repository', async t => {
  const f = fixture(t); f.card.projectId = null;
  assert.equal(await f.execute(), 1);
  assert.match(f.prompt(), /Project: none/);
  assert.match(f.prompt(), /do not infer.*repository.*question|do not use a repository from/i);
  assert.doesNotMatch(f.prompt(), /tenant\/fresh.git/); assertInformational(f.prompt());
});

for (const invalid of ['missing', 'deleted', 'foreign'] as const) test(`${invalid} project never discloses its configuration to a peer`, async t => {
  const f = fixture(t);
  if (invalid === 'missing') f.card.projectId = randomUUID();
  if (invalid === 'deleted') f.project.deletedAt = new Date();
  if (invalid === 'foreign') f.project.companyId = randomUUID();
  f.project.name = 'Private foreign project'; f.project.repoUrl = 'https://private.example/hidden/repo.git';
  await f.execute();
  assert.doesNotMatch(f.prompt(), /Private foreign project|private.example|synthetic-secret/);
  if (invalid === 'deleted') { assert.equal(f.calls(), 1); assert.match(f.prompt(), /Assigned project is unavailable/); assertInformational(f.prompt()); }
  else { assert.equal(f.calls(), 0, 'Existing usage admission rejects missing or foreign projects'); assert.equal(f.state.rows(heartbeatRuns)[0]!.status, 'failed'); }
});

test('peer repository identity strips URL credentials, query and fragment', async t => {
  const f = fixture(t); f.project.repoUrl = 'https://embedded-user:embedded-password@repo.example/tenant/fresh.git?token=query-secret#fragment-secret';
  assert.equal(await f.execute(), 1);
  assert.ok(f.prompt().includes('https://repo.example/tenant/fresh.git'));
  assert.doesNotMatch(f.prompt(), /embedded-user|embedded-password|query-secret|fragment-secret|synthetic-secret/);
  assertInformational(f.prompt());
});

for (const badUrl of ['not a repo URL malformed-secret', 'data:text/plain,opaque-secret']) test(`peer does not echo an invalid repository URL: ${badUrl.split(':')[0]}`, async t => {
  const f = fixture(t); f.project.repoUrl = badUrl;
  assert.equal(await f.execute(), 1);
  assert.match(f.prompt(), /invalid repository URL; request corrected project configuration/);
  assert.ok(!f.prompt().includes(badUrl)); assertInformational(f.prompt());
});

test('busy peer stays queued without adapter dispatch', async t => {
  const f = fixture(t); f.actor.isBusy = true;
  assert.equal(await f.execute(), 0); assert.equal(f.calls(), 0);
  assert.equal(f.question.delegationStatus, 'queued'); assert.equal(f.state.rows(heartbeatRuns).length, 0);
});

test('brainstorm still requests informational department scope and preserves project authority', async t => {
  const f = fixture(t, 'head'); f.question.metadata = { brainstorm: true };
  assert.equal(await f.execute(), 1); assert.match(f.prompt(), /BRAINSTORM:.*scope, deliverables, risks, rough effort/);
  assert.ok(f.prompt().includes(f.project.repoUrl)); assertInformational(f.prompt());
});

for (const permission of [true, false]) test(`peer ${permission ? 'permission request' : 'transport failure'} stays failed without an answer or retry`, async t => {
  const f = fixture(t);
  f.respond(permission ? { success: true, output: JSON.stringify({ kind: 'megacorps-report', status: 'input_required', summary: 'Permission needed', request: { kind: 'permission', question: 'May I access this resource?' } }) } : { success: false, output: 'Synthetic transport failure' });
  assert.equal(await f.execute(), 0); assert.equal(f.calls(), 1);
  assert.equal(f.question.delegationStatus, 'failed'); assert.equal(f.actor.isBusy, false);
  assert.equal(f.state.rows(cardComments).filter(row => row.action === 'peer_answer').length, 0);
  assert.equal(f.state.rows(heartbeatRuns)[0]!.status, 'failed');
  assert.equal(await f.execute(), 0); assert.equal(f.calls(), 1);
});

test('foreign peer actor never receives current company or project context', async t => {
  const f = fixture(t); f.actor.companyId = randomUUID();
  assert.equal(await f.execute(), 0); assert.equal(f.calls(), 0); assert.equal(f.question.delegationStatus, 'failed');
});
