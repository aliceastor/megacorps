// Pure descriptors for the overview zone: the chip row, child-card chip tones
// and which needs-you strip (if any) a card requires. No React here so
// node:test can pin the rules down without rendering.
import { briefGaps } from '../../lib/card-brief';
import { humanGateOf, type GateFinding } from '../../lib/card-review';
import { priorityValue } from './card-helpers';
import type { Card, CardApproval, CardComment } from './card-types';

export type OverviewChipField = 'priority' | 'decisionMode' | 'requiresApproval' | 'maxRetries' | 'dependencyCardIds' | 'reviewMode' | 'critical' | 'body';
export type OverviewChipTone = 'neutral' | 'accent' | 'warning' | 'danger';
export type OverviewChip = { id: string; text: string; tone: OverviewChipTone; /** null = informational, not editable */ field: OverviewChipField | null };
export type OverviewTranslate = (key: string, vars?: Record<string, string | number>) => string;
export type OverviewChipContext = {
  tf: OverviewTranslate;
  /** Board cards, used to resolve dependency status; a dependency missing from the board is neither met nor unmet. */
  cards?: Card[] | null;
  /** Direct children from GET /api/cards/:id/subtree; null = not loaded or not a parent card. */
  children?: Array<Pick<Card, 'id' | 'columnStatus'>> | null;
};

const DECISION_MODES = new Set(['auto', 'solo', 'pair', 'swarm']);
const LIVE_CHILD_EXCLUDED = new Set(['done', 'cancelled']);
const TERMINAL = new Set(['done', 'cancelled']);

