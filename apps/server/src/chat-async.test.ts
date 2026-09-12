import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, users, companyMemberships, chatSessions, chatMessages } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerChatRoutes, chatInternals } from './chat.ts';
import { signSession } from './auth.ts';
import { getAdapter } from './adapters/registry.ts';

test('saved A2A alias warning is projected on reads without rewriting rows or replaying actions', async t => {
  const company: any = { id: randomUUID(), name: 'Display Co', slug: 'display' };
  const user: any = { id: randomUUID(), email: 'display@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Alice', adapterType: 'a2a' };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, projectId: null, userId: user.id };
  const body = '在。有事直說。\n```chat-actions\n{"actions":[]}\n```';
  const envelope = JSON.stringify({ kind: 'megacorps-chat-response', body });
  const raw = `⚠️  Normalized model 'deepseek-flash' to 'deepseek-v4-flash' for deepseek.\n${envelope}`;
  const variants = [
    { authorType: 'agent', body: raw, metadata: { adapterType: 'a2a' }, expected: body },
    { authorType: 'agent', body: raw, metadata: { adapterType: 'a2a', chatDisplayVersion: 1 }, expected: raw },
    { authorType: 'agent', body: envelope, metadata: { adapterType: 'a2a' }, expected: envelope },
    { authorType: 'agent', body: raw, metadata: { adapterType: 'shell' }, expected: raw },
    { authorType: 'user', body: raw, metadata: {}, expected: raw },
    { authorType: 'system', body: raw, metadata: {}, expected: raw },
  ];
  const messages = variants.map(({ expected, ...value }, index) => ({ ...value, id: randomUUID(), companyId: company.id, sessionId: session.id, agentId: agent.id, createdAt: new Date(1000 + index) }));
  const original = structuredClone(messages);
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'operator', status: 'active' }]], [agents, [agent]], [chatSessions, [session]], [chatMessages, messages]]);
  const dispatch = t.mock.method(getAdapter('a2a'), 'dispatch', async () => { throw new Error('GET must not call the agent'); });
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerChatRoutes(app, { acknowledgeExecution: async () => {} });
  const headers = { cookie: `session=${await signSession(user)}` };
  for (let read = 0; read < 2; read++) {
    const response = await app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/messages`, headers });
    assert.equal(response.statusCode, 200, response.body);
    for (const [index, message] of messages.entries()) {
      assert.equal(response.json().find((row: any) => row.id === message.id).body, variants[index]!.expected);
    }
  }
  assert.deepEqual(state.rows(chatMessages), original);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(state.rows(kanbanCards).length, 0);
  assert.equal(chatInternals.formatChatHistoryForPrompt([messages[0] as any]), `[agent] ${body}`);
});

for (const revoked of [false, true]) test(revoked ? 'A2A reply rechecks revoked operator authority before applying Kanban actions' : 'A2A chat returns acceptance before inference ends and stores one later reply', async t => {
  const company: any = { id: randomUUID(), name: 'Async Co', slug: 'async' };
  const user: any = { id: randomUUID(), email: 'async@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Agent', slug: 'agent', isActive: true, isBusy: false, adapterType: 'a2a', adapterConfig: {} };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, projectId: null, title: 'Chat with Agent', userId: user.id };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'operator', status: 'active' }]], [agents, [agent]], [chatSessions, [session]]]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const keys: string[] = [];
  const answer = revoked ? 'Durable answer\n' + JSON.stringify({ kind: 'megacorps-chat-actions', actions: [{ action: 'create_card', title: 'Do not create after revocation', body: 'No authority' }] }) : 'Durable answer';
  t.mock.method(getAdapter('a2a'), 'dispatch', async (_agent: any, task: any) => { keys.push(task.executionKey); await gate; return { success: true, output: answer, sessionId: 'remote-session', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerChatRoutes(app, { acknowledgeExecution: async () => {} });
  const headers = { cookie: `session=${await signSession(user)}` };
  const pending = app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers, payload: { body: 'Please work' } });
  const early = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 150))]);
  if (!early) { release(); await pending; }
  assert.ok(early, 'HTTP request must return while the adapter is still pending');
  assert.equal(early.statusCode, 202, early.body);
  const accepted = early.json();
  assert.equal(accepted.userMessage.body, 'Please work');
  assert.equal(accepted.job.status, 'queued');
  const duplicate = await app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers, payload: { body: 'Duplicate' } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(state.rows(chatMessages).filter(row => row.authorType === 'user').length, 1);
  const stranger: any = { id: randomUUID(), email: 'stranger@example.test', role: 'admin' };
  state.rows(users).push(stranger);
  const forbidden = await app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/jobs/${accepted.job.id}`, headers: { cookie: `session=${await signSession(stranger)}` } });
  assert.equal(forbidden.statusCode, 403, 'job status requires membership in the session company');
  const deniedPost = await app.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: { cookie: `session=${await signSession(stranger)}` }, payload: { body: 'Unauthorized' } });
  assert.equal(deniedPost.statusCode, 403);
  assert.equal(state.rows(chatMessages).filter(row => row.authorType === 'user').length, 1);
  if (revoked) {
    for (let i = 0; i < 100 && !keys.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(keys.length, 1);
    state.rows(companyMemberships)[0]!.role = 'viewer';
  }
  release();
  let jobs: any[] = [];
  for (let i = 0; i < 100; i++) {
    jobs = (await app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/jobs`, headers })).json();
    if (jobs[0]?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(jobs[0]?.status, 'completed');
  assert.deepEqual(keys, [`chat:${accepted.userMessage.id}`]);
  assert.equal(state.rows(chatMessages).filter(row => row.body === answer).length, 1);
  assert.equal(state.rows(chatMessages).find(row => row.body === answer)?.metadata.chatDisplayVersion, 1);
  if (revoked) {
    assert.equal(state.rows(kanbanCards).length, 0);
    assert.ok(state.rows(chatMessages).some(row => row.body.includes('operator access was revoked')));
  }
});


import { chatJobs } from './db/chat-jobs-schema.ts';
import { costEvents, heartbeatRuns, kanbanCards } from './db/schema.ts';
import { claimChatJob, projectChatJob } from './chat-jobs.ts';

test('expired chat lease resumes the stored execution key and usage attempt after restart', async t => {
  const company: any = { id: randomUUID(), name: 'Restart Co', slug: 'restart' };
  const user: any = { id: randomUUID(), email: 'restart@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Agent', slug: 'agent', isActive: true, isBusy: true, adapterType: 'a2a', adapterConfig: {} };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, projectId: null, title: 'Existing conversation', userId: user.id };
  const message: any = { id: randomUUID(), sessionId: session.id, companyId: company.id, agentId: agent.id, userId: user.id, authorType: 'user', body: 'Recover my task', metadata: {} };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, source: 'chat', status: 'running' };
  const job: any = { id: randomUUID(), companyId: company.id, sessionId: session.id, agentId: agent.id, userId: user.id, userMessageId: message.id, responseMessageId: randomUUID(), heartbeatRunId: run.id, status: 'running', leaseToken: randomUUID(), leaseExpiresAt: new Date(0) };
  const usage: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, heartbeatRunId: run.id, projectId: null, runtimeId: null, source: 'chat', reportingSource: `${company.id}:runtime:agent:${agent.id}`, attemptKey: `heartbeat:${run.id}`, provider: 'unknown', costStatus: 'unknown', costUsd: null, admittedAt: new Date(), occurredAt: new Date() };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'operator', status: 'active' }]], [agents, [agent]], [chatSessions, [session]], [chatMessages, [message]], [heartbeatRuns, [run]], [chatJobs, [job]], [costEvents, [usage]]]);
  const keys: string[] = [];
  t.mock.method(getAdapter('a2a'), 'dispatch', async (_agent: any, task: any) => { keys.push(task.executionKey); return { success: true, output: 'Recovered answer', sessionId: 'prior-context', tokensUsed: 0, costUsd: 0, durationSeconds: 1 }; });
  const acknowledgments: string[] = [];
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerChatRoutes(app, { acknowledgeExecution: async key => { acknowledgments.push(key); } });
  const headers = { cookie: `session=${await signSession(user)}` };
  for (let i = 0; i < 100; i++) {
    await app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/jobs`, headers });
    if (job.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'completed');
  assert.deepEqual(keys, [`chat:${message.id}`]);
  assert.equal(state.rows(chatMessages).filter(row => row.authorType === 'user').length, 1);
  assert.equal(state.rows(chatMessages).filter(row => row.authorType === 'agent').length, 1);
  assert.equal(state.rows(costEvents).length, 1, 'recovery reuses the admitted usage attempt');
  assert.deepEqual(acknowledgments, [`chat:${message.id}`]);
});

