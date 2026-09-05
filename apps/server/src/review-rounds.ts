import { sealDeliveryAcceptance } from './delivery-acceptance.ts';
import { buildCommonCompanyContext } from './company-context.ts';
// Blind review rounds (company pipeline design §17): the database side of the
// panel. A panel round gives every reviewer a sealed slot and a panel_review
// task run; findings go to review_findings, never to the message board or the
// lifecycle log, so reviewers cannot see each other until the round closes.
// The author answers the merged findings with dispositions; a verify round
// sends those back to the same reviewers; exhausted fixes climb the boss
// chain and end at a human. The pure rules live in review-panel.ts; this file
// is imported by dispatch.ts for the wiring and imports dispatch.ts for the
// shared primitives (logs, messages, runs), so nothing here runs at load time.

import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AgentReport, AgentReportDisposition, AgentReportEscalation, CardStatus } from '@megacorps/shared';
import { db } from './db/client.ts';
import { agents, approvals, cardComments, companies, departments, heartbeatRuns, kanbanCards, positions, reviewFindings, reviewRounds, taskRuns, workProducts } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { publishLiveEvent } from './live.ts';
import { notify } from './notifications.ts';
import { agentRuntimeAvailable, createRuntimeAvailabilityCache } from './runner-availability.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';
import { normalizeAgentResult } from './agent-results.ts';
import { recordCardAction } from './card-actions.ts';
import { REVIEW_SCORE_RUBRIC } from './agent-cv.ts';
import { REVIEWER_PLAYBOOK } from './role-playbooks.ts';
import { acceptanceOf } from './card-brief.ts';
import { composeReviewPanel, dispositionWarnings, findingIsOpen, formatDispositionRules, formatFindingsForPrompt, formatRoundClosedMessage, formatVerifyInstructions, mergeFindings, nextFixOwner, normalizeFindingKey, normalizeSeverity, panelRequired, roundDecision, takeoverTrigger, verificationDecision, type FindingRow, type MergedFinding, type ReviewVerdict, type TakeoverTrigger, type VerificationInput } from './review-panel.ts';
import { addActivity, addCardMessage, addStageLog, addTaskLog, budgetOk, buildExecutionAgent, buildReviewPrompt, cardTaskTimeoutSeconds, cascadeParentStatus, claimAgentCapacity, clipText, completeTaskRun, completionBlockedByChildren, createPendingApproval, dispatchInternals, enqueuePanelReviewRun, enqueueTaskRun, openHeartbeatRun, recordCostAndEnforceBudget, recordReviewScore, rememberTaskAdapterSession, resolvePendingApproval, scopedAdapterSession } from './dispatch.ts';
import { applyMergeGatePlan, noteMergeEvidenceRequired, parkForMerge, planMergeGate } from './merge-gate.ts';
import { guardedCompletionUpdate } from './completion-guard.ts';

type CardRow = typeof kanbanCards.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ReviewRoundRow = typeof reviewRounds.$inferSelect;
type FindingDbRow = typeof reviewFindings.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
type CardCommentRow = typeof cardComments.$inferSelect;
type RoundKind = 'panel' | 'verify';
type RoundOutcome = 'approved' | 'revision_requested' | 'unavailable' | 'cancelled';

export const PANEL_REVIEW_TIMEOUT_MINUTES = Math.max(5, Number(process.env.PANEL_REVIEW_TIMEOUT_MINUTES ?? 60));
const SYSTEM_MERGE_NOTE = 'merged at round close';
const HUMAN_GATE_FLAG = 'humanGate';
const VERDICT_MISSING = 'review_verdict_missing: return a JSON megacorps-report with "verdict" (approved | revision_requested | escalate) and "score".';

export type FixRound = { round: ReviewRoundRow; findings: FindingRow[] };
export type OpenRoundResult = { outcome: 'opened' | 'degraded' | 'human_gate' | 'single_fallback' | 'already_open'; roundId: string | null; reviewerIds: string[] };

function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function errorCode(message: string): string {
  return message.split(':')[0]?.trim().slice(0, 80) || 'panel_review_failed';
}

function findingFromRow(row: FindingDbRow): FindingRow {
  return {
    key: row.findingKey,
    reviewerId: row.reviewerAgentId,
    severity: normalizeSeverity(row.severity),
    file: row.file,
    line: row.line,
    title: row.title,
    evidence: row.evidence,
    requiredFix: row.requiredFix,
    reassign: Boolean(row.reassign),
    disposition: row.disposition,
    dispositionReason: row.dispositionReason,
    mergedInto: row.mergedInto,
    codeEvidence: row.codeEvidence,
    testEvidence: row.testEvidence,
    verification: row.verification,
    verificationNote: row.verificationNote,
  };
}

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

function sortFindings<T extends Pick<FindingRow, 'severity' | 'key'>>(findings: T[]): T[] {
  return [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || a.key.localeCompare(b.key));
}

function initialsOf(name: string, fallback: string): string {
  const letters = name.split(/[\s_-]+/).map((part) => part.replace(/[^\p{L}\p{N}]/gu, '').charAt(0)).filter(Boolean).join('').toUpperCase().slice(0, 3);
  return letters || fallback;
}

function isVerificationEntry(value: unknown): value is VerificationInput {
  const entry = metadataOf(value);
  return typeof entry.findingKey === 'string' && (entry.status === 'verified' || entry.status === 'still_open');
}

async function agentNames(ids: string[]): Promise<(id: string) => string> {
  const rows = ids.length > 0 ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids)) : [];
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return (id: string) => byId.get(id) ?? id;
}

async function roundSlots(round: Pick<ReviewRoundRow, 'id' | 'cardId'>): Promise<CardCommentRow[]> {
  return db.select().from(cardComments).where(and(
    eq(cardComments.cardId, round.cardId),
    eq(cardComments.action, 'review_slot'),
    drizzleSql`${cardComments.metadata}->>'roundId' = ${round.id}`,
  )).orderBy(cardComments.createdAt);
}

function slotReviewerId(slot: CardCommentRow): string {
  return stringOf(metadataOf(slot.metadata).reviewerId) ?? '';
}

async function latestClosedPanelRound(cardId: string): Promise<ReviewRoundRow | null> {
  const [round] = await db.select().from(reviewRounds)
    .where(and(eq(reviewRounds.cardId, cardId), eq(reviewRounds.kind, 'panel'), eq(reviewRounds.status, 'closed')))
    .orderBy(desc(reviewRounds.round), desc(reviewRounds.openedAt)).limit(1);
  return round ?? null;
}

// === Gates =====================================================================

export async function panelRequiredForCard(card: Pick<CardRow, 'companyId' | 'reviewMode' | 'critical'>): Promise<boolean> {
  if (card.reviewMode === 'panel') return true;
  const [company] = await db.select({ panelReviewDefault: companies.panelReviewDefault }).from(companies).where(eq(companies.id, card.companyId)).limit(1);
  return panelRequired(card, company?.panelReviewDefault ?? null);
}

export async function hasOpenReviewRound(cardId: string): Promise<boolean> {
  const [row] = await db.select({ id: reviewRounds.id }).from(reviewRounds).where(and(eq(reviewRounds.cardId, cardId), eq(reviewRounds.status, 'open'))).limit(1);
  return Boolean(row);
}

// Cards the dispatch cron must not hand to the single review path: an open
// panel or verify round is reviewing them, or a human gate holds them.
export async function cardIdsAwaitingPanelOrHuman(cardIds: string[]): Promise<Set<string>> {
  const gated = new Set<string>();
  if (cardIds.length === 0) return gated;
  const openRounds = await db.select({ cardId: reviewRounds.cardId }).from(reviewRounds).where(and(inArray(reviewRounds.cardId, cardIds), eq(reviewRounds.status, 'open')));
  for (const row of openRounds) gated.add(row.cardId);
  const gates = await db.select({ cardId: approvals.cardId }).from(approvals).where(and(
    inArray(approvals.cardId, cardIds),
    eq(approvals.status, 'pending'),
    eq(approvals.type, 'task_review'),
    drizzleSql`${approvals.payload}->>'humanGate' = 'true'`,
  ));
  for (const row of gates) if (row.cardId) gated.add(row.cardId);
  return gated;
}

