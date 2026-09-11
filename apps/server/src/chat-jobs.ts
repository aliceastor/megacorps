import { acknowledgeA2aExecution } from './a2a-executions.ts';
import { agentRemoteWork, refreshAgentRemoteCapacity } from './a2a-remote-reconciliation.ts';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, chatMessages, chatSessions, heartbeatRuns } from './db/schema.ts';
import { chatJobs, type ChatJob } from './db/chat-jobs-schema.ts';

export function publicChatJob(job: ChatJob) {
  return { id: job.id, sessionId: job.sessionId, userMessageId: job.userMessageId, status: job.status, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

export async function enqueueChatJob(session: typeof chatSessions.$inferSelect, userId: string, body: string) {
  return db.transaction(async tx => {
    await tx.select().from(chatSessions).where(eq(chatSessions.id, session.id)).for('update').limit(1);
    const [pending] = await tx.select().from(chatJobs).where(and(eq(chatJobs.sessionId, session.id), inArray(chatJobs.status, ['queued', 'running']))).limit(1);
    if (pending) return { error: 'chat_reply_pending', job: publicChatJob(pending) } as const;
    const [otherPending] = await tx.select().from(chatJobs).where(and(eq(chatJobs.agentId, session.agentId), inArray(chatJobs.status, ['queued', 'running']))).limit(1);
    if (otherPending) return { error: 'agent_busy' } as const;
    await tx.select().from(agents).where(eq(agents.id, session.agentId)).for('update').limit(1);
    if ((await agentRemoteWork(session.agentId, tx)).pending) return { error: 'a2a_remote_work_pending' } as const;
    const [agent] = await tx.update(agents).set({ isBusy: true }).where(and(eq(agents.id, session.agentId), eq(agents.isBusy, false), eq(agents.isActive, true))).returning();
    if (!agent) return { error: 'agent_busy' } as const;
    const [run] = await tx.insert(heartbeatRuns).values({ companyId: session.companyId, agentId: session.agentId, source: 'chat', status: 'running', startedAt: new Date() }).returning();
    const [userMessage] = await tx.insert(chatMessages).values({ sessionId: session.id, companyId: session.companyId, agentId: session.agentId, userId, authorType: 'user', body, metadata: {} }).returning();
    const [job] = await tx.insert(chatJobs).values({ id: randomUUID(), companyId: session.companyId, sessionId: session.id, agentId: session.agentId, userId, userMessageId: userMessage!.id, responseMessageId: randomUUID(), heartbeatRunId: run!.id, status: 'queued' }).returning();
    const [updatedSession] = await tx.update(chatSessions).set({ title: session.title.startsWith('Chat with ') ? body.replace(/\s+/g, ' ').trim().slice(0, 72) : session.title, updatedAt: new Date() }).where(eq(chatSessions.id, session.id)).returning();
    return { session: updatedSession!, userMessage: userMessage!, job: publicChatJob(job!) } as const;
  });
}

export async function claimChatJob(now = new Date(), leaseMs = 30_000): Promise<ChatJob | null> {
  return db.transaction(async tx => {
    // Row locks fence concurrent consumers. The persisted lease permits recovery
    // after a process exits; the remote execution key remains the user message.
    // Raw SQL parameters do not use Drizzle's timestamp column encoder.
    // postgres-js receives an ISO string, never an unencoded Date object.
    const candidates = await tx.select().from(chatJobs).where(and(inArray(chatJobs.status, ['queued', 'running']), sql`(status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ${now.toISOString()})`)).orderBy(asc(chatJobs.createdAt)).for('update', { skipLocked: true }).limit(100);
    const job = candidates.find(row => row.status === 'queued' || !row.leaseExpiresAt || row.leaseExpiresAt <= now);
    if (!job) return null;
    const [claimed] = await tx.update(chatJobs).set({ status: 'running', leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now }).where(eq(chatJobs.id, job.id)).returning();
    return claimed!;
  });
}

export type ChatJobAcknowledger = (key: string, tx?: Pick<typeof db, 'select' | 'insert' | 'update'>) => Promise<void>;

export async function projectChatJob<T>(job: ChatJob, project: () => Promise<T>, acknowledge: ChatJobAcknowledger = acknowledgeA2aExecution): Promise<T | undefined> {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(chatJobs).where(eq(chatJobs.id, job.id)).for('update').limit(1);
    if (!current || current.status !== 'running' || current.leaseToken !== job.leaseToken) return undefined;
    const result = await project();
    const [message] = await tx.select().from(chatMessages).where(eq(chatMessages.id, job.responseMessageId)).limit(1);
    await acknowledge(`chat:${job.userMessageId}`, tx);
    const metadata = message?.metadata as Record<string, unknown> | null;
    await tx.update(heartbeatRuns).set({ status: message?.authorType === 'agent' ? 'success' : 'failed', completedAt: new Date(), durationSeconds: message?.durationSeconds, costUsd: message?.costUsd, outputTokens: typeof metadata?.tokensUsed === 'number' ? metadata.tokensUsed : undefined, error: message?.authorType === 'system' ? message.body : null }).where(eq(heartbeatRuns.id, job.heartbeatRunId));
    await tx.update(chatJobs).set({ status: message?.authorType === 'agent' ? 'completed' : 'failed', error: message?.authorType === 'system' ? message.body : null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(chatJobs.id, job.id));
    await refreshAgentRemoteCapacity(job.agentId, tx);
    return result;
  });
}

export function createChatJobWorker(process: (job: ChatJob) => Promise<void>, onError: (error: unknown) => void = () => {}) {
  let stopped = false;
  let ticking = false;
  const active = new Set<Promise<void>>();
  const renewals = new Set<ReturnType<typeof setInterval>>();
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      while (!stopped && active.size < 4) {
        const job = await claimChatJob();
        if (!job) break;
        const renewal = setInterval(() => {
          void db.update(chatJobs).set({ leaseExpiresAt: new Date(Date.now() + 30_000) }).where(and(eq(chatJobs.id, job.id), eq(chatJobs.leaseToken, job.leaseToken!))).catch(onError);
        }, 10_000);
        renewal.unref();
        renewals.add(renewal);
        const task = process(job).catch(onError).finally(() => { clearInterval(renewal); renewals.delete(renewal); active.delete(task); });
        active.add(task);
      }
    } catch (error) { onError(error); }
    finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick(); }, 1000);
  timer.unref();
  return {
    wake: () => { setImmediate(() => { void tick(); }); },
    stop: () => { stopped = true; clearInterval(timer); for (const renewal of renewals) clearInterval(renewal); renewals.clear(); },
    tick,
  };
}