function parseTime(value?: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/** Same normalisation the edit form's collaboration select applies. */
export function normalizeDecisionMode(mode: string | null | undefined): string {
  const value = String(mode ?? '');
  if (DECISION_MODES.has(value)) return value;
  if (value === 'execute') return 'solo';
  return 'auto';
}

export function overviewChips(card: Card, ctx: OverviewChipContext): OverviewChip[] {
  const chips: OverviewChip[] = [];
  chips.push({ id: 'priority', field: 'priority', tone: 'neutral', text: ctx.tf(`kanban.priority.${priorityValue(card.priority)}`) });
  chips.push({ id: 'decisionMode', field: 'decisionMode', tone: 'neutral', text: `${ctx.tf('kanban.collaboration')} ${normalizeDecisionMode(card.decisionMode)}` });
  chips.push({ id: 'requiresApproval', field: 'requiresApproval', tone: 'neutral', text: `${ctx.tf('kanban.requiresApproval')} ${card.requiresApproval ? '✓' : '—'}` });
  chips.push({ id: 'maxRetries', field: 'maxRetries', tone: 'neutral', text: `${ctx.tf('kanban.chipRetryLimit')} ${card.maxRetries ?? 3}` });

  const dependencyIds = card.dependencyCardIds ?? [];
  if (dependencyIds.length > 0) {
    const board = ctx.cards ?? [];
    const unmet = dependencyIds.filter((id) => {
      const dependency = board.find((item) => item.id === id);
      return dependency ? dependency.columnStatus !== 'done' : false;
    }).length;
    const base = `${ctx.tf('kanban.dependencies')} ${dependencyIds.length}`;
    chips.push({
      id: 'dependencies',
      field: 'dependencyCardIds',
      tone: unmet > 0 ? 'danger' : 'neutral',
      text: unmet > 0 ? `${base} · ${unmet} ${ctx.tf('kanban.chipUnmet')}` : base,
    });
  }

  const splitRound = card.splitRound ?? 0;
  const roundSuffix = splitRound > 0 ? ` · ${ctx.tf('kanban.roundN', { n: splitRound })}` : '';
  const children = ctx.children ?? null;
  if (children && children.length > 0) {
    const live = children.filter((child) => !LIVE_CHILD_EXCLUDED.has(child.columnStatus)).length;
    chips.push({ id: 'children', field: null, tone: 'accent', text: `${ctx.tf('kanban.chipChildren')} ${live}/${children.length}${roundSuffix}` });
  } else if (splitRound > 0) {
    chips.push({ id: 'children', field: null, tone: 'accent', text: ctx.tf('kanban.roundN', { n: splitRound }) });
  }

  if (card.forceBrainstorm) chips.push({ id: 'forceBrainstorm', field: null, tone: 'accent', text: ctx.tf('kanban.chipForceBrainstorm') });

  // Blind review panel (§17): the mode chip when the card asks for a panel or
  // has already had a round (a critical card under the company default), the
  // critical flag, and the brief sections still missing from the body (§18).
  const reviewRound = card.reviewRound ?? 0;
  if (card.reviewMode === 'panel' || reviewRound > 0) {
    const base = ctx.tf('kanban.chipPanel');
    chips.push({ id: 'reviewMode', field: 'reviewMode', tone: 'accent', text: reviewRound > 0 ? `${base} · ${ctx.tf('kanban.roundN', { n: reviewRound })}` : base });
  }
  if (card.critical) chips.push({ id: 'critical', field: 'critical', tone: 'warning', text: ctx.tf('kanban.chipCritical') });
  if (card.body && card.body.trim()) {
    const gaps = briefGaps(card.body);
    if (gaps.length > 0) {
      chips.push({ id: 'brief', field: 'body', tone: gaps.includes('acceptance') ? 'warning' : 'neutral', text: ctx.tf('kanban.briefMissing', { sections: gaps.map((key) => ctx.tf(`kanban.brief.${key}`)).join(ctx.tf('kanban.listSeparator')) }) });
    }
  }
  return chips;
}

export type ChildChipTone = 'warning' | 'danger' | 'muted' | 'neutral';

/** waiting_on_client amber, blocked red, finished grey — the same reading as the situation line. */
export function childChipTone(status: string): ChildChipTone {
  if (status === 'waiting_on_client') return 'warning';
  if (status === 'blocked') return 'danger';
  if (TERMINAL.has(status)) return 'muted';
  return 'neutral';
}

export type NeedsYouVariant =
  | { kind: 'checkpoint'; approval: CardApproval }
  | { kind: 'checkpointMissing'; question: string }
  | { kind: 'approval'; approval: CardApproval }
  /** §17.5: the blind review findings could not be fixed along the boss chain; you approve as is, send it back or cancel. */
  | { kind: 'fixExhausted'; approval: CardApproval; findings: GateFinding[]; reason: string; trigger: string | null; level: number | null }
  | { kind: 'reviewHint' }
  | { kind: 'blocked' }
  | { kind: 'todo' }
  | null;

/**
 * Which needs-you strip to render. `approvals === null` means the approvals
 * query has not answered yet: the checkpoint / approval variants stay hidden
 * rather than flashing "nothing pending" for a moment.
 */
export function needsYouVariant(card: Card, approvals: CardApproval[] | null | undefined, comments: CardComment[] = []): NeedsYouVariant {
  const status = card.columnStatus;
  const loaded = Array.isArray(approvals);
  const pendingOf = (type: string) => (approvals ?? []).find((approval) => approval.type === type && approval.status === 'pending');

  if (status === 'waiting_on_client') {
    const pending = pendingOf('client_checkpoint');
    if (pending) return { kind: 'checkpoint', approval: pending };
    if (!loaded) return null;
    const asked = comments
      .filter((comment) => comment.action === 'client_checkpoint_asked')
      .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))[0];
    return { kind: 'checkpointMissing', question: asked?.body ?? '' };
  }

  // A human gate (§17.6) holds the card whether or not it requires approval:
  // fix_exhausted gets its own strip, client_approval / review_unavailable the
  // plain approve / reject form.
  const pendingReview = pendingOf('task_review');
  const gate = humanGateOf(pendingReview);
  if (gate && !TERMINAL.has(status) && pendingReview) {
    if (gate.kind === 'fix_exhausted') return { kind: 'fixExhausted', approval: pendingReview, findings: gate.findings, reason: gate.reason, trigger: gate.trigger, level: gate.level };
    return { kind: 'approval', approval: pendingReview };
  }

  if (card.requiresApproval && !TERMINAL.has(status)) {
    if (pendingReview) return { kind: 'approval', approval: pendingReview };
    if ((status === 'in_review' || status === 'needs_review') && loaded) return { kind: 'reviewHint' };
  }

  if (status === 'blocked') return { kind: 'blocked' };
  if (status === 'todo') return { kind: 'todo' };
  return null;
}