// Human approval is the last gate (§17.6): a pending task_review approval
// flagged humanGate parks the card until PUT /api/approvals/:id decides.
export async function ensureHumanGate(card: CardRow, agentId: string | null, reason: string, extra: Record<string, unknown> = {}) {
  const afterCommit: Array<() => void | Promise<void>> = [];
  const result = await db.transaction(async (tx) => {
    // The same card lock is used by completion writers. Once this commits,
    // a delayed result must observe the durable human decision boundary.
    const [fresh] = await tx.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).for('update').limit(1);
    if (!fresh || fresh.deletedAt || ['done', 'cancelled'].includes(fresh.columnStatus ?? '')) return null;
    const approval = await createPendingApproval(fresh, agentId, reason, { executor: tx, afterCommit });
    if (!approval) return null;
    const payload = metadataOf(approval.payload);
    const alreadyGated = payload[HUMAN_GATE_FLAG] === true;
    if (!alreadyGated || payload.reason !== reason) await tx.update(approvals).set({ payload: { ...payload, reason, ...extra, [HUMAN_GATE_FLAG]: true }, updatedAt: new Date() }).where(eq(approvals.id, approval.id));
    return { approval, alreadyGated };
  });
  if (!result) return null;
  for (const effect of afterCommit) await effect();
  const { approval, alreadyGated } = result;
  if (!alreadyGated) {
    await notify({ companyId: card.companyId, type: 'approval_pending', title: `Your decision is needed: ${card.title}`, body: reason, entityType: 'approval', entityId: approval.id, cardId: card.id, agentId });
  }
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review.human_gate' });
  return approval;
}

// === Panel composition =========================================================

async function composePanelForCard(card: Pick<CardRow, 'companyId' | 'assigneeId'>, preferIds: string[]) {
  const [agentRows, positionRows, departmentRows] = await Promise.all([
    db.select({ id: agents.id, name: agents.name, isActive: agents.isActive, departmentId: agents.departmentId, bossId: agents.bossId, positionId: agents.positionId, runtimeId: agents.runtimeId, adapterType: agents.adapterType })
      .from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt))).orderBy(agents.name, agents.id),
    db.select({ id: positions.id, reviewDomain: positions.reviewDomain, isCompanyBoss: positions.isCompanyBoss }).from(positions).where(eq(positions.companyId, card.companyId)),
    db.select({ id: departments.id, headAgentId: departments.headAgentId }).from(departments).where(eq(departments.companyId, card.companyId)),
  ]);
  // A reviewer whose runtime is down would only sit the round out; count them
  // as unavailable so the seat goes to someone who can answer.
  const cache = createRuntimeAvailabilityCache();
  const candidates = await Promise.all(agentRows.map(async (agent) => ({
    ...agent,
    isActive: agent.isActive !== false && agent.id !== card.assigneeId
      ? await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: agent.runtimeId, adapterType: agent.adapterType ?? 'hermes-ssh' }, cache)
      : agent.isActive,
  })));
  const author = agentRows.find((agent) => agent.id === card.assigneeId);
  const cardDomain = author?.positionId ? positionRows.find((position) => position.id === author.positionId)?.reviewDomain ?? null : null;
  const composition = composeReviewPanel({ authorId: card.assigneeId, explicitReviewerIds: preferIds, agents: candidates, positions: positionRows, departments: departmentRows, cardDomain });
  const nameOf = (id: string) => agentRows.find((agent) => agent.id === id)?.name ?? id;
  return { ...composition, nameOf };
}

// Findings of the latest panel round the author has answered and nobody has
// verified yet: the scope of the next verify round.
async function findingsAwaitingVerification(panelRound: ReviewRoundRow | null): Promise<FindingRow[]> {
  if (!panelRound) return [];
  const rows = await db.select().from(reviewFindings).where(and(
    eq(reviewFindings.roundId, panelRound.id),
    drizzleSql`${reviewFindings.disposition} IS NOT NULL`,
    isNull(reviewFindings.verification),
  )).orderBy(reviewFindings.createdAt);
  return sortFindings(rows.map(findingFromRow));
}

// No eligible reviewer (or nobody answered): a critical or client-reviewed
// card waits for a human; anything else takes the single review path.
async function routeUnavailable(card: CardRow, kind: RoundKind, reason: string): Promise<'human_gate' | 'single_fallback'> {
  if (card.critical || card.requiresApproval || await panelRequiredForCard(card)) {
    const gateReason = `Blind ${kind} review unavailable (${reason}); independent review is required. Add an eligible reviewer or request an explicit client decision; this cannot be labelled independent QA.`;
    await ensureHumanGate(card, card.assigneeId, gateReason, { kind: 'review_unavailable' });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_unavailable', body: gateReason, metadata: { kind, humanGate: true } });
    await addTaskLog({ cardId: card.id, agentId: card.assigneeId, type: 'review', status: 'warning', message: gateReason });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: card.assigneeId, action: 'review_round.unavailable', entityType: 'card', entityId: card.id, details: { kind, reason, humanGate: true } });
    return 'human_gate';
  }
  const fallbackReason = `Blind ${kind} review unavailable (${reason}); falling back to the single review path.`;
  await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_unavailable', body: fallbackReason, metadata: { kind, humanGate: false } });
  await addTaskLog({ cardId: card.id, agentId: card.assigneeId, type: 'review', status: 'warning', message: fallbackReason });
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: card.assigneeId, action: 'review_round.unavailable', entityType: 'card', entityId: card.id, details: { kind, reason, humanGate: false } });
  await enqueueTaskRun(card.id, 'review', 'queue');
  return 'single_fallback';
}

// === Opening a round ===========================================================

export async function openPanelRound(card: CardRow, options: { kind: RoundKind }): Promise<OpenRoundResult> {
  const kind = options.kind;
  const [existing] = await db.select().from(reviewRounds).where(and(eq(reviewRounds.cardId, card.id), eq(reviewRounds.status, 'open'))).limit(1);
  if (existing) return { outcome: 'already_open', roundId: existing.id, reviewerIds: existing.reviewerIds };
  const panelRound = kind === 'verify' ? await latestClosedPanelRound(card.id) : null;
  const scope = kind === 'verify' ? await findingsAwaitingVerification(panelRound) : [];
  if (kind === 'verify' && (!panelRound || scope.length === 0)) {
    await enqueueTaskRun(card.id, 'review', 'queue');
    return { outcome: 'single_fallback', roundId: null, reviewerIds: [] };
  }
  // The verify round keeps the panel that raised the findings; a fresh panel
  // starts from the reviewers named on the card.
  const preferred = kind === 'verify'
    ? [...(panelRound?.reviewerIds ?? []), ...card.reviewerIds]
    : [...card.reviewerIds, ...(card.reviewerId ? [card.reviewerId] : [])];
  const panel = await composePanelForCard(card, preferred);
  const roundNumber = kind === 'panel' ? (card.reviewRound ?? 0) + 1 : panelRound?.round ?? Math.max(1, card.reviewRound ?? 0);
  if (panel.reviewerIds.length === 0) {
    const outcome = await routeUnavailable(card, kind, panel.reason);
    return { outcome, roundId: null, reviewerIds: [] };
  }
  const timeoutAt = new Date(Date.now() + PANEL_REVIEW_TIMEOUT_MINUTES * 60_000);
  const [round] = await db.insert(reviewRounds).values({
    companyId: card.companyId,
    cardId: card.id,
    round: roundNumber,
    kind,
    level: card.fixLevel ?? 0,
    authorAgentId: card.assigneeId,
    reviewerIds: panel.reviewerIds,
    status: 'open',
    timeoutAt,
    metadata: { panel_degraded: panel.degraded, composition: panel.reason, panelRoundId: panelRound?.id ?? null, findingKeys: scope.map((finding) => finding.key), verdicts: {}, verifications: {} },
  }).returning();
  if (!round) throw new Error('review_round_create_failed');
  await db.update(kanbanCards).set({ reviewRound: roundNumber, reviewerIds: panel.reviewerIds, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
  for (const reviewerId of panel.reviewerIds) {
    const slot = await addCardMessage({
      cardId: card.id,
      authorType: 'system',
      action: 'review_slot',
      body: `Sealed ${kind} review slot for ${panel.nameOf(reviewerId)} (round ${roundNumber}). Findings are stored apart from the conversation and revealed when the round closes.`,
      metadata: { sealed: true, roundId: round.id, reviewerId, round: roundNumber, kind },
    });
    if (slot) await enqueuePanelReviewRun(card, slot, reviewerId);
  }
  const names = panel.reviewerIds.map(panel.nameOf);
  const opened = [
    `Blind ${kind} review round ${roundNumber} opened with ${names.length} reviewer(s): ${names.join(', ')}.${panel.degraded ? ' panel_degraded: only one eligible reviewer, so this round is single-blind.' : ''}`,
    kind === 'verify' ? `They verify the ${scope.length} disposition(s) the author gave to the findings of round ${roundNumber}.` : 'Each reviewer files findings independently; nothing is revealed until every slot is in or the round times out.',
    `Timeout: ${PANEL_REVIEW_TIMEOUT_MINUTES} minutes.`,
  ].join(' ');
  await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_round_opened', body: opened, metadata: { roundId: round.id, round: roundNumber, kind, reviewerIds: panel.reviewerIds, panel_degraded: panel.degraded } });
  await addTaskLog({ cardId: card.id, agentId: card.assigneeId, type: 'review', status: 'queued', message: opened });
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: card.assigneeId, action: 'review_round.opened', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: roundNumber, kind, reviewerIds: panel.reviewerIds, panelDegraded: panel.degraded } });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review_round.opened' });
  return { outcome: panel.degraded ? 'degraded' : 'opened', roundId: round.id, reviewerIds: panel.reviewerIds };
}

