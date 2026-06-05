import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { migrate } from './db/migrate.ts';
import { registerRoutes } from './routes.ts';
import { startDispatchLoop } from './dispatch.ts';
import { registerRequestLogging } from './request-log.ts';
import { registerRateLimit } from './rate-limit.ts';

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  await app.register(cookie);
  registerRequestLogging(app);
  registerRateLimit(app);
  app.setErrorHandler((error, request, reply) => {
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
  await registerRoutes(app);
  startDispatchLoop(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  const app = await buildServer();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
}
