import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { companies, kanbanCards, agents, a2aExecutions, a2aExecutionAliases, costEvents, heartbeatRuns, taskRuns } from './db/schema.ts';
import { chatJobs } from './db/chat-jobs-schema.ts';
import type { A2aInvocationRecord } from './a2a-polling.ts';
import type { A2aSendOutcome } from './a2a-client.ts';

type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;
type Execution = typeof a2aExecutions.$inferSelect;
export type A2aRemoteReconciliation = { state: 'waiting' | 'unresolved' | 'resolved'; reason: string; attempts: number; nextAttemptAt: number; leaseToken: string | null; leaseExpiresAt: number | null };
export const naturalA2aTerminal = (state: A2aSendOutcome['state'] | undefined) => state != null && ['completed', 'failed', 'rejected', 'input_required', 'auth_required'].includes(state);
export function remoteWorkPending(row: Pick<Execution, 'active' | 'record'>): boolean {
  // Hermes CancelTask only changes the task record; its subprocess can continue.
  // A natural result also holds capacity until the original consumer/drain
  // acknowledges it, including stranded journals from an earlier deployment.
  return row.active || row.record.outcome?.state === 'canceled';
}

export type RemoteInspection = { state: 'waiting' | 'unresolved' | 'resolved'; reason: string; taskId?: string; outcome?: A2aSendOutcome };
export async function inspectA2aRemoteTask(record: A2aInvocationRecord, reads: {
  route: string;
  getTask: (taskId: string, full: boolean) => Promise<A2aSendOutcome>;
  listTasks: (contextId: string, pageToken?: string) => Promise<{ tasks: A2aSendOutcome[]; nextPageToken: string | null }>;
}): Promise<RemoteInspection> {
  const unresolved = (reason: string): RemoteInspection => ({ state: 'unresolved', reason });
  if (reads.route !== record.route) return unresolved('a2a_remote_route_changed');
  let taskId = record.taskId;
  const valid = (task: A2aSendOutcome) => task.taskId != null && task.contextId === record.contextId && (!taskId || task.taskId === taskId) && !record.baselineTaskIds?.includes(task.taskId);
  try {
    if (!taskId) {
      if (record.baselineTaskIds === null) return unresolved('a2a_acceptance_unknown');
      const candidates = new Map<string, A2aSendOutcome>();
      const pages = new Set<string>();
      let pageToken: string | undefined;
      do {
        const page = await reads.listTasks(record.contextId, pageToken);
        for (const task of page.tasks) {
          if (!task.taskId || task.contextId !== record.contextId) return unresolved('a2a_task_identity_mismatch');
          if (!record.baselineTaskIds.includes(task.taskId)) candidates.set(task.taskId, task);
        }
        if (candidates.size > 1) return unresolved('a2a_ambiguous_task');
        pageToken = page.nextPageToken ?? undefined;
        if (pageToken && (pages.has(pageToken) || pages.size >= 9)) return unresolved('a2a_discovery_incomplete');
        if (pageToken) pages.add(pageToken);
      } while (pageToken);
      if (candidates.size !== 1) return unresolved('a2a_acceptance_unknown');
      taskId = [...candidates.keys()][0]!;
    }
    const status = await reads.getTask(taskId, false);
    if (!valid(status)) return unresolved('a2a_task_identity_mismatch');
    if (status.state === 'canceled') return { ...unresolved('a2a_remote_cancel_unverified'), taskId };
    if (!naturalA2aTerminal(status.state)) return { state: 'waiting', reason: 'a2a_remote_still_running', taskId };
    const full = await reads.getTask(taskId, true);
    if (!valid(full)) return unresolved('a2a_task_identity_mismatch');
    if (full.state === 'canceled') return { ...unresolved('a2a_remote_cancel_unverified'), taskId };
    if (!naturalA2aTerminal(full.state)) return { state: 'waiting', reason: 'a2a_remote_still_running', taskId };
    return { state: 'resolved', reason: 'a2a_remote_naturally_finished', taskId, outcome: full };
  } catch { return { ...unresolved('a2a_remote_read_unavailable'), ...(taskId ? { taskId } : {}) }; }
}