// === The reviewer's slot =======================================================

export async function buildPanelReviewPrompt(card: CardRow, round: ReviewRoundRow, reviewer: AgentRow, options: { continuation?: boolean; since?: Date | null; lastError?: string | null } = {}): Promise<string> {
  const seats = round.reviewerIds.length;
  const rejected = options.lastError ? `Your previous reply on this slot was rejected: ${clipText(options.lastError, 600)}. Send a corrected structured report.` : '';
  if (round.kind === 'verify') {
    const meta = metadataOf(round.metadata);
    const panelRoundId = stringOf(meta.panelRoundId);
    const keys = stringList(meta.findingKeys);
    const rows = panelRoundId && keys.length > 0
      ? await db.select().from(reviewFindings).where(and(eq(reviewFindings.roundId, panelRoundId), inArray(reviewFindings.findingKey, keys))).orderBy(reviewFindings.createdAt)
      : [];
    const findings = sortFindings(rows.map(findingFromRow));
    const products = await db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt)).limit(20);
    return [
      await buildCommonCompanyContext(card.companyId, reviewer.id, card.tags ?? []),
      options.continuation
        ? `Continue this existing blind review session: verification round ${round.round} for card ${card.id}: ${card.title}.`
        : `Blind verification round ${round.round} for card ${card.id}: ${card.title}.`,
      `You are one of ${seats} independent verifiers. Do not look for or reference the conclusions of the other verifier: you cannot see theirs and they cannot see yours until the round closes. The author has answered each finding of the blind review with a disposition (adopted | rejected | merged) and evidence; check whether every adopted finding is really fixed and whether each rejection or merge holds. Inspect the repository or the work products yourself; do not take the evidence text on faith.`,
      `Acceptance criteria (from the card brief):\n${acceptanceOf(card.body) ?? 'none stated - judge against the body'}`,
      `Card body:\n${clipText(card.body, 6000)}`,
      `Latest execution output (the fix report of the author):\n${clipText(card.executionLog, 6000) || 'none'}`,
      `Work products:\n${products.map((product) => `- ${product.type}: ${product.title}${product.url ? ` (${product.url})` : product.pullRequestUrl ? ` (${product.pullRequestUrl})` : ''}${product.commitSha ? ` commit ${product.commitSha}` : ''}`).join('\n') || 'none'}`,
      formatVerifyInstructions(findings),
      REVIEWER_PLAYBOOK,
      REVIEW_SCORE_RUBRIC,
      'Return exactly one JSON megacorps-report (kind "megacorps-report", status "completed") with "verifications", "verdict" and "score". Do not post findings to the message board and do not call any webhook other than the one for this task run.',
      rejected,
    ].filter(Boolean).join('\n\n');
  }
  const base = await buildReviewPrompt({ ...card, reviewerId: reviewer.id }, { continuation: options.continuation, since: options.since, kind: 'review' });
  return [
    base,
    '=== Blind review panel ===',
    `You are one of ${seats} blind reviewers of this card (round ${round.round}). Do not look for or reference the findings of other reviewers: you cannot see theirs and they cannot see yours until the round closes, and nothing you write here reaches the message board.`,
    'Persist exactly one findings set in your structured megacorps-report: "findings": [{ "id": "F1", "severity": "P0" | "P1" | "P2", "file": "path", "line": 42, "title": "...", "evidence": "...", "requiredFix": "...", "reassign": false }], plus "verdict" (approved | revision_requested | escalate) and "score" (0-10). P0 = must fix before this can ship (data loss, security, broken acceptance); P1 = must fix before approval; P2 = should fix, does not block approval. Set "reassign": true on a P0 only when you believe the author cannot fix it and a more senior colleague should take the card over. A revision_requested or escalate verdict without findings is returned to you as malformed. Judge against the Acceptance criteria listed above.',
    rejected,
  ].filter(Boolean).join('\n\n');
}

type SlotSubmission = {
  card: CardRow;
  round: ReviewRoundRow;
  slot: CardCommentRow;
  reviewer: AgentRow;
  taskRun: TaskRunRow;
  heartbeatRunId: string | null;
  output: string | null;
  report: AgentReport | null;
  verdict: ReviewVerdict | null;
  costUsd?: number;
  durationSeconds?: number;
};

async function finishSlotRun(input: SlotSubmission, status: 'success' | 'cancelled', output: string): Promise<void> {
  if (input.heartbeatRunId) {
    await db.update(heartbeatRuns).set({
      status,
      completedAt: new Date(),
      error: null,
      durationSeconds: input.durationSeconds,
      costUsd: input.costUsd === undefined ? undefined : input.costUsd.toString(),
    }).where(and(eq(heartbeatRuns.id, input.heartbeatRunId), eq(heartbeatRuns.status, 'running')));
  }
  await completeTaskRun(input.taskRun.id, { status, output, costUsd: input.costUsd, durationSeconds: input.durationSeconds });
}

