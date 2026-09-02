// The situation line: one sentence that says what a card is waiting for right
// now. Pure: it reads the board card, the cached rows the panel already holds
// and returns an i18n key + variables (plus the rendered text through ctx.tf),
// so the overview zone never has to reason about statuses itself.
import type { Agent, Card, CardComment, CardDelegationSummary, TaskLog } from '../components/kanban/card-types';
import { formatDuration, formatRelative } from './relative-time';

export type SituationTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export type SituationApproval = { id: string; type: string; status: string; createdAt?: string; payload?: Record<string, unknown> | null };
export type SituationChild = { id: string; title: string; columnStatus: string };
export type SituationTranslate = (key: string, vars?: Record<string, string | number>) => string;
export type SituationContext = {
  now: number;
  locale: string;
  tf: SituationTranslate;
  agents?: Agent[] | null;
  /** Direct children from GET /api/cards/:id/subtree; null/undefined = not loaded. */
  children?: SituationChild[] | null;
  approvals?: SituationApproval[] | null;
  delegationSummary?: CardDelegationSummary | null;
  latestComments?: CardComment[] | null;
  latestLogs?: TaskLog[] | null;
};
export type Situation = { key: string; vars: Record<string, string | number>; tone: SituationTone; text: string };

export const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting', 'submitted'] as const;
const LIVE_CHILD_EXCLUDED = new Set(['done', 'cancelled']);
const BLOCK_REASON_ACTIONS = new Set(['agent_error', 'agent_blocked', 'pause_agent', 'review_error', 'escalate_to_reviewer', 'review_blocked']);
const REASON_LIMIT = 120;

function parseTime(value?: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function metadataOf(comment: CardComment): Record<string, unknown> {
  const metadata = comment.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

function clip(text: string, limit = REASON_LIMIT): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function newestComment(comments: CardComment[], predicate: (comment: CardComment) => boolean): CardComment | undefined {
  return [...comments].filter(predicate).sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))[0];
}

function newestLog(logs: TaskLog[], predicate: (log: TaskLog) => boolean): TaskLog | undefined {
  return [...logs].filter(predicate).sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt))[0];
}

