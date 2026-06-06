import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireRole } from './auth.ts';
import { db } from './db/client.ts';
import { cronRuns } from './db/schema.ts';
import { getDispatchCronStatus, runDispatchCronTick } from './dispatch.ts';

export async function registerCronRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cron/status', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const recentRuns = await db.select().from(cronRuns).orderBy(desc(cronRuns.createdAt)).limit(10);
    return { ...getDispatchCronStatus(), recentRuns };
  });

  app.get('/api/cron/runs', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const query = request.query as { limit?: string };
    return db.select().from(cronRuns).orderBy(desc(cronRuns.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 100), 1), 500));
  });

  app.post('/api/cron/run', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const result = await runDispatchCronTick(app, 'manual');
    if (result.status === 'failed') return reply.code(500).send(result);
    if (result.status === 'skipped') return reply.code(409).send(result);
    return result;
  });
}