// Stores one reviewer's answer. Findings go to review_findings and verdicts
// and verifications to the round metadata; the only public traces are "slot
// submitted" lines that name the reviewer and nothing else.
async function submitSlot(input: SlotSubmission): Promise<{ ok: true } | { ok: false; error: string }> {
  const { card, round, slot, reviewer } = input;
  if (!input.verdict) return { ok: false, error: VERDICT_MISSING };
  const findings = input.report?.findings ?? [];
  const verifications = input.report?.verifications ?? [];
  if (round.kind === 'panel' && input.verdict !== 'approved' && findings.length === 0) {
    return { ok: false, error: 'panel_findings_missing: a revision_requested or escalate verdict on a blind panel must come with "findings": [{ severity, title, evidence, requiredFix, file?, line?, reassign? }] in your megacorps-report; each finding is what the author fixes.' };
  }
  if (round.kind === 'verify' && verifications.length === 0) {
    return { ok: false, error: 'verifications_missing: a verify round needs "verifications": [{ findingKey, status: verified | still_open, note? }] covering every finding key listed in the prompt.' };
  }
  const [current] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, round.id)).limit(1);
  if (!current || current.status !== 'open') {
    await finishSlotRun(input, 'cancelled', 'Blind review slot answered after the round closed; the answer was not counted.');
    return { ok: true };
  }
  const reviewerIndex = Math.max(0, current.reviewerIds.indexOf(reviewer.id));
  const prefix = `R${current.round}-${initialsOf(reviewer.name, 'RV')}${reviewerIndex + 1}`;
  if (current.kind === 'panel') {
    // A retried slot replaces its own earlier rows, never another reviewer's.
    await db.delete(reviewFindings).where(and(eq(reviewFindings.roundId, current.id), eq(reviewFindings.reviewerAgentId, reviewer.id)));
    if (findings.length > 0) {
      await db.insert(reviewFindings).values(findings.map((finding, index) => ({
        companyId: card.companyId,
        cardId: card.id,
        roundId: current.id,
        round: current.round,
        reviewerAgentId: reviewer.id,
        findingKey: `${prefix}-${index + 1}`,
        severity: normalizeSeverity(finding.severity),
        file: finding.file?.trim() || null,
        line: finding.line ?? null,
        title: finding.title,
        evidence: finding.evidence,
        requiredFix: finding.requiredFix,
        reassign: Boolean(finding.reassign),
      })));
    }
  }
  const meta = metadataOf(current.metadata);
  const verdicts = { ...metadataOf(meta.verdicts), [reviewer.id]: input.verdict };
  const perReviewer = {
    ...metadataOf(meta.verifications),
    [reviewer.id]: verifications.map((item) => ({ findingKey: normalizeFindingKey(item.findingKey), status: item.status, note: item.note?.trim() || null })),
  };
  await db.update(reviewRounds).set({ metadata: { ...meta, verdicts, verifications: perReviewer } }).where(eq(reviewRounds.id, current.id));
  try { await recordReviewScore(card, reviewer, input.verdict, input.output, input.report?.score ?? null); } catch { /* scoring must never fail a review */ }
  await db.update(cardComments).set({ metadata: { ...metadataOf(slot.metadata), done: true, submittedAt: new Date().toISOString(), lastError: null } }).where(eq(cardComments.id, slot.id));
  await finishSlotRun(input, 'success', input.output ?? 'Blind review slot submitted.');
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'success', message: `Blind ${current.kind} review slot submitted by ${reviewer.name} (round ${current.round}).`, costUsd: input.costUsd, durationSeconds: input.durationSeconds });
  await addActivity({ companyId: card.companyId, actorType: 'agent', actorId: reviewer.id, agentId: reviewer.id, action: 'review_slot.submitted', entityType: 'card', entityId: card.id, details: { roundId: current.id, round: current.round, kind: current.kind } });
  await tryCloseRound(current.id, { closedBy: 'slots' });
  return { ok: true };
}

// A rejected or failed slot answer: retry the same slot while attempts remain,
// otherwise the round proceeds without this reviewer. The error detail stays
// on the slot metadata (for the reviewer's next prompt), never in a log the
// other reviewer's prompt could carry.
async function requeueSlot(input: { card: CardRow; round: ReviewRoundRow; slot: CardCommentRow; reviewer: AgentRow; taskRun: TaskRunRow; heartbeatRunId: string | null; output: string | null; error: string; costUsd?: number; durationSeconds?: number }): Promise<void> {
  const { card, round, slot, reviewer, taskRun } = input;
  if (input.heartbeatRunId) {
    await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: errorCode(input.error), durationSeconds: input.durationSeconds })
      .where(and(eq(heartbeatRuns.id, input.heartbeatRunId), eq(heartbeatRuns.status, 'running')));
  }
  await completeTaskRun(taskRun.id, { status: 'failed', error: input.error, output: input.output, costUsd: input.costUsd, durationSeconds: input.durationSeconds });
  const attempt = Math.max(1, taskRun.attemptNumber ?? 1);
  const maxAttempts = Math.max(1, taskRun.maxAttempts ?? 3);
  const retry = attempt < maxAttempts;
  await db.update(cardComments).set({
    metadata: { ...metadataOf(slot.metadata), lastError: clipText(input.error, 1500), attempts: attempt, ...(retry ? {} : { done: true, failed: true }) },
  }).where(eq(cardComments.id, slot.id));
  await addTaskLog({
    cardId: card.id,
    agentId: reviewer.id,
    type: 'review',
    status: 'warning',
    message: retry
      ? `Blind ${round.kind} review slot of ${reviewer.name} was not accepted (${errorCode(input.error)}); retry ${attempt + 1}/${maxAttempts} queued.`
      : `Blind ${round.kind} review slot of ${reviewer.name} failed after ${attempt} attempt(s) (${errorCode(input.error)}); the round proceeds without it.`,
  });
  if (retry) {
    await enqueuePanelReviewRun(card, slot, reviewer.id, attempt + 1);
    return;
  }
  await tryCloseRound(round.id, { closedBy: 'slots' });
}

export async function reviewPanelSlot(cardId: string, options: { taskRunId?: string | null } = {}): Promise<CardRow> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  const [taskRun] = options.taskRunId ? await db.select().from(taskRuns).where(eq(taskRuns.id, options.taskRunId)).limit(1) : [];
  if (!taskRun || taskRun.kind !== 'panel_review' || !taskRun.messageCommentId) throw new Error('panel_review_task_run_not_found');
  const [slot] = await db.select().from(cardComments).where(and(eq(cardComments.id, taskRun.messageCommentId), eq(cardComments.cardId, card.id))).limit(1);
  if (!slot) throw new Error('panel_review_slot_not_found');
  const slotMeta = metadataOf(slot.metadata);
  const roundId = stringOf(slotMeta.roundId);
  const [round] = roundId ? await db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId)).limit(1) : [];
  if (!round) throw new Error('review_round_not_found');
  if (round.status !== 'open' || slotMeta.done === true || card.columnStatus !== 'in_review') {
    const stale = round.status !== 'open' || card.columnStatus !== 'in_review';
    const note = round.status !== 'open'
      ? 'Blind review slot skipped; the round is already closed.'
      : slotMeta.done === true
        ? 'Blind review slot already submitted.'
        : `Blind review slot skipped; the card is ${card.columnStatus ?? 'todo'}, not in review.`;
    await completeTaskRun(taskRun.id, { status: stale ? 'cancelled' : 'success', output: note });
    return card;
  }
  const reviewerId = taskRun.agentId ?? stringOf(slotMeta.reviewerId);
  const [reviewer] = reviewerId ? await db.select().from(agents).where(and(eq(agents.id, reviewerId), isNull(agents.deletedAt))).limit(1) : [];
  if (!reviewer) throw new Error('reviewer_not_found');
  if (!reviewer.isActive) throw new Error('agent_paused');
  if (reviewer.isBusy) throw new Error('reviewer_busy');
  if (!(await agentRuntimeAvailable({ companyId: card.companyId, runtimeId: reviewer.runtimeId, adapterType: reviewer.adapterType ?? 'hermes-ssh' }))) throw new Error('reviewer_runtime_unavailable');
  if (!(await budgetOk(reviewer))) {
    await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, reviewer.id));
    throw new Error('agent_budget_exceeded');
  }
  if (!(await claimAgentCapacity(reviewer))) throw new Error('reviewer_busy');
  const run = await openHeartbeatRun(card, reviewer, 'panel_review', taskRun.id);
  await addTaskLog({ cardId: card.id, agentId: reviewer.id, type: 'review', status: 'running', message: `Blind ${round.kind} review slot started by ${reviewer.name} (round ${round.round}).` });
  try {
    const adapter = getAdapter(reviewer.adapterType ?? 'hermes-ssh');
    const adapterSession = await scopedAdapterSession(card, reviewer, 'panel_review');
    const adapterSessionId = adapterSession?.adapterSessionId ?? null;
    const executionAgent = await buildExecutionAgent(reviewer, adapterSessionId);
    const prompt = await buildPanelReviewPrompt(card, round, reviewer, { continuation: Boolean(adapterSessionId), since: adapterSession?.updatedAt ?? null, lastError: stringOf(slotMeta.lastError) });
    const task = { id: card.id, title: `Blind ${round.kind} review: ${card.title}`, body: prompt, timeoutSeconds: await cardTaskTimeoutSeconds(card, { agent: reviewer, kind: 'panel_review' }), taskRunId: taskRun.id };
    await recordPromptLog({
      companyId: card.companyId,
      agentId: reviewer.id,
      cardId: card.id,
      projectId: card.projectId,
      goalId: card.goalId,
      heartbeatRunId: run.id,
      taskRunId: taskRun.id,
      source: 'panel_review',
      adapterType: reviewer.adapterType ?? 'hermes-ssh',
      title: task.title,
      prompt: promptSnapshotForAdapter(executionAgent, task),
      metadata: { adapterSessionId, roundId: round.id, round: round.round, kind: round.kind, megacorpsPromptChars: prompt.length, contextMode: adapterSessionId ? 'adapter_session_delta' : 'full_bootstrap' },
    });
    const result = await adapter.dispatch(executionAgent, task);
    const [latestRun] = await db.select().from(taskRuns).where(eq(taskRuns.id, taskRun.id)).limit(1);
    if (latestRun && latestRun.status !== 'running') {
      // The webhook answered this slot (or the round closed) while the adapter ran.
      if (result.success) await rememberTaskAdapterSession(card, reviewer, 'panel_review', result, taskRun.id);
      await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, reviewer.id));
      await db.update(heartbeatRuns).set({ status: 'success', completedAt: new Date(), durationSeconds: result.durationSeconds }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, 'running')));
      return card;
    }
    await recordCostAndEnforceBudget(card, reviewer, run.id, result.costUsd, result.tokensUsed, result.durationSeconds);
    if (result.success) await rememberTaskAdapterSession(card, reviewer, 'panel_review', result, taskRun.id);
    await db.update(agents).set({ currentSessionId: result.sessionId, isBusy: false }).where(eq(agents.id, reviewer.id));
    const normalized = normalizeAgentResult({ output: result.output, needsInput: result.needsInput });
    if (normalized.outcome !== 'completed') {
      await requeueSlot({ card, round, slot, reviewer, taskRun, heartbeatRunId: run.id, output: result.output,
        error: normalized.reason ?? `panel_review_not_complete: reported ${normalized.outcome}; finish the review before submitting its verdict.`, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
      return card;
    }
    const report = normalized.report;
    const verdict = normalized.verdict;
    if (!result.success && !verdict) throw new Error(dispatchInternals.adapterFailureMessage('review', result.output));
    const submitted = await submitSlot({ card, round, slot, reviewer, taskRun, heartbeatRunId: run.id, output: result.output, report, verdict, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    if (!submitted.ok) {
      await requeueSlot({ card, round, slot, reviewer, taskRun, heartbeatRunId: run.id, output: result.output, error: submitted.error, costUsd: result.costUsd, durationSeconds: result.durationSeconds });
    }
    return card;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'panel_review_failed';
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, reviewer.id));
    await requeueSlot({ card, round, slot, reviewer, taskRun, heartbeatRunId: run.id, output: null, error: message });
    return card;
  }
}

