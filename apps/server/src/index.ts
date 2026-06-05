import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { migrate } from './db/migrate.ts';
import { registerRoutes } from './routes.ts';
import { startDispatchLoop } from './dispatch.ts';
import { registerRequestLogging } from './request-log.ts';

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  await app.register(cookie);
  registerRequestLogging(app);
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const err = error as Error & { statusCode?: number };
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
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