test('chat leases exclude another consumer and fence stale result projection', async t => {
  const row: any = { id: randomUUID(), status: 'queued', userMessageId: randomUUID(), responseMessageId: randomUUID(), createdAt: new Date(0) };
  memoryDb(t, [[chatJobs, [row]]]);
  const first = await claimChatJob(new Date(1000), 1000);
  assert.ok(first);
  assert.equal(await claimChatJob(new Date(1500), 1000), null);
  const successor = await claimChatJob(new Date(2100), 1000);
  assert.ok(successor);
  assert.notEqual(successor.leaseToken, first.leaseToken);
  let projected = 0;
  await projectChatJob(first, async () => { projected += 1; });
  assert.equal(projected, 0, 'expired consumer cannot persist a response');
});

test('job completion rolls back when the terminal receipt acknowledgment fails', async t => {
  const job: any = { id: randomUUID(), status: 'running', leaseToken: randomUUID(), userMessageId: randomUUID(), responseMessageId: randomUUID() };
  const message: any = { id: job.responseMessageId, authorType: 'agent', body: 'Already saved' };
  memoryDb(t, [[chatJobs, [job]], [chatMessages, [message]]]);
  await assert.rejects(projectChatJob(job, async () => {}, async (_key, tx) => {
    assert.ok(tx, 'acknowledgment participates in the job transaction');
    throw new Error('ack_store_unavailable');
  }), /ack_store_unavailable/);
  assert.equal(job.status, 'running');
  await projectChatJob(job, async () => {}, async (_key, tx) => { assert.ok(tx); });
  assert.equal(job.status, 'completed');
});

