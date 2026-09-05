import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, approvals, cardComments, departments, kanbanCards, positions, taskLogs, taskRuns } from './db/schema.ts';
import type { AgentResult } from './agent-results.ts';
import { agentRuntimeAvailable } from './runner-availability.ts';

export type ProtocolKind = 'dispatch' | 'review';
type Repair = { failures: number; mode: 'same_session' | 'fresh_context' | 'escalated' | 'blocked' | 'clear'; actorId: string; sessionId: string | null; runKeys: string[]; visitedActorIds: string[]; fallbackId: string | null; updatedAt: string };
export type ProtocolRepairState = Partial<Record<ProtocolKind, Repair>>;
type Card = typeof kanbanCards.$inferSelect;
type Agent = typeof agents.$inferSelect;

/** Only explicit organization relationships are candidates; Boss is never an executor. */
export async function protocolFallback(card: Card, actor: Agent, visited: string[]): Promise<string | null> {
  const roster = await db.select().from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt)));
  const bossPositions = await db.select().from(positions).where(and(eq(positions.companyId, card.companyId), eq(positions.isCompanyBoss, true)));
  const bossIds = new Set(bossPositions.map((position) => position.id));
  const [department] = actor.departmentId ? await db.select().from(departments).where(eq(departments.id, actor.departmentId)).limit(1) : [];
  const candidates = [department?.headAgentId, actor.bossId].filter((id): id is string => Boolean(id));
  const seen = new Set([actor.id, ...visited]);
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const candidate = roster.find((agent) => agent.id === id);
    if (!candidate || !candidate.isActive || candidate.isBusy || (candidate.positionId && bossIds.has(candidate.positionId)) || /^(?:boss|ceo)$/i.test(candidate.role ?? '') || candidate.id === card.assigneeId) continue;
    // A manager cycle cannot authorize a fallback, even if the candidate has another title.
    let manager = candidate.bossId; const chain = new Set([candidate.id]); let cyclic = false;
    while (manager) {
      if (manager === actor.id || chain.has(manager)) { cyclic = true; break; }
      chain.add(manager); manager = roster.find((agent) => agent.id === manager)?.bossId ?? null;
    }
    if (cyclic) continue;
    if (await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: candidate.runtimeId, adapterType: candidate.adapterType ?? 'hermes-ssh' })) return candidate.id;
  }
  return null;
}

export function protocolRepairSession(card: { protocolRepairState?: ProtocolRepairState | null }, kind: ProtocolKind, actorId: string): string | null | undefined {
  const repair = card.protocolRepairState?.[kind];
  if (!repair || repair.actorId !== actorId || repair.mode === 'clear') return undefined;
  return repair.mode === 'same_session' ? repair.sessionId : null;
}

