import { and, eq, inArray, isNull } from 'drizzle-orm';
import { agentRecoverySchema, type AgentReport } from '@megacorps/shared';
import { db } from './db/client.ts';
import { agents, approvals, cardComments, departments, kanbanCards, mergeIntents, positions, taskRuns } from './db/schema.ts';
import { completionCondition } from './completion-guard.ts';

type Card = typeof kanbanCards.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RecoveryStage = 'dispatch' | 'review' | 'message' | 'message_review';
export type RecoveryState = {
  mode: 'awaiting_manager' | 'reworking' | 'awaiting_human' | 'resolved';
  ownerId: string | null;
  originalAssigneeId: string | null;
  originalReviewerId: string | null;
  stage: RecoveryStage;
  reason: string;
  round: number;
  handledEventKeys: string[];
  visitedOwnerIds: string[];
  sourceMessageId?: string | null;
  sourceAssigneeId?: string | null;
  sourceReviewerId?: string | null;
  updatedAt: string;
  permissionBlocked?: boolean;
};
export const RECOVERY_ROUND_LIMIT = 3;
export function isRecoveryReview(card: Pick<Card, 'protocolRepairState'>, actorId?: string): boolean {
  const r = card.protocolRepairState?.recovery;
  return r?.mode === 'awaiting_manager' && (!actorId || r.ownerId === actorId);
}
export function recoveryPrompt(card: Pick<Card, 'protocolRepairState'>): string {
  const r = card.protocolRepairState?.recovery;
  if (!r) return '';
  return `Recovery review, round ${r.round}/${RECOVERY_ROUND_LIMIT}. Failed stage: ${r.stage}. Problem: ${r.reason}\nRepair instructions/routing only. Preserve the original goal and all evidence gates. Do not execute, approve work products, merge, or mark Done. Return report.status completed and a summary of your recovery decision. Report recovery.action fix_card (patch body/assigneeSlug only), rework (concrete instructions), or raise_to_human, with a nonempty reason. Do not combine the decision with execution, help requests, or artifact verdicts. Permission restrictions cannot be changed by recovery.`;
}
export async function recoveryMutationAllowed(card: Card, tx: Tx, ownGateId?: string): Promise<boolean> {
  if (card.deletedAt || ['done', 'cancelled', 'waiting_on_client'].includes(card.columnStatus ?? '')) return false;
  const pending = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.cardId, card.id), eq(approvals.status, 'pending')));
  if (pending.some((a) => (!ownGateId || a.id !== ownGateId) && (a.type === 'client_checkpoint' || (a.payload as any)?.humanGate === true)))
    return false;
  const active = await tx
    .select()
    .from(mergeIntents)
    .where(and(eq(mergeIntents.cardId, card.id), inArray(mergeIntents.state, ['in_flight', 'accepted', 'uncertain'])))
    .limit(1);
  return !active.length;
}
async function humanGate(card: Card, r: RecoveryState, tx: Tx) {
  await tx.insert(approvals).values({
    companyId: card.companyId,
    cardId: card.id,
    type: 'task_review',
    status: 'pending',
    requestedByAgentId: r.ownerId,
    payload: {
      humanGate: true,
      kind: 'recovery',
      reason: r.reason,
      round: r.round,
      visitedOwnerIds: r.visitedOwnerIds,
      instructions:
        'Resolve the concrete blocker and explicitly resume the appropriate stage. Evidence and permission gates remain mandatory.',
    },
  });
}
async function ownerFor(card: Card, actorId: string | null, visited: string[], tx: Tx) {
  const roster = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt)));
  const actor = roster.find((a) => a.id === actorId);
  const deps = await tx.select().from(departments).where(eq(departments.companyId, card.companyId));
  const bossPositions = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.companyId, card.companyId), eq(positions.isCompanyBoss, true)));
  const bosses = roster.filter((a) => bossPositions.some((p) => p.id === a.positionId));
  const candidates = [
    card.reviewerId,
    deps.find((d) => d.id === actor?.departmentId)?.headAgentId,
    actor?.bossId,
    ...bosses.map((a) => a.id),
  ];
  for (const id of candidates) {
    if (!id || id === actorId || visited.includes(id)) continue;
    const candidate = roster.find((a) => a.id === id && a.isActive);
    if (!candidate) continue;
    const seen = new Set([id]);
    let next = candidate.bossId;
    let cycle = false;
    while (next) {
      if (next === actorId || seen.has(next)) {
        cycle = true;
        break;
      }
      seen.add(next);
      next = roster.find((a) => a.id === next)?.bossId ?? null;
    }
    if (!cycle) return id; // Busy managers are queued, never silently skipped.
  }
  return null;
}
export async function requestCardRecovery(
  inputCard: Card,
  failure: {
    reason: string;
    eventKey: string;
    actorId: string | null;
    stage: RecoveryStage;
    sourceMessageId?: string | null;
    taskRunId?: string | null;
    originalReviewerId?: string | null;
    permissionBlocked?: boolean;
  },
  executor?: Tx,
) {
  const claim = async (tx: Tx) => {
    const [card] = await tx
      .select()
      .from(kanbanCards)
      .where(and(eq(kanbanCards.id, inputCard.id), eq(kanbanCards.companyId, inputCard.companyId)))
      .for('update')
      .limit(1);
    if (!card || !(await recoveryMutationAllowed(card, tx))) return null;
    const old = card.protocolRepairState?.recovery;
    if (old?.handledEventKeys.includes(failure.eventKey) || old?.mode === 'awaiting_human') return null;
    const [same] = await tx.select().from(kanbanCards).where(completionCondition(inputCard)).limit(1);
    if (!same) return null;
    if (failure.taskRunId) {
      const [sourceRun] = await tx.select().from(taskRuns).where(eq(taskRuns.id, failure.taskRunId)).for('update').limit(1);
      if (
        !sourceRun ||
        sourceRun.cardId !== card.id ||
        sourceRun.companyId !== card.companyId ||
        sourceRun.agentId !== failure.actorId ||
        sourceRun.kind !== failure.stage ||
        !['running', 'queued', 'failed'].includes(sourceRun.status)
      )
        return null;
      const newer = await tx
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.cardId, card.id), eq(taskRuns.kind, failure.stage)));
      if (newer.some((run) => run.id !== sourceRun.id && run.createdAt && sourceRun.createdAt && run.createdAt > sourceRun.createdAt))
        return null;
    }
    if (old?.mode === 'awaiting_manager' && failure.actorId !== old.ownerId) return null;
    const [source] = failure.sourceMessageId
      ? await tx
          .select()
          .from(cardComments)
          .where(and(eq(cardComments.id, failure.sourceMessageId), eq(cardComments.cardId, card.id)))
          .limit(1)
      : [];
    const visited = old?.visitedOwnerIds ?? [];
    const ownerId = (old?.round ?? 0) < RECOVERY_ROUND_LIMIT ? await ownerFor(card, failure.actorId, visited, tx) : null;
    const continuing = old?.mode === 'awaiting_manager' ? old : undefined;
    const r: RecoveryState = {
      mode: ownerId ? 'awaiting_manager' : 'awaiting_human',
      ownerId,
      originalAssigneeId: continuing ? continuing.originalAssigneeId : card.assigneeId,
      originalReviewerId: continuing
        ? continuing.originalReviewerId
        : failure.originalReviewerId !== undefined
          ? failure.originalReviewerId
          : card.reviewerId,
      stage: continuing?.stage ?? failure.stage,
      reason: failure.reason,
      round: (old?.round ?? 0) + (ownerId ? 1 : 0),
      handledEventKeys: [...(old?.handledEventKeys ?? []), failure.eventKey],
      visitedOwnerIds: ownerId ? [...visited, ownerId] : visited,
      sourceMessageId: continuing?.sourceMessageId ?? failure.sourceMessageId,
      sourceAssigneeId: continuing?.sourceAssigneeId ?? source?.assigneeAgentId,
      sourceReviewerId: continuing?.sourceReviewerId ?? source?.reviewerAgentId,
      updatedAt: new Date().toISOString(),
    };
    const protocolRepairState = { ...card.protocolRepairState, recovery: r };
    r.permissionBlocked = old?.permissionBlocked || failure.permissionBlocked || undefined;
    if (ownerId) delete protocolRepairState.review;
    const runRetryState = { ...card.runRetryState };
    if (ownerId) delete runRetryState.review;
    const [updated] = await tx
      .update(kanbanCards)
      .set({
        protocolRepairState,
        columnStatus: ownerId ? 'needs_review' : 'in_review',
        reviewerId: ownerId,
        completedAt: null,
        lastError: r.reason,
        nextRunAt: null,
        runRetryState,
        executionLockId: null,
        executionLockedByAgentId: null,
        executionLockedAt: null,
        executionLockExpiresAt: null,
        activeHeartbeatRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, card.id))
      .returning();
    if (!ownerId) await humanGate(updated!, r, tx);
    await tx.insert(cardComments).values({
      cardId: card.id,
      authorType: 'system',
      action: 'recovery_requested',
      body: r.reason,
      assigneeAgentId: ownerId,
      metadata: { recovery: r },
    });
    return updated ?? null;
  };
  return executor ? claim(executor) : db.transaction(claim);
}
export async function applyRecoveryReport(inputCard: Card, actorId: string, report: AgentReport, taskRunId?: string | null) {
  const parsed = agentRecoverySchema.safeParse(report?.recovery);
  if (
    !parsed.success ||
    report.status !== 'completed' ||
    report.verdict ||
    report.workProducts?.length ||
    report.children?.length ||
    report.delegations?.length ||
    report.request ||
    report.checkpoint ||
    report.broadcast ||
    report.findings?.length ||
    report.verifications?.length ||
    report.dispositions?.length ||
    report.escalation
  )
    throw new Error(
      'recovery_action_required: Return one completed recovery decision; do not combine recovery with execution, help requests, artifact approval, or work products',
    );
  const action = parsed.data;
  return db.transaction(async (tx) => {
    const [card] = await tx
      .select()
      .from(kanbanCards)
      .where(and(eq(kanbanCards.id, inputCard.id), eq(kanbanCards.companyId, inputCard.companyId)))
      .for('update')
      .limit(1);
    if (!card || !(await recoveryMutationAllowed(card, tx))) return null;
    const r = card.protocolRepairState?.recovery;
    if (!r || r.mode !== 'awaiting_manager' || r.ownerId !== actorId || card.reviewerId !== actorId)
      throw new Error('recovery_authority_changed');
    if (r.permissionBlocked && action.action !== 'raise_to_human')
      throw new Error(
        'recovery_permission_decision_required: Explain the restriction and raise_to_human; recovery cannot authorize a forbidden operation',
      );
    const [current] = await tx.select().from(kanbanCards).where(completionCondition(inputCard, taskRunId)).limit(1);
    if (!current) return null;
    const roster = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt)));
    if (!roster.some((a) => a.id === actorId && a.isActive)) throw new Error('recovery_authority_changed');
    if (taskRunId) {
      const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).for('update').limit(1);
      if (!run || run.companyId !== card.companyId || run.agentId !== actorId || run.kind !== 'review') return null;
    }
    let assigneeId = r.originalAssigneeId;
    let body = card.body;
    if (action.action === 'fix_card') {
      if (action.patch.body) body = `${card.body ?? ''}\n\nRecovery clarification (${action.reason}):\n${action.patch.body}`;
      if (action.patch.assigneeSlug) {
        if (r.sourceMessageId) throw new Error('recovery_message_assignee_patch_forbidden: Resume the exact delegated request');
        const target = roster.find((a) => a.slug === action.patch.assigneeSlug && a.isActive);
        const deps = await tx.select().from(departments).where(eq(departments.companyId, card.companyId));
        const bossPositions = await tx
          .select()
          .from(positions)
          .where(and(eq(positions.companyId, card.companyId), eq(positions.isCompanyBoss, true)));
        const isBoss = (id: string) =>
          roster.some((a) => a.id === id && (bossPositions.some((p) => p.id === a.positionId) || /^(boss|ceo)$/i.test(a.role ?? '')));
        const authorized =
          target &&
          (target.bossId === actorId ||
            deps.some((d) => d.id === target.departmentId && d.headAgentId === actorId) ||
            (isBoss(actorId) && deps.some((d) => d.headAgentId === target.id)));
        if (
          !target ||
          !authorized ||
          isBoss(target.id) ||
          roster.some(
            (a) =>
              a.isActive &&
              a.id !== target.id &&
              (a.bossId === target.id || deps.some((d) => d.headAgentId === target.id && d.id === a.departmentId)),
          )
        )
          throw new Error('recovery_assignee_not_authorized_executor');
        assigneeId = target.id;
      }
    }
    const human = action.action === 'raise_to_human';
    const pending = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.cardId, card.id), eq(approvals.type, 'task_review'), eq(approvals.status, 'pending')));
    for (const approval of pending) {
      const payload = approval.payload as Record<string, unknown> | null;
      if (!payload?.humanGate && !payload?.roundId && !payload?.reviewRoundId && !payload?.panel)
        await tx
          .update(approvals)
          .set({
            status: 'cancelled',
            decisionNote: 'Superseded by recovery guidance; no artifact approval was granted.',
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, approval.id));
    }
    const retries = { ...card.runRetryState };
    if (r.stage !== 'dispatch') delete retries[r.stage];
    if (!human && r.sourceMessageId) {
      const [source] = await tx
        .select()
        .from(cardComments)
        .where(and(eq(cardComments.id, r.sourceMessageId), eq(cardComments.cardId, card.id)))
        .for('update')
        .limit(1);
      if (
        !source ||
        source.assigneeAgentId !== r.sourceAssigneeId ||
        source.reviewerAgentId !== r.sourceReviewerId ||
        ['approved', 'done', 'cancelled'].includes(source.delegationStatus ?? '')
      )
        throw new Error('recovery_message_authority_changed');
      await tx
        .update(cardComments)
        .set({
          delegationStatus: r.stage === 'message_review' ? 'submitted' : 'queued',
          body: `${source.body}\n\nRecovery guidance:\n${action.instructions ?? action.reason}`,
        })
        .where(eq(cardComments.id, source.id));
    }
    const next: RecoveryState = {
      ...r,
      mode: human ? 'awaiting_human' : 'reworking',
      reason: action.reason,
      updatedAt: new Date().toISOString(),
    };
    const protocolRepairState = { ...card.protocolRepairState, recovery: next };
    if (!human && (r.stage === 'dispatch' || r.stage === 'review')) {
      const failed = protocolRepairState[r.stage];
      if (failed) protocolRepairState[r.stage] = { ...failed, failures: 0, mode: 'clear', sessionId: null };
    }
    const [updated] = await tx
      .update(kanbanCards)
      .set({
        body,
        assigneeId,
        reviewerId: human ? null : r.originalReviewerId,
        columnStatus: human ? 'in_review' : r.sourceMessageId ? 'in_progress' : r.stage === 'review' ? 'in_review' : 'todo',
        protocolRepairState,
        runRetryState: retries,
        retryCount: r.stage === 'dispatch' ? 0 : undefined,
        nextRunAt: null,
        lastError: action.reason,
        reviewFeedback: action.instructions ?? action.reason,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, card.id))
      .returning();
    if (human) await humanGate(updated!, next, tx);
    await tx.insert(cardComments).values({
      cardId: card.id,
      agentId: actorId,
      authorType: 'agent',
      action: `recovery_${action.action}`,
      body: [action.reason, action.instructions].filter(Boolean).join('\n\n'),
      metadata: { round: r.round },
    });
    return { card: updated!, continueKind: human ? null : r.stage, sourceMessageId: r.sourceMessageId ?? null };
  });
}

