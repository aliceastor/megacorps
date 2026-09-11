import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql as q } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from './db/client.ts';
import { agents, taskRuns } from './db/schema.ts';

type TaskRun = typeof taskRuns.$inferSelect;
const recovery = new AsyncLocalStorage<TaskRun>();
const owners = new AsyncLocalStorage<A2aTaskRunLease>();
export const currentA2aRecoveryRun = () => recovery.getStore();
export function withA2aRecoveryRun<T>(run: TaskRun, work: () => Promise<T>): Promise<T> {
  return recovery.run(run, work);
}

export class A2aTaskRunLeaseLostError extends Error {
  constructor() { super('a2a_task_run_lease_lost'); }
}
export const isA2aTaskRunLeaseLost = (error: unknown): error is A2aTaskRunLeaseLostError => error instanceof A2aTaskRunLeaseLostError;

/** A disconnected advisory session can never regain its original authority,
 * including when another invocation happens to use the same worker name. */
export class A2aTaskRunLease {
  private lost = false;
  private readonly runId: string;
  private readonly owner: string | null;
  constructor(run: Pick<TaskRun, 'id' | 'lockedBy'>) { this.runId = run.id; this.owner = run.lockedBy; }
  markLost() { this.lost = true; }
  async assertCurrent(): Promise<void> {
    if (this.lost || !this.owner) throw new A2aTaskRunLeaseLostError();
    try {
      const [run] = await db.select().from(taskRuns).where(and(eq(taskRuns.id, this.runId), eq(taskRuns.status, 'running'), eq(taskRuns.lockedBy, this.owner))).limit(1);
      if (!run || this.lost) throw new A2aTaskRunLeaseLostError();
    } catch {
      this.markLost();
      throw new A2aTaskRunLeaseLostError();
    }
  }
}
export function withA2aTaskRunLease<T>(lease: A2aTaskRunLease, work: () => Promise<T>): Promise<T> { return owners.run(lease, work); }
export async function assertA2aTaskRunOwner(): Promise<void> { await owners.getStore()?.assertCurrent(); }

/** The session lock prevents two live processes consuming the same result even
 * when one misses a lease renewal. It is released automatically on disconnect. */
export async function withTaskRunWorkerLease<T>(run: TaskRun, work: () => Promise<T>): Promise<T | undefined> {
  const [agent] = run.agentId ? await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1) : [];
  if (agent?.adapterType !== 'a2a') return work();
  // A lease must not occupy the shared application pool for the entire remote
  // task: a full worker batch would otherwise starve its own result writes.
  const lease = new A2aTaskRunLease(run);
  let locked = false;
  let renewal: ReturnType<typeof setInterval> | undefined;
  const leaseSql = postgres(process.env.DATABASE_URL ?? 'postgresql://megacorps:megacorps_dev@localhost:5432/megacorps', {
    max: 1,
    onclose: () => { lease.markLost(); if (renewal) clearInterval(renewal); },
  });
  const connection = await leaseSql.reserve();
  try {
    const [claim] = await connection`SELECT pg_try_advisory_lock(hashtextextended(${`a2a-task-run:${run.id}`}, 0)) AS locked`;
    locked = claim?.locked === true;
    if (!locked) return undefined;
    const [current] = await db.select().from(taskRuns).where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'running'), eq(taskRuns.lockedBy, run.lockedBy!))).limit(1);
    if (!current) return undefined;
    renewal = setInterval(() => {
      void lease.assertCurrent().then(() => db.update(taskRuns).set({ lockedAt: new Date() }).where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'running'), eq(taskRuns.lockedBy, run.lockedBy!))))
        .catch(() => { lease.markLost(); if (renewal) clearInterval(renewal); });
    }, 10_000);
    renewal.unref?.();
    return await withA2aTaskRunLease(lease, work);
  } finally {
    if (renewal) clearInterval(renewal);
    if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${`a2a-task-run:${run.id}`}, 0))`.catch(() => {});
    connection.release();
    await leaseSql.end({ timeout: 2 });
  }
}

/** Reclaim only the original running invocation. Never reset its start,
 * heartbeat, journal deadline or remote task identity. */
export async function claimRecoverableA2aTaskRun(workerId: string): Promise<TaskRun | null> {
  return db.transaction(async tx => {
    const rows = await tx.execute<{ id: string }>(q`
      SELECT tr.id FROM task_runs tr
      JOIN heartbeat_runs hr ON hr.id = tr.heartbeat_run_id
      JOIN agents a ON a.id = tr.agent_id
      JOIN kanban_cards c ON c.id = tr.card_id
      JOIN a2a_execution_aliases alias ON alias.key = 'task-run:' || tr.id::text
      JOIN a2a_executions e ON e.key = alias.execution_key
      JOIN cost_events usage ON usage.attempt_key = e.key
      WHERE tr.status = 'running' AND tr.locked_at < now() - interval '45 seconds'
        AND a.adapter_type = 'a2a' AND a.is_active = true AND a.deleted_at IS NULL
        AND e.active = true AND e.agent_id = a.id AND e.company_id = tr.company_id
        AND usage.agent_id = a.id AND usage.company_id = tr.company_id AND usage.card_id = c.id
        AND usage.runtime_id IS NOT DISTINCT FROM a.runtime_id
        AND hr.status = 'running' AND hr.agent_id = a.id AND hr.card_id = c.id
        AND c.deleted_at IS NULL AND c.column_status NOT IN ('done', 'cancelled', 'waiting_on_client')
        AND ((tr.kind = 'dispatch' AND c.assignee_id = a.id AND c.column_status = 'in_progress' AND c.execution_lock_id = hr.id)
          OR (tr.kind = 'review' AND c.reviewer_id = a.id AND c.column_status IN ('in_review', 'needs_review'))
          OR (tr.kind IN ('message', 'message_review') AND EXISTS (SELECT 1 FROM card_comments cc WHERE cc.id = tr.message_comment_id AND cc.card_id = c.id AND cc.delegation_status NOT IN ('cancelled', 'approved'))))
        AND NOT EXISTS (SELECT 1 FROM approvals ap WHERE ap.card_id = c.id AND ap.status = 'pending' AND ap.type = 'task_review' AND ap.payload->>'humanGate' = 'true')
        AND pg_try_advisory_xact_lock(hashtextextended('a2a-task-run:' || tr.id::text, 0))
      ORDER BY tr.locked_at LIMIT 1 FOR UPDATE OF tr SKIP LOCKED
    `);
    if (!rows[0]) return null;
    const [claimed] = await tx.update(taskRuns).set({ lockedBy: workerId, lockedAt: new Date(), updatedAt: new Date() }).where(eq(taskRuns.id, rows[0].id)).returning();
    return claimed ?? null;
  });
}