export async function agentRemoteWork(agentId: string, tx: Executor = db) {
  const rows = await tx.select({ active: a2aExecutions.active, record: sql<A2aInvocationRecord>`jsonb_build_object('outcome', jsonb_build_object('state', ${a2aExecutions.record}->'outcome'->>'state'), 'remoteReconciliation', ${a2aExecutions.record}->'remoteReconciliation')` }).from(a2aExecutions).where(and(eq(a2aExecutions.agentId, agentId), sql`(${a2aExecutions.active} IS TRUE OR ${a2aExecutions.record}->'outcome'->>'state' = 'canceled')`));
  const pending = rows.filter(remoteWorkPending);
  return { pending: pending.length > 0, count: pending.length,
    status: pending.some(row => row.record.remoteReconciliation?.state === 'unresolved') ? 'unresolved' as const : 'waiting_for_remote' as const,
    reason: pending[0]?.record.remoteReconciliation?.reason ?? (pending.length ? 'a2a_remote_still_running' : null) };
}

export async function assertAgentRemoteAvailable(agentId: string, tx: Executor = db): Promise<void> {
  if ((await agentRemoteWork(agentId, tx)).pending) throw Object.assign(new Error('a2a_remote_work_pending'), { code: 'a2a_remote_work_pending', statusCode: 409 });
}

/** Recompute instead of unconditionally releasing an agent owned by other work. */
export async function refreshAgentRemoteCapacity(agentId: string, executor?: Executor): Promise<void> {
  const refresh = async (tx: Executor) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update').limit(1);
    if (!agent) return;
    const remote = await agentRemoteWork(agentId, tx);
    const running = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running')));
    const jobs = await tx.select().from(chatJobs).where(and(eq(chatJobs.agentId, agentId), inArray(chatJobs.status, ['queued', 'running'])));
    await tx.update(agents).set({ isBusy: remote.pending || jobs.length > 0 || running.length >= Math.max(1, agent.maxConcurrent ?? 1) }).where(eq(agents.id, agentId));
  };
  if (executor) await refresh(executor); else await db.transaction(refresh);
}

/** Serializes with the original claim: a stopped local operation cannot begin a
 * new submission. An existing journal remains readable for reconciliation. */
export async function assertA2aSubmissionAuthority(key: string, agentId: string, tx: Executor): Promise<void> {
  const identity = key.slice(key.indexOf(':') + 1);
  if (key.startsWith('task-run:')) {
    const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, identity)).for('update').limit(1);
    if (!run || run.agentId !== agentId || run.status !== 'running') throw new Error('a2a_local_execution_stopped');
  } else if (key.startsWith('heartbeat:')) {
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity)).for('update').limit(1);
    if (!run || run.agentId !== agentId || run.status !== 'running') throw new Error('a2a_local_execution_stopped');
  } else if (key.startsWith('chat:')) {
    const [job] = await tx.select().from(chatJobs).where(eq(chatJobs.userMessageId, identity)).for('update').limit(1);
    if (!job || job.agentId !== agentId || job.status !== 'running') throw new Error('a2a_local_execution_stopped');
  } else if (key.startsWith('operation:')) {
    const [entry] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, key)).for('update').limit(1);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!entry || entry.agentId !== agentId || entry.companyId !== agent?.companyId || entry.source !== 'test_connection' || !entry.admittedAt || entry.settledAt || agent?.isActive === false || agent?.deletedAt || (entry.runtimeId ?? null) !== (agent?.runtimeId ?? null)) throw new Error('a2a_local_execution_stopped');
  } else throw new Error('a2a_execution_owner_unknown');
}

async function originalExecutionOwner(row: Pick<Execution, 'key' | 'agentId' | 'companyId'>, tx: Executor = db) {
  let accountingKey = row.key;
  let ended = false;
  if (row.key.startsWith('chat:')) {
    const [job] = await tx.select().from(chatJobs).where(eq(chatJobs.userMessageId, row.key.slice(5))).limit(1);
    if (!job || job.agentId !== row.agentId || job.companyId !== row.companyId) return null;
    accountingKey = `heartbeat:${job.heartbeatRunId}`;
    ended = !['queued', 'running'].includes(job.status);
  }
  const [entry] = await tx.select().from(costEvents).where(eq(costEvents.attemptKey, accountingKey)).limit(1);
  if (!entry || entry.agentId !== row.agentId || entry.companyId !== row.companyId) return null;
  if (entry.taskRunId) {
    const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, entry.taskRunId)).limit(1);
    if (!run || run.agentId !== row.agentId || run.companyId !== row.companyId || run.cardId !== entry.cardId) return null;
    ended = !['queued', 'running'].includes(run.status);
  } else if (entry.heartbeatRunId) {
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, entry.heartbeatRunId)).limit(1);
    if (!run || run.agentId !== row.agentId || run.companyId !== row.companyId || (entry.cardId && run.cardId !== entry.cardId)) return null;
    ended ||= run.status !== 'running';
  } else if (row.key.startsWith('operation:') && entry.source === 'test_connection') ended = Boolean(entry.settledAt);
  else return null;
  return { entry, ended };
}