// A reviewer answering a panel_review run through the task-complete webhook:
// same slot logic as the adapter path. A malformed answer throws and the run
// stays running so the reviewer can resend.
export async function completePanelReviewFromWebhook(taskRunId: string, input: {
  status: CardStatus;
  summary?: string | null;
  output?: string | null;
  costUsd?: number;
  report?: AgentReport | null;
}): Promise<{ ok: true; cardId: string; taskRunId: string; kind: string; newStatus: string; roundId: string | null }> {
  const [taskRun] = await db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
  if (!taskRun || taskRun.kind !== 'panel_review' || !taskRun.messageCommentId) throw new Error('panel_review_task_run_not_found');
  if (!['queued', 'running'].includes(taskRun.status)) return { ok: true, cardId: taskRun.cardId, taskRunId, kind: taskRun.kind, newStatus: taskRun.status, roundId: null };
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, taskRun.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  const [slot] = await db.select().from(cardComments).where(and(eq(cardComments.id, taskRun.messageCommentId), eq(cardComments.cardId, card.id))).limit(1);
  if (!slot) throw new Error('panel_review_slot_not_found');
  const roundId = stringOf(metadataOf(slot.metadata).roundId);
  const [round] = roundId ? await db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId)).limit(1) : [];
  if (!round) throw new Error('review_round_not_found');
  const [reviewer] = taskRun.agentId ? await db.select().from(agents).where(and(eq(agents.id, taskRun.agentId), isNull(agents.deletedAt))).limit(1) : [];
  if (!reviewer) throw new Error('reviewer_not_found');
  const output = [input.summary, input.output].filter(Boolean).join('\n\n') || null;
  const normalized = normalizeAgentResult({ output, report: input.report ?? undefined });
  if (normalized.outcome !== 'completed') throw new Error(normalized.reason ?? `panel_review_not_complete: reported ${normalized.outcome}; finish the review before submitting its verdict.`);
  if (!['done', 'in_review'].includes(input.status)) throw new Error(`panel_review_not_complete: callback status is ${input.status}.`);
  const report = normalized.report;
  // Preserve status-only legacy callbacks, but never let their fallback repair
  // a malformed/unfinished report or conflicting explicit verdicts.
  const verdict = normalized.verdict ?? (normalized.source === 'prose' && !normalized.verdictError ? 'approved' : null);
  const submitted = await submitSlot({ card, round, slot, reviewer, taskRun, heartbeatRunId: taskRun.heartbeatRunId, output, report, verdict, costUsd: input.costUsd });
  if (!submitted.ok) throw new Error(submitted.error);
  await db.update(agents).set({ isBusy: false }).where(eq(agents.id, reviewer.id));
  return { ok: true, cardId: card.id, taskRunId, kind: taskRun.kind, newStatus: 'submitted', roundId: round.id };
}

// === Closing a round ===========================================================

async function finalizeRound(round: ReviewRoundRow, card: CardRow, decision: RoundOutcome, message: string, metadata: Record<string, unknown>): Promise<void> {
  await db.update(reviewRounds).set({ decision, summary: clipText(message, 8000), metadata }).where(eq(reviewRounds.id, round.id));
  await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_round_closed', body: message, metadata: { roundId: round.id, round: round.round, kind: round.kind, decision } });
  await recordCardAction({
    companyId: card.companyId,
    cardId: card.id,
    actor: { type: 'system', id: 'review-panel' },
    action: 'review_round.closed',
    fromStatus: card.columnStatus,
    toStatus: card.columnStatus,
    detail: `Blind ${round.kind} review round ${round.round} closed: ${decision}.`,
    metadata: { roundId: round.id, round: round.round, kind: round.kind, decision },
  });
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: round.authorAgentId, action: 'review_round.closed', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round, kind: round.kind, decision } });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review_round.closed' });
}

type CloseContext = { answeredBy: string[]; absentIds: string[]; nameOf: (id: string) => string; closedBy: string };

async function closePanelRound(round: ReviewRoundRow, card: CardRow, ctx: CloseContext): Promise<void> {
  const rows = await db.select().from(reviewFindings).where(eq(reviewFindings.roundId, round.id)).orderBy(reviewFindings.createdAt);
  const merged = mergeFindings(rows.map(findingFromRow));
  for (const finding of merged) {
    if (finding.mergedKeys.length === 0) continue;
    await db.update(reviewFindings).set({
      disposition: 'merged',
      mergedInto: finding.key,
      dispositionReason: `duplicate of ${finding.key} (${SYSTEM_MERGE_NOTE})`,
      verification: 'verified',
      verificationNote: SYSTEM_MERGE_NOTE,
      updatedAt: new Date(),
    }).where(and(eq(reviewFindings.roundId, round.id), inArray(reviewFindings.findingKey, finding.mergedKeys)));
  }
  const meta = metadataOf(round.metadata);
  const verdictMap = metadataOf(meta.verdicts);
  const verdicts = ctx.answeredBy.map((id) => verdictMap[id]).filter((value): value is ReviewVerdict => value === 'approved' || value === 'revision_requested' || value === 'escalate');
  const decision: RoundOutcome = ctx.answeredBy.length === 0 ? 'unavailable' : roundDecision({ findings: merged, verdicts });
  const message = formatRoundClosedMessage({
    round: round.round,
    kind: 'panel',
    decision,
    reviewerNames: round.reviewerIds.map(ctx.nameOf),
    absentNames: ctx.absentIds.map(ctx.nameOf),
    degraded: meta.panel_degraded === true,
  }, merged);
  await finalizeRound(round, card, decision, message, { ...meta, absent: ctx.absentIds, closedBy: ctx.closedBy, findingCount: rows.length, mergedCount: merged.length, openKeys: decision === 'revision_requested' ? merged.map((finding) => finding.key) : [] });
  await applyRoundDecision(card, round, decision, merged, message);
}

