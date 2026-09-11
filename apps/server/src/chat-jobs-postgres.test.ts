import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL chat admission, concurrent leases, and projection fencing survive re-entry', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false, timeout: 120_000 }, async t => {
  const { db } = await isolatedPostgres(t);
  const s = await import('./db/schema.ts');
  const { chatJobs } = await import('./db/chat-jobs-schema.ts');
  const { enqueueChatJob, claimChatJob, projectChatJob } = await import('./chat-jobs.ts');
  const [company] = await db.insert(s.companies).values({ name: 'Chat concurrency', slug: `chat-${randomUUID()}` }).returning();
  const [user] = await db.insert(s.users).values({ name: 'Chat user', email: `${randomUUID()}@example.test` }).returning();
  const [agent] = await db.insert(s.agents).values({ companyId: company!.id, name: 'Chat agent', slug: 'chat', role: 'worker', adapterType: 'a2a' }).returning();
  const [session] = await db.insert(s.chatSessions).values({ companyId: company!.id, agentId: agent!.id, userId: user!.id, title: 'Chat with Agent' }).returning();
  const admitted = await Promise.all([enqueueChatJob(session!, user!.id, 'One'), enqueueChatJob(session!, user!.id, 'Two')]);
  assert.equal(admitted.filter(result => 'userMessage' in result).length, 1);
  assert.equal((await db.select().from(s.chatMessages).where(eq(s.chatMessages.sessionId, session!.id))).length, 1);
  const claims = await Promise.all([claimChatJob(), claimChatJob()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  await db.update(chatJobs).set({ leaseExpiresAt: new Date(0) }).where(eq(chatJobs.id, first.id));
  const resumed = await claimChatJob();
  assert.ok(resumed);
  assert.equal(resumed.userMessageId, first.userMessageId);
  assert.equal(resumed.heartbeatRunId, first.heartbeatRunId);
  assert.notEqual(resumed.leaseToken, first.leaseToken);
  let projections = 0;
  await projectChatJob(first, async () => { projections += 1; });
  assert.equal(projections, 0);
  const project = async () => {
    projections += 1;
    await db.insert(s.chatMessages).values({ id: resumed.responseMessageId, companyId: company!.id, agentId: agent!.id, sessionId: session!.id, authorType: 'agent', body: 'Only one result' });
  };
  await Promise.all([projectChatJob(resumed, project), projectChatJob(resumed, project)]);
  assert.equal(projections, 1);
  assert.equal((await db.select().from(s.chatMessages).where(eq(s.chatMessages.id, resumed.responseMessageId))).length, 1);
  const [finished] = await db.select().from(chatJobs).where(eq(chatJobs.id, first.id));
  assert.equal(finished!.status, 'completed');
  await t.test('session and company retirement can remove retained chat history and its jobs', async () => {
    // Match retirement's existing order: history before sessions, agents/company.
    await db.delete(s.chatMessages).where(eq(s.chatMessages.sessionId, session!.id));
    assert.equal((await db.select().from(chatJobs).where(eq(chatJobs.sessionId, session!.id))).length, 0);
    await db.delete(s.chatSessions).where(eq(s.chatSessions.id, session!.id));
    await db.delete(s.heartbeatRuns).where(eq(s.heartbeatRuns.companyId, company!.id));
    await db.delete(s.agents).where(eq(s.agents.companyId, company!.id));
    await db.delete(s.companies).where(eq(s.companies.id, company!.id));
    assert.equal((await db.select().from(s.companies).where(eq(s.companies.id, company!.id))).length, 0);
  });
});