test('a recovered saved reply is not inferred or its Kanban actions applied again', async t => {
  const company: any = { id: randomUUID(), name: 'Recovered Co', slug: 'recovered' };
  const user: any = { id: randomUUID(), email: 'recovered@example.test', role: 'operator' };
  const agent: any = { id: randomUUID(), companyId: company.id, name: 'Agent', slug: 'agent', isActive: true, isBusy: true, adapterType: 'a2a' };
  const session: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, projectId: null, title: 'Existing conversation', userId: user.id };
  const message: any = { id: randomUUID(), sessionId: session.id, companyId: company.id, agentId: agent.id, userId: user.id, authorType: 'user', body: 'Recover my reply', metadata: {} };
  const run: any = { id: randomUUID(), companyId: company.id, agentId: agent.id, source: 'chat', status: 'running' };
  const job: any = { id: randomUUID(), companyId: company.id, sessionId: session.id, agentId: agent.id, userId: user.id, userMessageId: message.id, responseMessageId: randomUUID(), heartbeatRunId: run.id, status: 'running', leaseToken: randomUUID(), leaseExpiresAt: new Date(0) };
  const saved: any = { id: job.responseMessageId, sessionId: session.id, companyId: company.id, agentId: agent.id, authorType: 'agent', body: '```megacorps-chat-actions\n{"actions":[{"action":"create_card","title":"Do not repeat"}]}\n```', metadata: { chatActionsPending: true, sessionId: 'saved-context' } };
  const state = memoryDb(t, [[companies, [company]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'operator', status: 'active' }]], [agents, [agent]], [chatSessions, [session]], [chatMessages, [message, saved]], [heartbeatRuns, [run]], [chatJobs, [job]]]);
  let dispatched = 0;
  t.mock.method(getAdapter('a2a'), 'dispatch', async () => { dispatched++; throw new Error('must not infer'); });
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerChatRoutes(app, { acknowledgeExecution: async () => {} });
  const headers = { cookie: `session=${await signSession(user)}` };
  for (let i = 0; i < 100; i++) {
    await app.inject({ method: 'GET', url: `/api/chat/sessions/${session.id}/jobs`, headers });
    if (job.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'completed');
  assert.equal(dispatched, 0);
  assert.equal(state.rows(kanbanCards).length, 0);
  assert.equal(state.rows(chatMessages).filter(row => row.authorType === 'agent').length, 1);
  assert.match(state.rows(chatMessages).find(row => row.id === job.id)!.body, /updates may be incomplete/);
  assert.equal(session.agentSessionId, 'saved-context');
});

test('durable chat jobs follow parent retention and do not block retirement', async () => {
  const { getTableConfig } = await import('drizzle-orm/pg-core');
  const { chatJobsMigrationSql } = await import('./db/chat-jobs-migration.ts');
  const keys = getTableConfig(chatJobs).foreignKeys;
  assert.equal(keys.length, 6);
  assert.ok(keys.every(key => key.onDelete === 'cascade'), 'job foreign keys must cascade when their retained parent is deleted');
  assert.equal((chatJobsMigrationSql.match(/REFERENCES \w+\(id\) ON DELETE CASCADE/g) ?? []).length, keys.length);
});

test('claimChatJob encodes its lease deadline as a driver-safe timestamp parameter', async t => {
  const { db } = await import('./db/client.ts');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  memoryDb(t, [[chatJobs, []]]);
  const select = db.select.bind(db);
  const params: unknown[] = [];
  t.mock.method(db, 'select', (() => {
    const query = select();
    const from = query.from.bind(query);
    query.from = ((table: any) => {
      const chain: any = from(table);
      const where = chain.where.bind(chain);
      chain.where = (condition: any) => {
        if (table === chatJobs) params.push(...new PgDialect().sqlToQuery(condition).params);
        return where(condition);
      };
      return chain;
    }) as any;
    return query;
  }) as any);
  const now = new Date('2026-09-11T01:28:32.000Z');
  await claimChatJob(now);
  assert.ok(params.length > 0, 'capture the production claim predicate');
  assert.ok(!params.some(value => value instanceof Date), 'raw Date bypasses Drizzle column encoding and cannot enter postgres-js timestamp serialization');
  assert.ok(params.includes(now.toISOString()));
});
