// Blind review rounds (company pipeline design §17), the pure client side of
// GET /api/cards/:id/review-rounds: which round is open, how many seats have
// answered, the findings a closed round shows (the merges the server made at
// round close folded into their primary row), the fix cycle a card is in and
// the human gate a task_review approval carries. No React: the situation
// line, the overview chips, the needs-you strip and the conversation tab all
// read rounds through these helpers, and node:test pins the rules down.
import type { Card, CardComment, ReviewFinding, ReviewRound } from '../components/kanban/card-types';

/** review-rounds.ts SYSTEM_MERGE_NOTE: the verification note on a duplicate the server merged when the round closed. */
export const SYSTEM_MERGE_NOTE = 'merged at round close';
const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseTime(value?: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Newest first: by opened time, then round number (the API already returns this order; sorting keeps it stable for cached rows). */
export function sortRounds(rounds: ReviewRound[] | null | undefined): ReviewRound[] {
  return [...(rounds ?? [])].sort((a, b) => parseTime(b.openedAt) - parseTime(a.openedAt) || b.round - a.round);
}

export function openReviewRound(rounds: ReviewRound[] | null | undefined): ReviewRound | null {
  return sortRounds(rounds).find((round) => round.status === 'open') ?? null;
}

export function latestClosedRound(rounds: ReviewRound[] | null | undefined, kind?: string): ReviewRound | null {
  return sortRounds(rounds).find((round) => round.status === 'closed' && (!kind || round.kind === kind)) ?? null;
}

/** Seats answered so far: submitSlot records one verdict per reviewer in round.metadata.verdicts. */
export function submittedCount(round: ReviewRound): number {
  const verdicts = metadataOf(metadataOf(round.metadata).verdicts);
  return Object.keys(verdicts).filter((id) => round.reviewerIds.includes(id)).length;
}

export function panelDegraded(round: ReviewRound): boolean {
  return metadataOf(round.metadata).panel_degraded === true;
}

export function severityRank(severity: string | null | undefined): number {
  return SEVERITY_RANK[(severity ?? '').toUpperCase()] ?? 3;
}

/** A finding still needs the author: never answered, or the verify round said the answer does not hold. */
export function findingIsOpen(finding: Pick<ReviewFinding, 'disposition' | 'verification'>): boolean {
  return !finding.disposition || finding.verification === 'still_open';
}

/** A duplicate the server folded into another finding when the round closed (not an author decision). */
export function isSystemMerged(finding: Pick<ReviewFinding, 'disposition' | 'verificationNote'>): boolean {
  return finding.disposition === 'merged' && finding.verificationNote === SYSTEM_MERGE_NOTE;
}

export function findingLocation(finding: Pick<ReviewFinding, 'file' | 'line'>): string {
  if (!finding.file) return '';
  return finding.line === null || finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

export type DisplayFinding = ReviewFinding & { reviewerIds: string[]; mergedKeys: string[] };

/**
 * The rows a closed round's table shows: system-merged duplicates disappear
 * into their primary (which remembers every reviewer who raised it); the
 * author's own `merged` dispositions stay visible as rows. Sorted P0 → P2,
 * then by key, like the server's message.
 */
export function displayFindings(findings: ReviewFinding[] | null | undefined): DisplayFinding[] {
  const rows = findings ?? [];
  const duplicates = rows.filter(isSystemMerged);
  return rows.filter((finding) => !isSystemMerged(finding)).map((primary) => {
    const folded = duplicates.filter((row) => row.mergedInto === primary.findingKey);
    return {
      ...primary,
      reviewerIds: unique([primary.reviewerAgentId, ...folded.map((row) => row.reviewerAgentId)].filter((id): id is string => Boolean(id))),
      mergedKeys: folded.map((row) => row.findingKey),
    };
  }).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.findingKey.localeCompare(b.findingKey));
}

export function openFindings(findings: ReviewFinding[] | null | undefined): DisplayFinding[] {
  return displayFindings(findings).filter(findingIsOpen);
}

/** The round a review_round_* comment belongs to: metadata.roundId first, else the round number plus kind. */
export function roundForComment(rounds: ReviewRound[] | null | undefined, refs: { roundId?: string; round?: number; reviewRoundKind?: string }): ReviewRound | null {
  const list = rounds ?? [];
  if (refs.roundId) {
    const byId = list.find((round) => round.id === refs.roundId);
    if (byId) return byId;
  }
  if (refs.round === undefined) return null;
  return sortRounds(list).find((round) => round.round === refs.round && (!refs.reviewRoundKind || round.kind === refs.reviewRoundKind)) ?? null;
}

/** The round-closed message without its markdown findings table: the conversation renders that table from the rounds query. */
export function stripFindingsTable(body: string): string {
  return body.split(/\r?\n/).filter((line) => !/^\s*\|/.test(line) && !/^(Findings|Dispositions verified) \(\d+/.test(line.trim())).join('\n').trim();
}

/** A sealed panel seat (review_slot with metadata.sealed): the board never shows it, whichever layout is on. */
export function isSealedComment(comment: Pick<CardComment, 'metadata' | 'action'>): boolean {
  return metadataOf(comment.metadata).sealed === true;
}

export type GateFinding = { key: string; severity: string; title: string; file: string | null; line: number | null };
export type HumanGate = {
  /** client_approval | review_unavailable | fix_exhausted (ensureHumanGate's payload.kind; client_approval when absent). */
  kind: string;
  reason: string;
  findings: GateFinding[];
  trigger: string | null;
  level: number | null;
};

/** A pending task_review approval flagged humanGate (§17.6: human approval is the last gate); null for anything else. */
export function humanGateOf(approval: { type: string; status: string; payload?: Record<string, unknown> | null } | null | undefined): HumanGate | null {
  if (!approval || approval.type !== 'task_review' || approval.status !== 'pending') return null;
  const payload = metadataOf(approval.payload);
  if (payload.humanGate !== true) return null;
  const findings = Array.isArray(payload.findings)
    ? payload.findings.map((item) => metadataOf(item)).filter((item) => typeof item.key === 'string' && typeof item.title === 'string').map((item) => ({
      key: String(item.key),
      severity: typeof item.severity === 'string' ? item.severity : 'P2',
      title: String(item.title),
      file: typeof item.file === 'string' ? item.file : null,
      line: typeof item.line === 'number' ? item.line : null,
    }))
    : [];
  return {
    kind: typeof payload.kind === 'string' && payload.kind ? payload.kind : 'client_approval',
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    findings,
    trigger: typeof payload.trigger === 'string' ? payload.trigger : null,
    level: typeof payload.level === 'number' ? payload.level : null,
  };
}

export function pendingHumanGate(approvals: Array<{ type: string; status: string; payload?: Record<string, unknown> | null }> | null | undefined): HumanGate | null {
  for (const approval of approvals ?? []) {
    const gate = humanGateOf(approval);
    if (gate) return gate;
  }
  return null;
}

export type FixState = {
  round: ReviewRound;
  /** The card left its author along the boss chain: a later owner holds it (fix level > 0, the round's author is someone else). */
  takenOver: boolean;
  /** This level's revision number (revision_count, at least 1) and its cap (max_revisions). */
  revision: number;
  maxRevisions: number;
};

/**
 * The fix cycle a card is in: its newest round closed asking for revision and
 * nothing newer is open, so the card is back with an owner who must answer
 * the findings. null when the card never had a round or the newest round did
 * not send it back.
 */
export function fixState(card: Pick<Card, 'assigneeId' | 'reviewRound' | 'fixLevel' | 'revisionCount' | 'maxRevisions'>, rounds: ReviewRound[] | null | undefined): FixState | null {
  if ((card.reviewRound ?? 0) === 0) return null;
  const latest = sortRounds(rounds)[0] ?? null;
  if (!latest || latest.status !== 'closed' || latest.decision !== 'revision_requested') return null;
  const takenOver = (card.fixLevel ?? 0) > 0 && Boolean(latest.authorAgentId) && latest.authorAgentId !== (card.assigneeId ?? null);
  return { round: latest, takenOver, revision: Math.max(1, card.revisionCount ?? 0), maxRevisions: card.maxRevisions ?? 3 };
}