export async function claimA2aRemoteReconciliation(now = Date.now()): Promise<Execution | null> {
  return db.transaction(async tx => {
    // Read bounded metadata first; old final transcripts can be very large.
    const candidates = await tx.select({ key: a2aExecutions.key, agentId: a2aExecutions.agentId, companyId: a2aExecutions.companyId, active: a2aExecutions.active,
      record: sql<A2aInvocationRecord>`jsonb_build_object('phase', ${a2aExecutions.record}->'phase', 'deadlineAt', ${a2aExecutions.record}->'deadlineAt', 'remoteReconciliation', ${a2aExecutions.record}->'remoteReconciliation', 'outcome', jsonb_build_object('state', ${a2aExecutions.record}->'outcome'->>'state'))`
    }).from(a2aExecutions).where(sql`(${a2aExecutions.active} IS TRUE OR ${a2aExecutions.record}->'outcome'->>'state' = 'canceled') AND (
      ${a2aExecutions.record}->>'phase' = 'reconciliation_required'
      OR (${a2aExecutions.record}->>'deadlineAt')::bigint <= ${now}
      OR EXISTS (SELECT 1 FROM task_runs original_run WHERE 'task-run:' || original_run.id::text = ${a2aExecutions.key} AND original_run.status NOT IN ('queued', 'running'))
      OR EXISTS (SELECT 1 FROM heartbeat_runs original_run WHERE 'heartbeat:' || original_run.id::text = ${a2aExecutions.key} AND original_run.status <> 'running')
      OR EXISTS (SELECT 1 FROM chat_jobs original_job WHERE 'chat:' || original_job.user_message_id::text = ${a2aExecutions.key} AND original_job.status NOT IN ('queued', 'running'))
      OR EXISTS (SELECT 1 FROM cost_events original_usage WHERE original_usage.attempt_key = ${a2aExecutions.key} AND original_usage.task_run_id IS NULL AND original_usage.heartbeat_run_id IS NULL AND original_usage.settled_at IS NOT NULL)
    ) AND coalesce((${a2aExecutions.record}->'remoteReconciliation'->>'nextAttemptAt')::bigint, 0) <= ${now} AND coalesce((${a2aExecutions.record}->'remoteReconciliation'->>'leaseExpiresAt')::bigint, 0) <= ${now}`).orderBy(a2aExecutions.updatedAt).for('update', { skipLocked: true }).limit(32);
    for (const candidate of candidates) {
      if (candidate.record.remoteReconciliation?.nextAttemptAt && candidate.record.remoteReconciliation.nextAttemptAt > now || candidate.record.remoteReconciliation?.leaseExpiresAt && candidate.record.remoteReconciliation.leaseExpiresAt > now) continue;
      const owner = await originalExecutionOwner(candidate, tx);
      if (!owner?.ended && candidate.record.phase !== 'reconciliation_required' && candidate.record.deadlineAt > now) continue;
      const [row] = await tx.select().from(a2aExecutions).where(eq(a2aExecutions.key, candidate.key)).limit(1);
      if (!row) continue;
      const attempts = (row.record.remoteReconciliation?.attempts ?? 0) + 1;
      const record = { ...row.record, revision: row.record.revision + 1, remoteReconciliation: {
        state: 'waiting' as const, reason: 'a2a_waiting_for_remote', attempts,
        nextAttemptAt: now + Math.min(60_000, 5_000 * 2 ** Math.min(4, attempts - 1)), leaseToken: randomUUID(), leaseExpiresAt: now + 30_000,
      } };
      const [claimed] = await tx.update(a2aExecutions).set({ record, updatedAt: new Date(now) }).where(eq(a2aExecutions.key, row.key)).returning();
      return claimed ?? null;
    }
    return null;
  });
}

/** Reconciliation settles accounting and capacity only. No card, review, report,
 * work product or merge mutation is authorized by a late remote result. */