async function closeVerifyRound(round: ReviewRoundRow, card: CardRow, ctx: CloseContext): Promise<void> {
  const meta = metadataOf(round.metadata);
  const panelRoundId = stringOf(meta.panelRoundId);
  const keys = stringList(meta.findingKeys);
  const rows = panelRoundId && keys.length > 0
    ? await db.select().from(reviewFindings).where(and(eq(reviewFindings.roundId, panelRoundId), inArray(reviewFindings.findingKey, keys))).orderBy(reviewFindings.createdAt)
    : [];
  const findings = sortFindings(rows.map(findingFromRow));
  const perReviewer = metadataOf(meta.verifications);
  const flattened = ctx.answeredBy.flatMap((id) => {
    const list = perReviewer[id];
    return Array.isArray(list) ? list.filter(isVerificationEntry) : [];
  });
  const verification = verificationDecision(findings, flattened);
  const decision: RoundOutcome = ctx.answeredBy.length === 0 ? 'unavailable' : verification.decision;
  if (decision !== 'unavailable') {
    for (const row of rows) {
      const wanted = normalizeFindingKey(row.findingKey);
      const entries = flattened.filter((entry) => normalizeFindingKey(entry.findingKey) === wanted);
      const open = verification.openKeys.includes(row.findingKey);
      const notes = entries.map((entry) => entry.note?.trim()).filter(Boolean).join(' | ');
      await db.update(reviewFindings).set({
        verification: open ? 'still_open' : 'verified',
        verificationNote: notes || (open && entries.length === 0 ? 'not verified by the panel' : null),
        updatedAt: new Date(),
      }).where(eq(reviewFindings.id, row.id));
    }
  }
  const refreshed = rows.length > 0 ? sortFindings((await db.select().from(reviewFindings).where(inArray(reviewFindings.id, rows.map((row) => row.id)))).map(findingFromRow)) : [];
  const message = formatRoundClosedMessage({
    round: round.round,
    kind: 'verify',
    decision,
    reviewerNames: round.reviewerIds.map(ctx.nameOf),
    absentNames: ctx.absentIds.map(ctx.nameOf),
    degraded: meta.panel_degraded === true,
    openKeys: verification.openKeys,
  }, refreshed);
  await finalizeRound(round, card, decision, message, { ...meta, absent: ctx.absentIds, closedBy: ctx.closedBy, openKeys: verification.openKeys });
  // Reassign flags live on the panel round's findings, so the takeover check
  // reads those rather than the verify scope.
  const panelRows = panelRoundId ? await db.select().from(reviewFindings).where(eq(reviewFindings.roundId, panelRoundId)) : [];
  await applyRoundDecision(card, round, decision, mergeFindings(panelRows.map(findingFromRow)), message);
}

// Called after every slot answer and by the cron sweep: closes the round when
// every slot is in or the timeout passed, then applies the decision.
export async function tryCloseRound(roundId: string, options: { force?: boolean; closedBy?: string } = {}): Promise<boolean> {
  const [round] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId)).limit(1);
  if (!round || round.status !== 'open') return false;
  const slots = await roundSlots(round);
  const done = slots.filter((slot) => metadataOf(slot.metadata).done === true);
  const timedOut = Boolean(round.timeoutAt && round.timeoutAt.getTime() <= Date.now());
  if (!options.force && !timedOut && done.length < slots.length) return false;
  const [claimed] = await db.update(reviewRounds).set({ status: 'closed', closedAt: new Date() })
    .where(and(eq(reviewRounds.id, round.id), eq(reviewRounds.status, 'open'))).returning();
  if (!claimed) return false;
  const absentSlots = slots.filter((slot) => metadataOf(slot.metadata).done !== true);
  if (absentSlots.length > 0) {
    await db.update(taskRuns).set({ status: 'cancelled', completedAt: new Date(), lockedBy: null, lockedAt: null, error: 'review_round_closed', updatedAt: new Date() })
      .where(and(inArray(taskRuns.messageCommentId, absentSlots.map((slot) => slot.id)), eq(taskRuns.kind, 'panel_review'), inArray(taskRuns.status, ['queued', 'running'])));
  }
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, round.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) return true;
  const answeredBy = done.map(slotReviewerId).filter(Boolean);
  const absentIds = absentSlots.map(slotReviewerId).filter(Boolean);
  const nameOf = await agentNames([...claimed.reviewerIds, ...absentIds]);
  const ctx: CloseContext = { answeredBy, absentIds, nameOf, closedBy: options.closedBy ?? (timedOut ? 'timeout' : 'slots') };
  if (claimed.kind === 'verify') await closeVerifyRound(claimed, card, ctx);
  else await closePanelRound(claimed, card, ctx);
  return true;
}

async function applyRoundDecision(card: CardRow, round: ReviewRoundRow, decision: RoundOutcome, findings: MergedFinding[], message: string): Promise<void> {
  const [fresh] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, card.id), isNull(kanbanCards.deletedAt))).limit(1);
  if (!fresh) return;
  if (fresh.columnStatus !== 'in_review') {
    await addTaskLog({ cardId: card.id, agentId: round.authorAgentId, type: 'review', status: 'warning', message: `Blind ${round.kind} review round ${round.round} closed (${decision}) but the card is ${fresh.columnStatus ?? 'todo'}; no stage change applied.` });
    return;
  }
  if (decision === 'unavailable') {
    await routeUnavailable(fresh, round.kind === 'verify' ? 'verify' : 'panel', `no reviewer of round ${round.round} answered before the timeout`);
    return;
  }
  if (decision === 'approved') {
    await approveAfterRound(fresh, round);
    return;
  }
  if (decision === 'revision_requested') await rejectAfterRound(fresh, round, findings, message);
}

// The same tail as a single-review approval: children first, then the human
// gate when the client reviews, otherwise done and cascade.
async function approveAfterRound(card: CardRow, round: ReviewRoundRow): Promise<void> {
  const childBlock = await completionBlockedByChildren(card, 'done');
  if (childBlock) {
    await db.update(kanbanCards).set({ columnStatus: 'in_progress', rollupStatus: 'waiting_on_children', lastError: null, completedAt: null, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
    await addStageLog(card.id, null, card.columnStatus, 'in_progress', 'review');
    await addTaskLog({ cardId: card.id, type: 'children', status: 'queued', message: childBlock.message });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_waiting_on_children', body: childBlock.message });
    await resolvePendingApproval(card, 'cancelled', childBlock.message);
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', action: 'review.waiting_on_children', entityType: 'card', entityId: card.id, details: { roundId: round.id, childBlock } });
    return;
  }
  if (card.requiresApproval) {
    const reason = `Blind review round ${round.round} approved; client approval is the last gate.`;
    await ensureHumanGate(card, round.authorAgentId, reason, { kind: 'client_approval', roundId: round.id });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_awaiting_client', body: reason, metadata: { roundId: round.id } });
    await addTaskLog({ cardId: card.id, agentId: round.authorAgentId, type: 'review', status: 'success', message: reason });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: round.authorAgentId, action: 'review.awaiting_client', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round } });
    return;
  }
  // Merge closure (§19): the panel's approval authorizes one exact head; the
  // card parks on that merge instead of finishing.
  const mergePlan = await planMergeGate(card);
  if (mergePlan.disposition === 'blocked') {
    await applyMergeGatePlan(card, mergePlan);
    return;
  }
  if (mergePlan.disposition === 'wait') {
    if (!(await parkForMerge(card, mergePlan, { approvedBy: round.authorAgentId, fromStatus: card.columnStatus }))) return;
    await addTaskLog({ cardId: card.id, agentId: round.authorAgentId, type: 'review', status: 'success', message: `Blind ${round.kind} review round ${round.round} approved; waiting for head ${mergePlan.headSha} to be merged into ${mergePlan.defaultBranch}.` });
    await resolvePendingApproval(card, 'approved', `Blind review round ${round.round} approved the card.`);
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: round.authorAgentId, action: 'review.approved', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round, kind: round.kind, panel: true, mergeGate: true, authorizedHeadSha: mergePlan.headSha } });
    return;
  }
  await noteMergeEvidenceRequired(card, mergePlan);
  const updated = await guardedCompletionUpdate(card, {
    columnStatus: 'done',
    rollupStatus: 'done',
    lastError: null,
    completedAt: new Date(),
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: new Date(),
  });
  if (!updated) return;
  await addStageLog(card.id, null, card.columnStatus, 'done', 'review');
  await addTaskLog({ cardId: card.id, agentId: round.authorAgentId, type: 'review', status: 'success', message: `Blind ${round.kind} review round ${round.round} approved; card marked done.` });
  await resolvePendingApproval(card, 'approved', `Blind review round ${round.round} approved the card.`);
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: round.authorAgentId, action: 'review.approved', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round, kind: round.kind, panel: true } });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review.approved' });
  if (updated) { await sealDeliveryAcceptance(updated.id); await cascadeParentStatus(updated.parentCardId); }
}

