import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, approvals, cardComments, departments, kanbanCards, positions, taskLogs, taskRuns } from './db/schema.ts';
import { normalizeAgentResult, type AgentResult } from './agent-results.ts';
import { agentRuntimeAvailable } from './runner-availability.ts';
import { completionCondition, guardedCompletionUpdate } from './completion-guard.ts';

export type ProtocolKind = 'dispatch' | 'review';
type Repair = { failures: number; mode: 'same_session' | 'fresh_context' | 'escalated' | 'helped' | 'blocked' | 'clear'; actorId: string; sessionId: string | null; runKeys: string[]; visitedActorIds: string[]; fallbackId: string | null; originalReviewerId?: string | null; helpAttempted?: boolean; updatedAt: string };
export type ProtocolRepairState = Partial<Record<ProtocolKind, Repair>>;

export function protocolHelpOrigin(card: { protocolRepairState?: ProtocolRepairState | null }, actorId: string): ProtocolKind | null {
  return (['dispatch', 'review'] as const).find((kind) => card.protocolRepairState?.[kind]?.mode === 'escalated' && card.protocolRepairState[kind]?.fallbackId === actorId) ?? null;
}

/** A helper resolves a reporting blocker; it has no authority to approve the deliverable. */
export async function finishProtocolHelp(card: Card, actorId: string, output: string, taskRunId?: string | null): Promise<{ card: Card; continueKind: ProtocolKind | null } | null> {
  const kind = protocolHelpOrigin(card, actorId);
  if (!kind) return null;
  const old = card.protocolRepairState![kind]!;
  const result = normalizeAgentResult({ output });
  const valid = ['completed', 'progress'].includes(result.outcome) && !result.verdictError && (result.report?.summary ?? output).trim().length >= 24;
  const message = valid ? 'Department protocol guidance received. The original actor gets one correction using this guidance; another malformed reply stops automatic repair.' : 'Department help did not resolve the reporting blocker. Automatic repair has stopped; resolve the existing help request.';
  const updated = await guardedCompletionUpdate(card, { protocolRepairState: { ...card.protocolRepairState, [kind]: { ...old, mode: valid ? 'helped' : 'blocked', helpAttempted: true } }, columnStatus: valid ? kind === 'dispatch' ? 'todo' : 'in_review' : 'blocked', reviewerId: kind === 'review' ? old.actorId : old.originalReviewerId ?? null, completedAt: null, lastError: message, reviewFeedback: output, executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date() }, taskRunId);
  if (updated) await db.insert(cardComments).values({ cardId: card.id, agentId: actorId, authorType: 'agent', action: 'protocol_help_response', body: output, metadata: { kind, originalActorId: old.actorId, failures: old.failures } });
  return updated ? { card: updated, continueKind: valid ? kind : null } : null;
}
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
    const kind = protocolHelpOrigin(card, input.actor.id) ?? input.kind;
    const old = state[kind];
    const [authorized] = await tx.select().from(kanbanCards).where(completionCondition(input.card)).limit(1);
    if (!authorized) return { card, duplicate: true, mode: old?.mode ?? 'blocked', fallbackId: old?.fallbackId ?? null, feedback: input.reason };
    const [run] = input.taskRunId ? await tx.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).for('update').limit(1) : [];
    const pendingApprovals = await tx.select().from(approvals).where(and(eq(approvals.cardId, card.id), eq(approvals.type, 'task_review'), eq(approvals.status, 'pending')));
    if (old?.runKeys.includes(input.runKey) || old?.mode === 'blocked' || (run && !['running', 'queued'].includes(run.status)) || ['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '') || pendingApprovals.some((approval) => (approval.payload as Record<string, unknown> | null)?.humanGate === true)) return { card, duplicate: true, mode: old?.mode ?? 'blocked', fallbackId: old?.fallbackId ?? null, feedback: input.reason };
    if (old?.mode === 'escalated') {
      if (old.fallbackId !== input.actor.id) return { card, duplicate: true, mode: old.mode, fallbackId: old.fallbackId, feedback: input.reason };
      const feedback = `Department help also returned an invalid reply: ${input.reason.slice(0, 1500)}. Automatic protocol repair has stopped; resolve the existing help request before resuming.`;
      state[kind] = { ...old, mode: 'blocked', runKeys: [...old.runKeys, input.runKey].slice(-32), visitedActorIds: [...old.visitedActorIds, input.actor.id] };
      const [updated] = await tx.update(kanbanCards).set({ protocolRepairState: state, columnStatus: 'blocked', lastError: feedback, completedAt: null, updatedAt: new Date() }).where(completionCondition(input.card)).returning();
      if (!updated) return { card, duplicate: true, mode: old.mode, fallbackId: old.fallbackId, feedback };
      await tx.insert(taskLogs).values({ cardId: card.id, agentId: input.actor.id, type: 'protocol', status: 'failed', message: feedback });
      return { card: updated ?? card, duplicate: false, mode: 'blocked', fallbackId: old.fallbackId, feedback };
    }
    if (old?.mode === 'helped') {
      const feedback = `The original actor's correction after department help is still invalid: ${input.reason}. Automatic protocol repair has stopped.`;
      state[kind] = { ...old, mode: 'blocked', runKeys: [...old.runKeys, input.runKey].slice(-32) };
      const [updated] = await tx.update(kanbanCards).set({ protocolRepairState: state, columnStatus: 'blocked', lastError: feedback, completedAt: null, updatedAt: new Date() }).where(completionCondition(card)).returning();
      return { card: updated ?? card, duplicate: !updated, mode: 'blocked', fallbackId: old.fallbackId, feedback };
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
    state[input.kind] = { failures, mode, actorId: input.actor.id, sessionId: mode === 'same_session' ? input.sessionId ?? null : null, runKeys: [...(old?.runKeys ?? []), input.runKey].slice(-32), visitedActorIds: [...new Set([...(old?.visitedActorIds ?? []), input.actor.id])], fallbackId, originalReviewerId: old?.originalReviewerId ?? card.reviewerId, helpAttempted: Boolean(fallbackId), updatedAt: new Date().toISOString() };
    const nextStatus = failures >= 3 ? fallbackId ? 'needs_review' : 'blocked' : input.kind === 'dispatch' ? 'todo' : card.columnStatus ?? 'in_review';
    const [updated] = await tx.update(kanbanCards).set({ protocolRepairState: state, columnStatus: nextStatus, reviewerId: fallbackId ?? undefined, completedAt: null, lastError: feedback, executionLockId: null, executionLockedByAgentId: null, executionLockedAt: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date() }).where(completionCondition(input.card)).returning();
    if (!updated) return { card, duplicate: true, mode, fallbackId, feedback };
    await tx.insert(cardComments).values({ cardId: card.id, authorType: 'system', action: failures >= 3 ? 'protocol_help_required' : 'protocol_correction', body: feedback, assigneeAgentId: fallbackId, metadata: { kind: input.kind, failures, mode, runKey: input.runKey, fallbackId } });
    await tx.insert(taskLogs).values({ cardId: card.id, agentId: input.actor.id, type: 'protocol', status: failures >= 3 ? 'failed' : 'warning', message: feedback });
    return { card: updated ?? card, duplicate: false, mode, fallbackId, feedback };
  });
}