export async function finishA2aRemoteReconciliation(claimed: Execution, inspection: RemoteInspection, now = Date.now()): Promise<void> {
  const owner = await originalExecutionOwner(claimed);
  if (inspection.state === 'resolved' && !owner) inspection = { state: 'unresolved', reason: 'a2a_original_usage_identity_missing' };
  const { sanitizeCompanyOutput } = await import('./output-secrets.ts');
  const safeOutcome = inspection.outcome ? await sanitizeCompanyOutput(claimed.companyId, inspection.outcome) : undefined;
  if (safeOutcome && inspection.outcome) { safeOutcome.contextId = inspection.outcome.contextId; safeOutcome.taskId = inspection.outcome.taskId; safeOutcome.state = inspection.outcome.state; }
  await db.transaction(async tx => {
    // Match accounting lock order, then lock the original local run before the
    // journal just as completion/submission do. Settlement shares this transaction.
    await tx.select().from(companies).where(eq(companies.id, claimed.companyId)).for('update').limit(1);
    await tx.select().from(agents).where(eq(agents.id, claimed.agentId)).for('update').limit(1);
    if (owner?.entry.cardId) await tx.select().from(kanbanCards).where(eq(kanbanCards.id, owner.entry.cardId)).for('update').limit(1);
    if (owner?.entry.taskRunId) await tx.select().from(taskRuns).where(eq(taskRuns.id, owner.entry.taskRunId)).for('update').limit(1);
    if (owner?.entry.heartbeatRunId) await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.entry.heartbeatRunId)).for('update').limit(1);
    const [row] = await tx.select().from(a2aExecutions).where(eq(a2aExecutions.key, claimed.key)).for('update').limit(1);
    if (!row || row.record.remoteReconciliation?.leaseToken !== claimed.record.remoteReconciliation?.leaseToken) return;
    const currentOwner = await originalExecutionOwner(row, tx);
    if (inspection.state === 'resolved' && !currentOwner) inspection = { state: 'unresolved', reason: 'a2a_original_usage_identity_missing' };
    if (inspection.reason === 'a2a_never_submitted' && !(row.record.phase === 'preparing' && !row.record.taskId && currentOwner?.ended)) inspection = { state: 'unresolved', reason: 'a2a_acceptance_unknown' };
    if (inspection.state === 'resolved' && inspection.outcome && (!naturalA2aTerminal(inspection.outcome.state) || inspection.outcome.contextId !== row.record.contextId || (row.record.taskId && inspection.outcome.taskId !== row.record.taskId))) inspection = { state: 'unresolved', reason: 'a2a_task_identity_mismatch' };
    if (inspection.state === 'resolved' && currentOwner) {
      const { scopeFromEntry, settleUsage } = await import('./usage-ledger.ts');
      const { unknownUsage } = await import('./usage-facts.ts');
      await settleUsage(scopeFromEntry(currentOwner.entry), inspection.outcome?.usage ?? unknownUsage(inspection.reason === 'a2a_never_submitted' ? 'a2a_never_submitted' : 'a2a_remote_terminal_usage_unavailable'), { transaction: tx });
    }
    // The polling engine might have cached a genuine terminal result while our
    // bounded read was in flight. Never replace it with an older status read.
    const resolved = inspection.state === 'resolved';
    const record = { ...row.record, revision: row.record.revision + 1,
      ...(inspection.taskId ? { taskId: inspection.taskId } : {}),
      ...(safeOutcome && resolved ? { outcome: safeOutcome } : {}),
      // An expired/cancelled invocation remains a recovery failure to its old
      // result pipeline, even when this later accounting-only read succeeds.
      ...(resolved && row.record.phase !== 'terminal' ? { phase: 'reconciliation_required' as const } : {}),
      remoteReconciliation: { ...claimed.record.remoteReconciliation!, state: inspection.state, reason: inspection.reason, leaseToken: null, leaseExpiresAt: null,
        nextAttemptAt: resolved ? Number.MAX_SAFE_INTEGER : now + Math.min(60_000, 5_000 * 2 ** Math.min(4, claimed.record.remoteReconciliation!.attempts - 1)),
      },
    };
    await tx.update(a2aExecutions).set({ record, active: resolved ? false : row.active, updatedAt: new Date(now) }).where(eq(a2aExecutions.key, row.key));
    await refreshAgentRemoteCapacity(claimed.agentId, tx);
  });
}

