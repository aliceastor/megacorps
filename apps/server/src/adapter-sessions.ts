import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { adapterSessions, taskRuns } from './db/schema.ts';

type AdapterSessionKind = 'dispatch' | 'review' | 'message' | 'message_review' | 'chat';
type AdapterSessionScopeType = 'card' | 'chat';

type SessionInput = {
  companyId: string;
  agentId: string;
  runtimeId?: string | null;
  adapterType: string;
  scopeType: AdapterSessionScopeType;
  scopeId: string;
  kind: AdapterSessionKind;
};

async function findAnyAdapterSession(input: SessionInput) {
  const [session] = await db.select().from(adapterSessions).where(and(
    eq(adapterSessions.companyId, input.companyId),
    eq(adapterSessions.agentId, input.agentId),
    eq(adapterSessions.scopeType, input.scopeType),
    eq(adapterSessions.scopeId, input.scopeId),
    eq(adapterSessions.kind, input.kind),
  )).limit(1);
  return session ?? null;
}

export async function findAdapterSession(input: SessionInput) {
  const [session] = await db.select().from(adapterSessions).where(and(
    eq(adapterSessions.companyId, input.companyId),
    eq(adapterSessions.agentId, input.agentId),
    eq(adapterSessions.scopeType, input.scopeType),
    eq(adapterSessions.scopeId, input.scopeId),
    eq(adapterSessions.kind, input.kind),
    eq(adapterSessions.status, 'active'),
  )).limit(1);
  return session ?? null;
}

export async function rememberAdapterSession(input: SessionInput & { adapterSessionId: string; lastTurnId?: string | null; taskRunId?: string | null; metadata?: Record<string, unknown> }) {
  const existing = await findAnyAdapterSession(input);
  const values = {
    companyId: input.companyId,
    agentId: input.agentId,
    runtimeId: input.runtimeId ?? null,
    adapterType: input.adapterType,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    kind: input.kind,
    adapterSessionId: input.adapterSessionId,
    lastTurnId: input.lastTurnId ?? null,
    status: 'active',
    metadata: input.metadata ?? {},
    updatedAt: new Date(),
  };
  const [session] = existing
    ? await db.update(adapterSessions).set(values).where(eq(adapterSessions.id, existing.id)).returning()
    : await db.insert(adapterSessions).values(values).returning();
  if (input.taskRunId && session) {
    await db.update(taskRuns).set({
      adapterSessionId: session.id,
      adapterTurnId: input.lastTurnId ?? null,
      updatedAt: new Date(),
    }).where(eq(taskRuns.id, input.taskRunId));
  }
  return session ?? existing;
}

export async function resetAdapterSessionsForAgent(agentId: string): Promise<void> {
  await db.update(adapterSessions).set({ status: 'reset', updatedAt: new Date() }).where(eq(adapterSessions.agentId, agentId));
}