export async function resetProtocolRepair(cardId: string, kind: ProtocolKind, result: AgentResult, adapterSucceeded: boolean, expectedCard?: Card, taskRunId?: string | null): Promise<void> {
  const summary = result.report?.summary.trim() ?? '';
  const concrete = result.workProducts.length > 0 || (summary.length >= 24 && !/^(?:still\s+)?(?:working|processing|thinking|starting|will\s+|going\s+to\s+)/i.test(summary));
  const meaningful = adapterSucceeded && ((result.source === 'report' && ['progress', 'completed'].includes(result.outcome) && concrete) || (result.source === 'prose' && result.verdictExplicit && !result.verdictError));
  if (!meaningful) return;
  await db.transaction(async (tx) => {
    const [card] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, cardId)).for('update').limit(1);
    if (taskRunId) await tx.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).for('update').limit(1);
    const old = card?.protocolRepairState?.[kind];
    if (!card || !old || old.failures === 0 || old.mode === 'escalated' || ['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '')) return;
    await tx.update(kanbanCards).set({ protocolRepairState: { ...card.protocolRepairState, [kind]: { ...old, failures: 0, mode: 'clear', sessionId: null } }, updatedAt: new Date() }).where(completionCondition(expectedCard ?? card, taskRunId));
  });
}