let sweepingRemote = false;
export async function sweepA2aRemoteReconciliation(onError: (error: unknown) => void = () => {}): Promise<void> {
  if (sweepingRemote) return;
  sweepingRemote = true;
  try {
    const claimed: Execution[] = [];
    for (let index = 0; index < 2; index++) { const row = await claimA2aRemoteReconciliation(); if (row) claimed.push(row); }
    await Promise.all(claimed.map(async row => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        let inspection: RemoteInspection;
        if (row.record.phase === 'preparing' && !row.record.taskId && (await originalExecutionOwner(row))?.ended) inspection = { state: 'resolved', reason: 'a2a_never_submitted' };
        else if (naturalA2aTerminal(row.record.outcome?.state)) inspection = { state: 'resolved', reason: 'a2a_remote_naturally_finished', outcome: row.record.outcome!, taskId: row.record.taskId ?? undefined };
        else {
          const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId)).limit(1);
          if (!agent || agent.companyId !== row.companyId) throw new Error('a2a_original_agent_unavailable');
          const { buildExecutionAgent } = await import('./dispatch.ts');
          const { routeIdentity, resolveBaseUrl, agentPath } = await import('./adapters/a2a.ts');
          const { getA2aTask, listA2aTasks } = await import('./a2a-client.ts');
          const executionAgent = await buildExecutionAgent(agent);
          const route = routeIdentity(executionAgent);
          if (route !== row.record.route) inspection = { state: 'unresolved', reason: 'a2a_remote_route_changed' };
          else {
            const baseUrl = `${await resolveBaseUrl(executionAgent, {})}${agentPath(executionAgent)}`;
            const { getAdapterOptionalStringConfig } = await import('./adapters/config.ts');
            const rpc = { baseUrl, bearerToken: getAdapterOptionalStringConfig(executionAgent, 'a2aBearerToken', 'A2A_BEARER_TOKEN') ?? null, timeoutMs: 5_000, signal: controller.signal };
            inspection = await inspectA2aRemoteTask(row.record, { route, getTask: (taskId, full) => getA2aTask({ ...rpc, taskId, full }), listTasks: (contextId, pageToken) => listA2aTasks({ ...rpc, contextId, pageToken }) });
          }
        }
        await finishA2aRemoteReconciliation(row, inspection);
      } catch (error) {
        onError(error);
        await finishA2aRemoteReconciliation(row, { state: 'unresolved', reason: 'a2a_remote_reconciliation_unavailable' }).catch(onError);
      } finally { clearTimeout(timer); controller.abort(); }
    }));
  } finally { sweepingRemote = false; }
}

export async function agentsWithRemoteStatus<T extends { id: string; isBusy?: boolean | null }>(rows: T[], tx: Executor = db) {
  if (!rows.length) return [];
  const records = await tx.select({ agentId: a2aExecutions.agentId, active: a2aExecutions.active,
    record: sql<A2aInvocationRecord>`jsonb_build_object('outcome', jsonb_build_object('state', ${a2aExecutions.record}->'outcome'->>'state'), 'remoteReconciliation', ${a2aExecutions.record}->'remoteReconciliation')`
  }).from(a2aExecutions).where(and(inArray(a2aExecutions.agentId, rows.map(row => row.id)), sql`(${a2aExecutions.active} IS TRUE OR ${a2aExecutions.record}->'outcome'->>'state' = 'canceled')`));
  return rows.map(agent => {
    const pending = records.filter(row => row.agentId === agent.id && remoteWorkPending(row));
    return { ...agent, isBusy: Boolean(agent.isBusy || pending.length), remoteWork: pending.length ? {
      status: pending.some(row => row.record.remoteReconciliation?.state === 'unresolved') ? 'unresolved' : 'waiting_for_remote',
      count: pending.length, reason: pending[0]!.record.remoteReconciliation?.reason ?? 'a2a_remote_still_running',
    } : null };
  });
}

export async function refreshCancelledCardCapacity(cardId: string): Promise<void> {
  await db.update(heartbeatRuns).set({ status: 'cancelled', completedAt: new Date() }).where(and(eq(heartbeatRuns.cardId, cardId), eq(heartbeatRuns.status, 'running')));
  const runs = await db.select({ agentId: taskRuns.agentId }).from(taskRuns).where(eq(taskRuns.cardId, cardId));
  const heartbeats = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(eq(heartbeatRuns.cardId, cardId));
  for (const id of new Set([...runs, ...heartbeats].map(row => row.agentId).filter((id): id is string => Boolean(id)))) await refreshAgentRemoteCapacity(id);
}
