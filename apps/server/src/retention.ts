import type { FastifyInstance } from 'fastify';
import { db, sql as rawSql } from './db/client.ts';
import { cronRuns } from './db/schema.ts';
import { eq } from 'drizzle-orm';

const RETENTION_ENABLED = process.env.LOG_RETENTION_ENABLED !== 'false';
const RETENTION_INTERVAL_MS = Math.max(60_000, Number(process.env.LOG_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000));

type RetentionTarget = { table: string; column: string; envVar: string; defaultDays: number };

// Telemetry tables prune by default. Product history (task_logs, activity_log,
// cost_events, card history) defaults to 0 = keep forever; opt in via env.
const RETENTION_TARGETS: RetentionTarget[] = [
  { table: 'api_events', column: 'created_at', envVar: 'RETENTION_API_EVENTS_DAYS', defaultDays: 90 },
  { table: 'prompt_logs', column: 'created_at', envVar: 'RETENTION_PROMPT_LOGS_DAYS', defaultDays: 90 },
  { table: 'cron_runs', column: 'created_at', envVar: 'RETENTION_CRON_RUNS_DAYS', defaultDays: 90 },
  { table: 'activity_log', column: 'created_at', envVar: 'RETENTION_ACTIVITY_LOG_DAYS', defaultDays: 0 },
  { table: 'task_logs', column: 'created_at', envVar: 'RETENTION_TASK_LOGS_DAYS', defaultDays: 0 },
];

function retentionDays(target: RetentionTarget): number {
  const raw = process.env[target.envVar];
  const value = raw === undefined ? target.defaultDays : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export type RetentionResult = {
  status: 'success' | 'failed' | 'skipped';
  deleted: Record<string, number>;
  expiredInvites: number;
  error: string | null;
};

export async function runLogRetentionOnce(source: 'loop' | 'manual' | 'startup' = 'loop'): Promise<RetentionResult> {
  if (!RETENTION_ENABLED && source !== 'manual') return { status: 'skipped', deleted: {}, expiredInvites: 0, error: null };
  const startedAt = new Date();
  const [run] = await db.insert(cronRuns).values({ name: 'log-retention', source, status: 'running', startedAt }).returning();
  const deleted: Record<string, number> = {};
  let expiredInvites = 0;
  let error: string | null = null;
  try {
    for (const target of RETENTION_TARGETS) {
      const days = retentionDays(target);
      if (!days) continue;
      // Table/column names come from the static list above, never from input.
      const result = await rawSql.unsafe(`DELETE FROM ${target.table} WHERE ${target.column} < now() - interval '${days} days'`);
      if (result.count > 0) deleted[target.table] = result.count;
    }
    const invites = await rawSql`UPDATE user_invites SET status = 'expired', updated_at = now() WHERE status = 'pending' AND expires_at < now()`;
    expiredInvites = invites.count;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'log_retention_failed';
  }
  if (run) {
    await db.update(cronRuns).set({
      status: error ? 'failed' : 'success',
      completedAt: new Date(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      error,
      details: { deleted, expiredInvites },
    }).where(eq(cronRuns.id, run.id));
  }
  return { status: error ? 'failed' : 'success', deleted, expiredInvites, error };
}

export function startRetentionLoop(app: FastifyInstance): void {
  if (!RETENTION_ENABLED) return;
  const timer = setInterval(() => {
    void runLogRetentionOnce('loop').catch((error) => app.log.error({ error }, 'log retention tick failed'));
  }, RETENTION_INTERVAL_MS);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
  setTimeout(() => {
    void runLogRetentionOnce('startup').catch((error) => app.log.error({ error }, 'startup log retention failed'));
  }, 60_000).unref?.();
}
