import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { migrate } from './db/migrate.ts';
import { registerRoutes } from './routes.ts';
import { startDispatchLoop } from './dispatch.ts';
import { startMaintenanceLoop } from './agent-maintenance.ts';
import { startRetentionLoop } from './retention.ts';
import { startProvisioningSweep } from './bootstrap-provisioning.ts';
import { registerRequestLogging } from './request-log.ts';
import { registerRateLimit } from './rate-limit.ts';
import { registerCsrfOriginCheck } from './csrf.ts';
import { registerLiveRoutes } from './live.ts';

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  await app.register(cookie);
  registerRequestLogging(app);
  registerRateLimit(app);
  registerCsrfOriginCheck(app);
  app.setErrorHandler((error, request, reply) => {
    let cause: any = error;
    for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
      if (cause.code === 'MC409') {
        reply.code(409).send({ error: 'merge_in_flight', detail: 'Gitea may already have accepted the authorized merge. This change cannot guarantee cancellation; reconcile the merge before changing gates or project policy.' });
        return;
      }
    }
    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'validation failed');
      reply.code(400).send({ error: 'validation_failed', issues: error.issues });
      return;
    }
    const err = error as Error & { statusCode?: number };
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) request.log.error(error);
    else request.log.warn({ error: err.message, status }, 'client request failed');
    reply.code(status).send({ error: err.message });
  });
  await registerLiveRoutes(app);
  await registerRoutes(app);
  startDispatchLoop(app);
  startMaintenanceLoop(app);
  startRetentionLoop(app);
  startProvisioningSweep(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  const app = await buildServer();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
}