async function rejectAfterRound(card: CardRow, round: ReviewRoundRow, findings: MergedFinding[], message: string): Promise<void> {
  const trigger = takeoverTrigger({ escalation: null, revisionCount: card.revisionCount ?? 0, maxRevisions: card.maxRevisions ?? 3, findings, reviewerIds: round.reviewerIds });
  if (trigger) {
    await takeoverCard(card, round, trigger, message);
    return;
  }
  const feedback = clipText(message, 8000);
  const revisionCount = (card.revisionCount ?? 0) + 1;
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: 'todo',
    revisionCount,
    reviewFeedback: feedback,
    completedAt: null,
    nextRunAt: null,
    lastError: null,
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, card.id)).returning();
  await addStageLog(card.id, card.assigneeId, card.columnStatus, 'todo', 'review');
  await addTaskLog({ cardId: card.id, agentId: card.assigneeId, type: 'review', status: 'warning', message: `Blind ${round.kind} review round ${round.round} requested revision; card returned to the author (revision ${revisionCount}/${card.maxRevisions ?? 3} at fix level ${card.fixLevel ?? 0}).` });
  await resolvePendingApproval(card, 'rejected', feedback);
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: card.assigneeId, action: 'review.revision_requested', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round, kind: round.kind, revisionCount, panel: true } });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review.revision_requested' });
  if (updated) {
    try { await enqueueTaskRun(updated.id, 'dispatch', 'queue'); } catch { /* the dispatch cron picks todo cards up on its own */ }
  }
}

// === Takeover along the boss chain ==============================================

async function openFindingRows(card: Pick<CardRow, 'id'>): Promise<FindingRow[]> {
  const round = await latestClosedPanelRound(card.id);
  if (!round) return [];
  const rows = await db.select().from(reviewFindings).where(eq(reviewFindings.roundId, round.id)).orderBy(reviewFindings.createdAt);
  return sortFindings(rows.map(findingFromRow).filter(findingIsOpen));
}

export async function takeoverCard(card: CardRow, round: ReviewRoundRow, trigger: TakeoverTrigger, summary: string): Promise<CardRow> {
  const authorId = card.assigneeId;
  const [agentRows, departmentRows, positionRows] = await Promise.all([
    db.select({ id: agents.id, name: agents.name, bossId: agents.bossId, isActive: agents.isActive, departmentId: agents.departmentId, positionId: agents.positionId }).from(agents).where(and(eq(agents.companyId, card.companyId), isNull(agents.deletedAt))),
    db.select({ id: departments.id, headAgentId: departments.headAgentId }).from(departments).where(eq(departments.companyId, card.companyId)),
    db.select({ id: positions.id, isCompanyBoss: positions.isCompanyBoss }).from(positions).where(eq(positions.companyId, card.companyId)),
  ]);
  const author = agentRows.find((agent) => agent.id === authorId) ?? null;
  const departmentHeadId = author?.departmentId ? departmentRows.find((department) => department.id === author.departmentId)?.headAgentId ?? null : null;
  const bossPositionIds = new Set(positionRows.filter((position) => position.isCompanyBoss).map((position) => position.id));
  const nextOwnerId = nextFixOwner({
    authorId,
    agents: agentRows.map((agent) => ({ id: agent.id, bossId: agent.bossId, isActive: agent.isActive, isCompanyBoss: agent.positionId ? bossPositionIds.has(agent.positionId) : false })),
    departmentHeadId,
  });
  const openFindings = await openFindingRows(card);
  const level = card.fixLevel ?? 0;
  const triggerLabel = trigger === 'escalation'
    ? 'the author escalated'
    : trigger === 'rounds_exhausted'
      ? `the author used all ${card.maxRevisions ?? 3} revisions at fix level ${level}`
      : 'every reviewer flagged a P0 for reassignment';
  const authorName = author?.name ?? 'the author';
  if (!nextOwnerId) {
    const reason = `Fix exhausted: ${triggerLabel}, and ${authorName} has no boss inside the department to take the card over. Decide: approve as is, reject to send it back, or cancel.`;
    await ensureHumanGate(card, authorId, reason, {
      kind: 'fix_exhausted',
      trigger,
      roundId: round.id,
      level,
      findings: openFindings.map((finding) => ({ key: finding.key, severity: finding.severity, title: finding.title, file: finding.file, line: finding.line })),
    });
    await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_fix_exhausted', body: `${reason}\n\n${summary}`, metadata: { trigger, roundId: round.id, level } });
    await addTaskLog({ cardId: card.id, agentId: authorId, type: 'review', status: 'warning', message: reason });
    await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: authorId, action: 'review.fix_exhausted', entityType: 'card', entityId: card.id, details: { trigger, roundId: round.id, level } });
    await notify({ companyId: card.companyId, type: 'review_fix_exhausted', title: `Fix exhausted: ${card.title}`, body: reason, entityType: 'card', entityId: card.id, cardId: card.id, agentId: authorId });
    publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review.fix_exhausted' });
    return card;
  }
  const newOwner = agentRows.find((agent) => agent.id === nextOwnerId);
  const newOwnerName = newOwner?.name ?? nextOwnerId;
  const panel = await composePanelForCard({ companyId: card.companyId, assigneeId: nextOwnerId }, card.reviewerIds.filter((id) => id !== nextOwnerId));
  const [updated] = await db.update(kanbanCards).set({
    assigneeId: nextOwnerId,
    reviewerId: null,
    reviewerIds: panel.reviewerIds,
    columnStatus: 'todo',
    fixLevel: level + 1,
    revisionCount: 0,
    reviewFeedback: clipText(summary, 8000),
    sessionId: null,
    retryCount: 0,
    nextRunAt: null,
    completedAt: null,
    lastError: null,
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: new Date(),
  }).where(eq(kanbanCards.id, card.id)).returning();
  await addStageLog(card.id, authorId, card.columnStatus, 'todo', 'handoff');
  const body = [
    `Card taken over by ${newOwnerName} from ${authorName} after blind review: ${triggerLabel}. Fix level ${level + 1}; revision count reset.`,
    `Reviewers for the verification: ${panel.reviewerIds.map(panel.nameOf).join(', ') || 'none eligible yet'}${panel.degraded ? ' (panel_degraded)' : ''}.`,
    'Open findings handed over:',
    formatFindingsForPrompt(openFindings),
  ].join('\n');
  await addCardMessage({ cardId: card.id, agentId: authorId, action: 'handoff', body, metadata: { takeover: true, trigger, roundId: round.id, fromAgentId: authorId, toAgentId: nextOwnerId, reviewerIds: panel.reviewerIds } });
  await addTaskLog({ cardId: card.id, agentId: authorId, type: 'handoff', status: 'warning', message: `Card taken over by ${newOwnerName} (${trigger}); fix level ${level + 1}.` });
  await resolvePendingApproval(card, 'rejected', `Taken over by ${newOwnerName}: ${triggerLabel}.`);
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: authorId, action: 'review.takeover', entityType: 'card', entityId: card.id, details: { trigger, fromAgentId: authorId, toAgentId: nextOwnerId, roundId: round.id, level: level + 1, reviewerIds: panel.reviewerIds, panelDegraded: panel.degraded } });
  await notify({ companyId: card.companyId, type: 'review_takeover', title: `Card taken over: ${card.title}`, body: `${newOwnerName} takes over from ${authorName} (${triggerLabel}).`, entityType: 'card', entityId: card.id, cardId: card.id, agentId: nextOwnerId });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'review.takeover' });
  try { await enqueueTaskRun(card.id, 'dispatch', 'queue'); } catch { /* the dispatch cron picks todo cards up on its own */ }
  return updated ?? card;
}

// === The author's fix round ====================================================

