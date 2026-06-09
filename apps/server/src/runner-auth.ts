import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { importJWK, jwtVerify } from 'jose';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agentSessions, agents, machineRunners } from './db/schema.ts';

export type RunnerAuthContext = typeof machineRunners.$inferSelect;
export type AgentSessionAuthContext = {
  session: typeof agentSessions.$inferSelect;
  agent: typeof agents.$inferSelect;
};

export type RunnerRequest = FastifyRequest & { runner?: RunnerAuthContext };
export type AgentSessionRequest = FastifyRequest & { agentSession?: AgentSessionAuthContext };

export function generateRunnerApiKey(): string {
  return `mcr_${randomBytes(32).toString('base64url')}`;
}

export function hashRunnerApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

function runnerKey(request: FastifyRequest): string | null {
  const header = request.headers['x-megacorps-runner-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader?.trim() || bearerToken(request);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function requireRunnerAuth(request: FastifyRequest, reply: FastifyReply): Promise<RunnerAuthContext | null> {
  const key = runnerKey(request);
  if (!key) {
    await reply.code(401).send({ error: 'runner_auth_required' });
    return null;
  }
  const hash = hashRunnerApiKey(key);
  const [runner] = await db.select().from(machineRunners).where(and(eq(machineRunners.apiKeyHash, hash), isNull(machineRunners.deletedAt))).limit(1);
  if (!runner || !safeEqual(runner.apiKeyHash, hash)) {
    await reply.code(401).send({ error: 'runner_auth_invalid' });
    return null;
  }
  if (runner.status === 'disabled') {
    await reply.code(403).send({ error: 'runner_disabled' });
    return null;
  }
  (request as RunnerRequest).runner = runner;
  return runner;
}

export async function requireAgentSessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<AgentSessionAuthContext | null> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'agent_session_auth_required' });
    return null;
  }
  try {
    const unverified = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; aid?: string };
    if (!unverified.sub || !unverified.aid) throw new Error('agent_jwt_missing_subject');
    const [session] = await db.select().from(agentSessions).where(and(
      eq(agentSessions.id, unverified.sub),
      eq(agentSessions.agentId, unverified.aid),
      eq(agentSessions.status, 'active'),
    )).limit(1);
    if (!session?.publicKeyJwk) throw new Error('agent_session_key_missing');
    const key = await importJWK(session.publicKeyJwk as JsonWebKey, 'EdDSA');
    const verified = await jwtVerify(token, key, { audience: process.env.MEGACORPS_AGENT_JWT_AUDIENCE ?? process.env.PUBLIC_API_URL ?? 'megacorps-api' });
    const payload = verified.payload as { sub?: string; aid?: string };
    if (payload.sub !== session.id || payload.aid !== session.agentId) throw new Error('agent_jwt_subject_mismatch');
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, session.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) throw new Error('agent_not_found');
    const ctx = { session, agent };
    (request as AgentSessionRequest).agentSession = ctx;
    return ctx;
  } catch {
    await reply.code(401).send({ error: 'agent_session_auth_invalid' });
    return null;
  }
}
