import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents } from './db/schema.ts';

// Per-agent identity. Until now every agent authenticated with the one global
// webhook shared secret, so audit could never tell agents apart and a single
// leak was company-wide. Each agent now carries its own bearer token; the
// shared secret stays valid as a legacy fallback.

export const AGENT_TOKEN_PREFIX = 'mcagt_';

export function generateAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function looksLikeAgentToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(AGENT_TOKEN_PREFIX);
}

export type GiteaProvisionAuthDecision =
  | { mode: 'operator' }
  | { mode: 'agent'; agentId: string }
  | { error: 'agent_token_invalid'; status: 401 }
  | { error: 'agent_token_forbidden'; status: 403 };

export function decideGiteaProvisionAuth(pathAgentId: string, bearer: string | null | undefined, callerAgentId: string | null): GiteaProvisionAuthDecision {
  if (!looksLikeAgentToken(bearer)) return { mode: 'operator' };
  if (!callerAgentId) return { error: 'agent_token_invalid', status: 401 };
  if (callerAgentId !== pathAgentId) return { error: 'agent_token_forbidden', status: 403 };
  return { mode: 'agent', agentId: callerAgentId };
}

export function previewAgentToken(token: string | null | undefined): string | null {
  if (!token) return null;
  return `${token.slice(0, AGENT_TOKEN_PREFIX.length + 4)}...${token.slice(-4)}`;
}

export function agentTokenMatches(provided: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(stored);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function authenticateAgentToken(token: string): Promise<typeof agents.$inferSelect | null> {
  if (!looksLikeAgentToken(token)) return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.apiToken, token), isNull(agents.deletedAt))).limit(1);
  // eq() already matched, but confirm through the constant-time comparison so
  // the authentication decision never rests on the query alone.
  if (!agent || !agentTokenMatches(token, agent.apiToken)) return null;
  return agent;
}

export async function rotateAgentToken(agentId: string): Promise<{ token: string; updatedAt: Date } | null> {
  const token = generateAgentToken();
  const now = new Date();
  const [updated] = await db.update(agents)
    .set({ apiToken: token, apiTokenUpdatedAt: now })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .returning({ id: agents.id });
  return updated ? { token, updatedAt: now } : null;
}

export async function revokeAgentToken(agentId: string): Promise<boolean> {
  const [updated] = await db.update(agents)
    .set({ apiToken: null, apiTokenUpdatedAt: new Date() })
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .returning({ id: agents.id });
  return Boolean(updated);
}
