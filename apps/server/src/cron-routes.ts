import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from './auth.ts';
import { db } from './db/client.ts';
import { activityLog, agents, companies, cronRuns } from './db/schema.ts';
import { getDispatchCronStatus, runDispatchCronTick } from './dispatch.ts';
import { runLogRetentionOnce } from './retention.ts';

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
    const recentRuns = await db.select().from(cronRuns).orderBy(desc(cronRuns.createdAt)).limit(10);
    return { ...getDispatchCronStatus(), recentRuns };
  });

  app.get('/api/cron/runs', async (request, reply) => {
    const user = await requireRole(request, reply, 'viewer'); if (!user) return reply;
    const query = request.query as { limit?: string };
    return db.select().from(cronRuns).orderBy(desc(cronRuns.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 100), 1), 500));
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