export async function finishHumanRecovery(
  card: Card,
  approvalId: string,
  userId: string,
  input: { status: string; instructions?: string },
) {
  if (input.status !== 'cancelled' && !input.instructions?.trim()) throw new Error('recovery_instructions_required');
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .select()
      .from(kanbanCards)
      .where(and(eq(kanbanCards.id, card.id), eq(kanbanCards.companyId, card.companyId)))
      .for('update')
      .limit(1);
    const [gate] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.cardId, card.id)))
      .for('update')
      .limit(1);
    const r = fresh?.protocolRepairState.recovery;
    if (
      !fresh ||
      !gate ||
      gate.status !== 'pending' ||
      (gate.payload as any)?.kind !== 'recovery' ||
      r?.mode !== 'awaiting_human' ||
      !(await recoveryMutationAllowed(fresh, tx, approvalId))
    )
      return null;
    const cancelled = input.status === 'cancelled';
    if (!cancelled && r.sourceMessageId) {
      const [source] = await tx
        .select()
        .from(cardComments)
        .where(and(eq(cardComments.id, r.sourceMessageId), eq(cardComments.cardId, card.id)))
        .for('update')
        .limit(1);
      if (
        !source ||
        source.assigneeAgentId !== r.sourceAssigneeId ||
        source.reviewerAgentId !== r.sourceReviewerId ||
        ['approved', 'done', 'cancelled'].includes(source.delegationStatus ?? '')
      )
        throw new Error('recovery_message_authority_changed');
      await tx
        .update(cardComments)
        .set({
          delegationStatus: r.stage === 'message_review' ? 'submitted' : 'queued',
          body: `${source.body}\n\nClient recovery guidance:\n${input.instructions}`,
        })
        .where(eq(cardComments.id, source.id));
    }
    await tx
      .update(approvals)
      .set({
        status: cancelled ? 'cancelled' : 'answered',
        decisionNote: input.instructions,
        decidedByUserId: userId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, gate.id));
    const retries = { ...fresh.runRetryState };
    if (r.stage !== 'dispatch') delete retries[r.stage];
    const next: RecoveryState = {
      ...r,
      ownerId: null,
      mode: cancelled ? 'resolved' : 'reworking',
      permissionBlocked: false,
      reason: input.instructions ?? 'Recovery stopped by the client.',
      updatedAt: new Date().toISOString(),
    };
    const protocolRepairState = { ...fresh.protocolRepairState, recovery: next };
    if (r.stage === 'dispatch' || r.stage === 'review') delete protocolRepairState[r.stage];
    const [updated] = await tx
      .update(kanbanCards)
      .set({
        protocolRepairState,
        runRetryState: retries,
        columnStatus: cancelled ? 'blocked' : r.sourceMessageId ? 'in_progress' : r.stage === 'review' ? 'in_review' : 'todo',
        assigneeId: r.originalAssigneeId,
        reviewerId: r.originalReviewerId,
        retryCount: r.stage === 'dispatch' ? 0 : undefined,
        nextRunAt: null,
        completedAt: null,
        reviewFeedback: input.instructions,
        lastError: next.reason,
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, fresh.id))
      .returning();
    await tx.insert(cardComments).values({
      cardId: card.id,
      authorType: 'user',
      action: 'recovery_human_decision',
      body: next.reason,
      metadata: { userId, approvalId, round: r.round, status: input.status },
    });
    return { card: updated!, continueKind: cancelled ? null : r.stage, sourceMessageId: r.sourceMessageId ?? null };
  });
}
