import { and, desc, eq, ilike, isNull, or, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyReply, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from './auth.ts';
import { db } from './db/client.ts';
import { activityLog, agents, companies, cronRuns } from './db/schema.ts';
import { getDispatchCronStatus, runDispatchCronTick } from './dispatch.ts';
import { runLogRetentionOnce } from './retention.ts';
import { encodeLogCursor, LogQueryError, parseLogListQuery } from './log-query.ts';

const cronJobSchema = z.enum(['dispatch-heartbeat', 'daily-report', 'health-check', 'log-retention']);
const runCronSchema = z.object({
  job: cronJobSchema.default('dispatch-heartbeat'),
  companyId: z.string().uuid().nullable().optional(),
  runnerAgentId: z.string().uuid().nullable().optional(),
  schedule: z.object({
    type: z.enum(['every', 'cron', 'at']).default('every'),
    intervalSeconds: z.number().int().min(5).max(86_400).nullable().optional(),
    expression: z.string().trim().max(120).nullable().optional(),
  }).optional(),
});

function jobLabel(job: z.infer<typeof cronJobSchema>): string {
  if (job === 'daily-report') return 'daily-report';
  if (job === 'health-check') return 'health-check';
  if (job === 'log-retention') return 'log-retention';
  return 'dispatch-heartbeat';
}

function cronListQuery(request: { query: unknown }, reply: FastifyReply) {
  try { return parseLogListQuery(request.query as Record<string, string | undefined>, 100); }
  catch (error) {
    if (error instanceof LogQueryError) {
      reply.code(400).send({ error: error.code, message: 'Use view=summary with an opaque cursor and a positive integer limit within the documented bound.' });
      return null;
    }
    throw error;
  }
}

async function loadScope(input: z.infer<typeof runCronSchema>, reply: FastifyReply) {
  const runnerId = input.runnerAgentId ?? null;
  const [runner] = runnerId ? await db.select().from(agents).where(and(eq(agents.id, runnerId), isNull(agents.deletedAt))).limit(1) : [null];
  if (runnerId && !runner) {
    reply.code(400).send({ error: 'runner_agent_not_found' });
    return null;
  }

  const companyId = input.companyId ?? runner?.companyId ?? null;
  const [company] = companyId ? await db.select().from(companies).where(eq(companies.id, companyId)).limit(1) : [null];
  if (companyId && !company) {
    reply.code(400).send({ error: 'company_not_found' });
    return null;
  }
  if (companyId && runner && runner.companyId !== companyId) {
    reply.code(400).send({ error: 'runner_company_mismatch' });
    return null;
  }
  return { companyId, runnerId, company, runner };
}

export async function registerCronRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cron/status', async (request, reply) => {
    const user = await requireRole(request, reply, 'viewer'); if (!user) return reply;
    const recentRuns = await db.select({ id: cronRuns.id, name: drizzleSql<string>`left(${cronRuns.name}, 240)`, source: drizzleSql<string>`left(${cronRuns.source}, 80)`, status: drizzleSql<string>`left(${cronRuns.status}, 80)`, startedAt: cronRuns.startedAt, completedAt: cronRuns.completedAt, durationSeconds: cronRuns.durationSeconds, error: drizzleSql<string | null>`left(${cronRuns.error}, 500)`, createdAt: cronRuns.createdAt }).from(cronRuns).orderBy(desc(cronRuns.createdAt), desc(cronRuns.id)).limit(10);
    return { ...getDispatchCronStatus(), recentRuns };
  });

  app.get('/api/cron/runs', async (request, reply) => {
    const user = await requireRole(request, reply, 'viewer'); if (!user) return reply;
    const query = cronListQuery(request, reply); if (!query) return reply;
    const pattern = query.search ? `%${query.search}%` : null;
    const filters = [
      query.cursor ? drizzleSql`(${cronRuns.createdAt} < ${query.cursor.createdAt}::timestamptz OR (${cronRuns.createdAt} = ${query.cursor.createdAt}::timestamptz AND ${cronRuns.id} < ${query.cursor.id}::uuid))` : undefined,
      pattern ? or(ilike(cronRuns.name, pattern), ilike(cronRuns.source, pattern), ilike(cronRuns.status, pattern), ilike(cronRuns.error, pattern), ilike(drizzleSql`${cronRuns.details}::text`, pattern)) : undefined,
    ].filter(Boolean);
    if (!query.summary) return db.select().from(cronRuns).where(filters.length ? and(...filters) : undefined).orderBy(desc(cronRuns.createdAt), desc(cronRuns.id)).limit(query.limit);
    const rows = await db.select({ id: cronRuns.id, name: drizzleSql<string>`left(${cronRuns.name}, 240)`, source: drizzleSql<string>`left(${cronRuns.source}, 80)`, status: drizzleSql<string>`left(${cronRuns.status}, 80)`, startedAt: cronRuns.startedAt, completedAt: cronRuns.completedAt, durationSeconds: cronRuns.durationSeconds, error: drizzleSql<string | null>`left(${cronRuns.error}, 500)`, createdAt: cronRuns.createdAt, cursorCreatedAt: drizzleSql<string>`${cronRuns.createdAt}::text` }).from(cronRuns).where(filters.length ? and(...filters) : undefined).orderBy(desc(cronRuns.createdAt), desc(cronRuns.id)).limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit); const last = pageRows.at(-1);
    const timestamp = last?.cursorCreatedAt ?? (last?.createdAt instanceof Date ? last.createdAt.toISOString() : last?.createdAt);
    return { items: pageRows.map((selected) => { const { cursorCreatedAt: _, details: __, ...row } = selected as typeof selected & { details?: unknown }; return row; }), nextCursor: rows.length > query.limit && last && timestamp ? encodeLogCursor(timestamp, last.id) : null };
  });

  app.get('/api/cron/runs/:id', async (request, reply) => {
    const user = await requireRole(request, reply, 'viewer'); if (!user) return reply;
    const [row] = await db.select().from(cronRuns).where(eq(cronRuns.id, (request.params as { id: string }).id)).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });

  app.post('/api/cron/run', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const input = runCronSchema.parse(request.body ?? {});
    const scope = await loadScope(input, reply);
    if (!scope) return reply;

    if (input.job === 'dispatch-heartbeat') {
      const result = await runDispatchCronTick(app, 'manual', { companyId: scope.companyId, runnerAgentId: scope.runnerId, jobName: jobLabel(input.job) });
      if (result.status === 'failed') return reply.code(500).send(result);
      if (result.status === 'skipped') return reply.code(409).send(result);
      return result;
    }

    if (input.job === 'log-retention') {
      const result = await runLogRetentionOnce('manual');
      if (result.status === 'failed') return reply.code(500).send(result);
      return result;
    }

    const startedAt = new Date();
    const [run] = await db.insert(cronRuns).values({
      name: jobLabel(input.job),
      source: 'manual',
      status: 'success',
      startedAt,
      completedAt: startedAt,
      durationSeconds: 0,
      details: {
        companyId: scope.companyId,
        companyName: scope.company?.name ?? null,
        runnerAgentId: scope.runnerId,
        runnerAgentName: scope.runner?.name ?? null,
        schedule: input.schedule ?? null,
        scaffoldCompleted: true,
      },
    }).returning();

    if (run && scope.companyId) {
      await db.insert(activityLog).values({
        companyId: scope.companyId,
        actorType: 'user',
        actorId: user.id,
        userId: user.id,
        agentId: scope.runnerId,
        action: `cron.${input.job}.run`,
        entityType: 'cron_run',
        entityId: run.id,
        details: run.details,
      });
    }

    return {
      name: jobLabel(input.job),
      source: 'manual',
      status: 'success',
      companyId: scope.companyId,
      runnerAgentId: scope.runnerId,
      activeCompanies: scope.companyId ? 1 : 0,
      cardsScanned: 0,
      dispatched: 0,
      reviewed: 0,
      skipped: 0,
      errors: 0,
      budgetResetAgents: 0,
      durationSeconds: 0,
      error: null,
    };
  });
}
