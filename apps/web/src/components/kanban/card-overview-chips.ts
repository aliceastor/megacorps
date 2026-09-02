// Pure descriptors for the overview zone: the chip row, child-card chip tones
// and which needs-you strip (if any) a card requires. No React here so
// node:test can pin the rules down without rendering.
import { priorityValue } from './card-helpers';
import type { Card, CardApproval, CardComment } from './card-types';

export type OverviewChipField = 'priority' | 'decisionMode' | 'requiresApproval' | 'maxRetries' | 'dependencyCardIds';
export type OverviewChipTone = 'neutral' | 'accent' | 'danger';
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

  if (card.requiresApproval && !TERMINAL.has(status)) {
    const pending = pendingOf('task_review');
    if (pending) return { kind: 'approval', approval: pending };
    if ((status === 'in_review' || status === 'needs_review') && loaded) return { kind: 'reviewHint' };
  }

  if (status === 'blocked') return { kind: 'blocked' };
  if (status === 'todo') return { kind: 'todo' };
  return null;
}