// The findings the current owner must answer: the latest closed panel round
// that requested revision, minus everything already dispositioned and not
// contested by the verify round.
export async function openFixRound(card: Pick<CardRow, 'id' | 'reviewRound'>): Promise<FixRound | null> {
  if ((card.reviewRound ?? 0) === 0) return null;
  const round = await latestClosedPanelRound(card.id);
  if (!round || round.decision !== 'revision_requested') return null;
  const rows = await db.select().from(reviewFindings).where(eq(reviewFindings.roundId, round.id)).orderBy(reviewFindings.createdAt);
  const findings = sortFindings(rows.map(findingFromRow).filter(findingIsOpen));
  return findings.length > 0 ? { round, findings } : null;
}

// Bootstrap (and continuation) prompt section for an author under findings.
export async function fixSection(card: CardRow): Promise<string> {
  const fix = await openFixRound(card);
  if (!fix) return '';
  return [
    `=== Review findings to fix (blind review round ${fix.round.round}, fix level ${card.fixLevel ?? 0}, revision ${card.revisionCount ?? 0}/${card.maxRevisions ?? 3}) ===`,
    'These findings came from independent blind reviewers and were merged; answer every one of them in your report.',
    formatFindingsForPrompt(fix.findings),
    formatDispositionRules(),
  ].join('\n');
}

// The author reported completion on a fix round: persist the dispositions and
// open the verify round, or escalate straight into a takeover.
export async function afterAuthorFix(card: CardRow, agent: AgentRow, fix: FixRound, input: { escalation: AgentReportEscalation | null; dispositions: AgentReportDisposition[] }): Promise<void> {
  if (input.escalation) {
    const meta = metadataOf(fix.round.metadata);
    await db.update(reviewRounds).set({ metadata: { ...meta, escalation: { reason: input.escalation.reason, agentId: agent.id, at: new Date().toISOString() } } }).where(eq(reviewRounds.id, fix.round.id));
    await addCardMessage({ cardId: card.id, agentId: agent.id, action: 'review_fix_escalated', body: `${agent.name} escalated the fix of blind review round ${fix.round.round}: ${input.escalation.reason}`, metadata: { roundId: fix.round.id } });
    await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'escalation', status: 'warning', message: `Author escalated the fix of blind review round ${fix.round.round}.`, output: input.escalation.reason });
    await takeoverCard(card, fix.round, 'escalation', `Escalated by ${agent.name}: ${input.escalation.reason}`);
    return;
  }
  const now = new Date();
  const answerFor = (key: string) => input.dispositions.find((item) => normalizeFindingKey(item.findingKey) === normalizeFindingKey(key));
  const keyOf = (value: string | null | undefined) => fix.findings.find((finding) => normalizeFindingKey(finding.key) === normalizeFindingKey(value))?.key ?? null;
  const counts = { adopted: 0, rejected: 0, merged: 0 };
  for (const finding of fix.findings) {
    const answer = answerFor(finding.key);
    if (!answer) continue;
    counts[answer.disposition] += 1;
    await db.update(reviewFindings).set({
      disposition: answer.disposition,
      dispositionReason: answer.reason?.trim() || null,
      mergedInto: answer.disposition === 'merged' ? keyOf(answer.mergedInto) : null,
      codeEvidence: answer.codeEvidence?.trim() || null,
      testEvidence: answer.testEvidence?.trim() || null,
      verification: null,
      verificationNote: null,
      updatedAt: now,
    }).where(and(eq(reviewFindings.roundId, fix.round.id), eq(reviewFindings.findingKey, finding.key)));
  }
  const warnings = dispositionWarnings(fix.findings, input.dispositions);
  await addCardMessage({
    cardId: card.id,
    agentId: agent.id,
    action: 'review_fix_submitted',
    body: [
      `${agent.name} answered the ${fix.findings.length} open finding(s) of blind review round ${fix.round.round}: ${counts.adopted} adopted, ${counts.rejected} rejected, ${counts.merged} merged.`,
      ...fix.findings.map((finding) => {
        const answer = answerFor(finding.key);
        return `- ${finding.key} [${finding.severity}]: ${answer?.disposition ?? 'none'}${answer?.reason ? ` - ${clipText(answer.reason, 300)}` : ''}${answer?.mergedInto ? ` (merged into ${answer.mergedInto})` : ''}`;
      }),
      warnings.length > 0 ? `Warnings: ${warnings.join(' ')}` : '',
    ].filter(Boolean).join('\n'),
    metadata: { roundId: fix.round.id, counts, warnings },
  });
  await addTaskLog({ cardId: card.id, agentId: agent.id, type: 'review', status: 'queued', message: `Dispositions recorded for ${fix.findings.length} finding(s) of blind review round ${fix.round.round}; verification round queued.` });
  await openPanelRound(card, { kind: 'verify' });
}

// === Sweep and listing =========================================================

async function cancelRound(round: ReviewRoundRow, card: CardRow | null, reason: string): Promise<void> {
  const [claimed] = await db.update(reviewRounds).set({ status: 'closed', decision: 'cancelled', closedAt: new Date(), summary: reason })
    .where(and(eq(reviewRounds.id, round.id), eq(reviewRounds.status, 'open'))).returning();
  if (!claimed) return;
  const slots = await roundSlots(round);
  if (slots.length > 0) {
    await db.update(taskRuns).set({ status: 'cancelled', completedAt: new Date(), lockedBy: null, lockedAt: null, error: 'review_round_cancelled', updatedAt: new Date() })
      .where(and(inArray(taskRuns.messageCommentId, slots.map((slot) => slot.id)), eq(taskRuns.kind, 'panel_review'), inArray(taskRuns.status, ['queued', 'running'])));
  }
  if (!card) return;
  await addCardMessage({ cardId: card.id, authorType: 'system', action: 'review_round_cancelled', body: `Blind ${round.kind} review round ${round.round} cancelled: ${reason}.`, metadata: { roundId: round.id, round: round.round, kind: round.kind } });
  await addTaskLog({ cardId: card.id, agentId: round.authorAgentId, type: 'review', status: 'warning', message: `Blind ${round.kind} review round ${round.round} cancelled: ${reason}.` });
  await addActivity({ companyId: card.companyId, actorType: 'system', actorId: 'review-panel', agentId: round.authorAgentId, action: 'review_round.cancelled', entityType: 'card', entityId: card.id, details: { roundId: round.id, round: round.round, kind: round.kind, reason } });
}

// Dispatch cron: close rounds whose timeout passed (absent reviewers are named
// as such), and cancel rounds whose card left review by other means.
export async function sweepReviewRounds(app: FastifyInstance): Promise<number> {
  const open = await db.select().from(reviewRounds).where(eq(reviewRounds.status, 'open')).orderBy(reviewRounds.openedAt).limit(50);
  let closed = 0;
  const now = Date.now();
  for (const round of open) {
    try {
      const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, round.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (!card || card.columnStatus !== 'in_review') {
        await cancelRound(round, card ?? null, card ? `the card is ${card.columnStatus ?? 'todo'}, no longer in review` : 'the card was archived');
        closed += 1;
        continue;
      }
      const timedOut = Boolean(round.timeoutAt && round.timeoutAt.getTime() <= now);
      if (await tryCloseRound(round.id, { force: timedOut, closedBy: timedOut ? 'timeout' : 'sweep' })) closed += 1;
    } catch (error) {
      app.log.warn({ error, roundId: round.id }, 'review round sweep skipped a round');
    }
  }
  if (closed > 0) app.log.info({ closed }, 'review rounds closed by the sweep');
  return closed;
}

export async function listReviewRounds(cardId: string, limit = 20) {
  const rounds = await db.select().from(reviewRounds).where(eq(reviewRounds.cardId, cardId)).orderBy(desc(reviewRounds.openedAt)).limit(Math.min(Math.max(limit, 1), 100));
  if (rounds.length === 0) return [];
  const numbers = [...new Set(rounds.map((round) => round.round))];
  const rows = await db.select().from(reviewFindings).where(and(eq(reviewFindings.cardId, cardId), inArray(reviewFindings.round, numbers))).orderBy(reviewFindings.createdAt);
  return rounds.map((round) => ({ ...round, findings: rows.filter((row) => row.round === round.round) }));
}