/** Persist the protocol budget, deduplicated by run, independently of transport retries. */
export async function recordProtocolFailure(input: { card: Card; actor: Agent; kind: ProtocolKind; runKey: string; taskRunId?: string | null; sessionId?: string | null; reason: string }) {
  return db.transaction(async (tx) => {
    const [card] = await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id, input.card.id), isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!card) throw new Error('card_not_found');
    const state: ProtocolRepairState = { ...card.protocolRepairState };
    const old = state[input.kind];
    const [run] = input.taskRunId ? await tx.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).limit(1) : [];
    const pendingApprovals = await tx.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.type, 'task_review'), eq(approvals.status, 'pending')));
    if (old?.runKeys.includes(input.runKey) || old?.mode === 'blocked' || (run && !['running', 'queued'].includes(run.status)) || ['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '') || pendingApprovals.some((approval) => (approval.payload as Record<string, unknown> | null)?.humanGate === true)) return { card, duplicate: true, mode: old?.mode ?? 'blocked', fallbackId: old?.fallbackId ?? null, feedback: input.reason };
    if (old?.mode === 'escalated') {
      if (old.fallbackId !== input.actor.id) return { card, duplicate: true, mode: old.mode, fallbackId: old.fallbackId, feedback: input.reason };
      const feedback = `Department help also returned an invalid reply: ${input.reason.slice(0, 1500)}. Automatic protocol repair has stopped; resolve the existing help request before resuming.`;
      state[input.kind] = { ...old, mode: 'blocked', runKeys: [...old.runKeys, input.runKey].slice(-32), visitedActorIds: [...old.visitedActorIds, input.actor.id] };
      const [updated] = await tx.update(kanbanCards).set({ protocolRepairState: state, columnStatus: 'blocked', lastError: feedback, completedAt: null, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id)).returning();
      await tx.insert(taskLogs).values({ cardId: card.id, agentId: input.actor.id, type: 'protocol', status: 'failed', message: feedback });
      return { card: updated ?? card, duplicate: false, mode: 'blocked', fallbackId: old.fallbackId, feedback };
    }
    const failures = Math.min(3, (old?.failures ?? 0) + 1);
    const fallbackId = failures >= 3 ? await protocolFallback(card, input.actor, old?.visitedActorIds ?? []) : null;
    const mode = failures === 1 ? 'same_session' : failures === 2 ? 'fresh_context' : fallbackId ? 'escalated' : 'blocked';
    const example = input.kind === 'review'
      ? '{"kind":"megacorps-report","status":"completed","summary":"Reviewed the provided evidence","verdict":"approved"}'
      : '{"kind":"megacorps-report","status":"progress","summary":"Describe the concrete work completed and remaining work"}';
    const feedback = [
      mode === 'same_session' ? 'Send one corrected response in the same task session.' : mode === 'fresh_context' ? 'Send one corrected response using a fresh task context and the persisted card evidence.' : fallbackId ? `Protocol repair exhausted after three invalid replies. Department help requested from ${fallbackId}; resolve the concrete report blocker before resuming.` : 'Protocol repair exhausted after three invalid replies. No eligible alternate department head or manager can repair this reply. Provide the missing report/evidence or correct the agent configuration before resuming.',
      `Correction needed: ${input.reason.slice(0, 1500)}`,
      `Valid example (use only an evidence-supported status/verdict): ${example}`,
    ].join('\n\n');
    state[input.kind] = { failures, mode, actorId: input.actor.id, sessionId: mode === 'same_session' ? input.sessionId ?? null : null, runKeys: [...(old?.runKeys ?? []), input.runKey].slice(-32), visitedActorIds: [...new Set([...(old?.visitedActorIds ?? []), input.actor.id])], fallbackId, updatedAt: new Date().toISOString() };
    const nextStatus = failures >= 3 ? fallbackId ? 'needs_review' : 'blocked' : input.kind === 'dispatch' ? 'todo' : card.columnStatus ?? 'in_review';
    const [updated] = await tx.update(kanbanCards).set({ protocolRepairState: state, columnStatus: nextStatus, reviewerId: fallbackId ?? undefined, completedAt: null, lastError: feedback, executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id)).returning();
    await tx.insert(cardComments).values({ cardId: card.id, authorType: 'system', action: failures >= 3 ? 'protocol_help_required' : 'protocol_correction', body: feedback, assigneeAgentId: fallbackId, metadata: { kind: input.kind, failures, mode, runKey: input.runKey, fallbackId } });
    await tx.insert(taskLogs).values({ cardId: card.id, agentId: input.actor.id, type: 'protocol', status: failures >= 3 ? 'failed' : 'warning', message: feedback });
    return { card: updated ?? card, duplicate: false, mode, fallbackId, feedback };
  });
}

export async function resetProtocolRepair(cardId: string, kind: ProtocolKind, result: AgentResult, adapterSucceeded: boolean): Promise<void> {
  const summary = result.report?.summary.trim() ?? '';
  const concrete = result.workProducts.length > 0 || (summary.length >= 24 && !/^(?:still\s+)?(?:working|processing|thinking|starting|will\s+|going\s+to\s+)/i.test(summary));
  const meaningful = adapterSucceeded && ((result.source === 'report' && ['progress', 'completed'].includes(result.outcome) && concrete) || (result.source === 'prose' && result.verdictExplicit && !result.verdictError));
  if (!meaningful) return;
  await db.transaction(async (tx) => {
    const [card] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).for('update').limit(1);
    const old = card?.protocolRepairState?.[kind];
    if (!card || !old || old.failures === 0) return;
    await tx.update(kanbanCards).set({ protocolRepairState: { ...card.protocolRepairState, [kind]: { ...old, failures: 0, mode: 'clear', sessionId: null } }, updatedAt: new Date() }).where(eq(kanbanCards.id, cardId));
  });
}