export function describeSituation(card: Card, ctx: SituationContext): Situation {
  const status = card.columnStatus;
  const agents = ctx.agents ?? [];
  const comments = ctx.latestComments ?? [];
  const logs = ctx.latestLogs ?? [];
  const approvals = ctx.approvals ?? [];
  const you = ctx.tf('common.you');
  const agentName = (id: string | null | undefined): string | null => (id ? agents.find((agent) => agent.id === id)?.name ?? id.slice(0, 8) : null);
  const assigneeName = agentName(card.assigneeId) ?? ctx.tf('kanban.noneAssigned');
  const finish = (key: string, vars: Record<string, string | number>, tone: SituationTone): Situation => ({ key, vars, tone, text: ctx.tf(key, vars) });

  if (status === 'waiting_on_client') {
    const pending = approvals.find((approval) => approval.type === 'client_checkpoint' && approval.status === 'pending');
    const asked = newestComment(comments, (comment) => comment.action === 'client_checkpoint_asked');
    const payloadQuestion = pending?.payload && typeof pending.payload.question === 'string' ? pending.payload.question : '';
    const question = clip(payloadQuestion || asked?.body || '');
    const since = parseTime(pending?.createdAt) || parseTime(asked?.createdAt) || parseTime(card.updatedAt);
    const waited = since > 0 ? ctx.tf('kanban.waitedFor', { duration: formatDuration(ctx.now - since, ctx.locale) }) : '';
    return finish(question ? 'kanban.situation.client' : 'kanban.situation.clientNoQuestion', { question, waited }, 'warning');
  }

  if (status === 'waiting_on_brainstorm') {
    const opened = newestComment(comments, (comment) => comment.action === 'brainstorm_opened' && typeof metadataOf(comment).round === 'number');
    const openedMeta = opened ? metadataOf(opened) : {};
    const round = card.brainstormRound ?? (typeof openedMeta.round === 'number' ? openedMeta.round : 1);
    const departmentIds = Array.isArray(openedMeta.departmentIds) ? openedMeta.departmentIds : null;
    if (departmentIds) return finish('kanban.situation.brainstorm', { round, count: departmentIds.length }, 'accent');
    return finish('kanban.situation.brainstormNoCount', { round }, 'accent');
  }

  const terminal = status === 'done' || status === 'cancelled';
  const children = ctx.children ?? null;
  const live = (children ?? []).filter((child) => !LIVE_CHILD_EXCLUDED.has(child.columnStatus));
  const splitRound = card.splitRound ?? 0;
  const roundSuffix = splitRound > 0 ? ` · ${ctx.tf('kanban.roundN', { n: splitRound })}` : '';
  if (!terminal && (card.rollupStatus === 'waiting_on_children' || live.length > 0)) {
    if (live.length === 0) return finish('kanban.situation.childrenPending', { roundSuffix }, 'accent');
    const clientCount = live.filter((child) => child.columnStatus === 'waiting_on_client').length;
    const blockedCount = live.filter((child) => child.columnStatus === 'blocked').length;
    const clauses = [
      clientCount > 0 ? ctx.tf('kanban.childrenWaitingClient', { count: clientCount }) : '',
      blockedCount > 0 ? ctx.tf('kanban.childrenBlocked', { count: blockedCount }) : '',
    ].filter(Boolean).join(ctx.tf('kanban.listSeparator'));
    const tone: SituationTone = clientCount > 0 ? 'warning' : blockedCount > 0 ? 'danger' : 'accent';
    if (clauses) return finish('kanban.situation.childrenDetail', { count: live.length, roundSuffix, clauses }, tone);
    return finish('kanban.situation.children', { count: live.length, roundSuffix }, tone);
  }

  if (!terminal && card.rollupStatus === 'integrating') return finish('kanban.situation.integrating', { name: assigneeName }, 'accent');

  if (status === 'in_review' || status === 'needs_review') {
    const name = agentName(card.reviewerId) ?? you;
    return finish(status === 'needs_review' ? 'kanban.situation.helpReview' : 'kanban.situation.review', { name }, 'accent');
  }

  if (status === 'waiting_on_external') {
    const external = newestLog(logs, (log) => log.type === 'external');
    const message = external ? clip(external.message) : '';
    return finish(message ? 'kanban.situation.external' : 'kanban.situation.externalNoMessage', { message }, 'neutral');
  }

  if (status === 'blocked') {
    const reasonComment = newestComment(comments, (comment) => BLOCK_REASON_ACTIONS.has(comment.action));
    const reasonLog = newestLog(logs, (log) => log.status === 'failed' || log.status === 'error' || log.type === 'lock_expired');
    const candidates = [reasonComment ? { at: parseTime(reasonComment.createdAt), text: reasonComment.body } : null, reasonLog ? { at: parseTime(reasonLog.createdAt), text: reasonLog.message } : null]
      .filter((item): item is { at: number; text: string } => item !== null)
      .sort((a, b) => b.at - a.at);
    const reason = clip(candidates[0]?.text ?? '');
    return finish(reason ? 'kanban.situation.blocked' : 'kanban.situation.blockedNoReason', { reason }, 'danger');
  }

  if (status === 'in_progress') {
    const summary = ctx.delegationSummary;
    const phaseStatus = summary?.phaseStatus ?? '';
    if (summary?.phaseAssigneeId && (ACTIVE_DELEGATION_STATUSES as readonly string[]).includes(phaseStatus)) {
      const assignee = agentName(summary.phaseAssigneeId) ?? assigneeName;
      const reviewer = agentName(summary.phaseReviewerId);
      if (reviewer) return finish('kanban.situation.delegation', { assignee, reviewer }, 'accent');
      return finish('kanban.situation.delegationNoReviewer', { assignee }, 'accent');
    }
    const since = card.startedAt ? formatRelative(card.startedAt, ctx.now, ctx.locale) : '';
    return finish(since ? 'kanban.situation.running' : 'kanban.situation.runningNoSince', { name: assigneeName, since }, 'accent');
  }

  if (status === 'todo') return finish('kanban.situation.queued', {}, 'neutral');
  if (status === 'done') {
    const at = card.completedAt ? formatRelative(card.completedAt, ctx.now, ctx.locale) : '';
    return finish(at ? 'kanban.situation.done' : 'kanban.situation.doneNoAt', { at }, 'success');
  }
  if (status === 'cancelled') return finish('kanban.situation.cancelled', {}, 'neutral');
  return finish('kanban.situation.unknown', { status }, 'neutral');
}
