// The conversation model behind the card panel's 對話 tab: four raw sources
// (comments, task logs, card actions, work products) become one classified,
// de-duplicated, threaded list. Pure and React-free so node:test can pin the
// rules down; the UI only renders what comes out of buildConversation.
import { isDelegationReviewComment } from '../components/kanban/card-helpers';
import type { Agent, Card, CardAction, CardComment, CommentActionMode, ReviewerScope, TaskLog, WorkProduct } from '../components/kanban/card-types';
import { isSealedComment } from './card-review';
import { MENTION_LEAD_CHARS } from './mention-input';

export { isDelegationReviewComment, isSealedComment };

// === Types ==================================================================

export type ConversationSource = 'comment' | 'log' | 'action' | 'product';
export type ConversationKind = 'message' | 'milestone' | 'delegation' | 'review' | 'status' | 'alert' | 'system' | 'product';
export type ConversationTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'product';
export type ConversationActorType = 'you' | 'user' | 'agent' | 'system';
export type ConversationActor = { type: ConversationActorType; id?: string; name: string; role?: string; missing?: boolean };
export type ConversationChipKind = 'consequence' | 'queued' | 'child' | 'parent' | 'verdict' | 'cost' | 'score' | 'reminded' | 'escalated';
export type ConversationChip = { kind: ConversationChipKind; text: string; cardId?: string; status?: string };
export type ConversationRefs = {
  parentCommentId?: string;
  approvalId?: string;
  round?: number;
  childIds?: string[];
  childCardId?: string;
  parentCardId?: string;
  reviewerScope?: ReviewerScope;
  assigneeAgentId?: string;
  reviewerAgentId?: string;
  delegationStatus?: string;
  from?: string;
  to?: string;
  via?: string;
  costUsd?: string;
  durationSeconds?: number;
  mention?: boolean;
  targetSlug?: string;
  sourceCommentId?: string;
  brainstorm?: boolean;
  departmentName?: string;
  departmentIds?: string[];
  commentId?: string;
  logType?: string;
  logStatus?: string;
  action?: string;
  url?: string;
  mergedInto?: string;
  /** Blind review rows (§17): the round they belong to, its kind (panel | verify) and, when closed, its decision. */
  roundId?: string;
  reviewRoundKind?: string;
  decision?: string;
};
export type ConversationEvent = {
  id: string;
  source: ConversationSource;
  kind: ConversationKind;
  tone: ConversationTone;
  at: number;
  createdAt: string;
  actor: ConversationActor;
  /** kanban.event.<action>; when the locale has no such key the UI falls back to rawLabel. */
  labelKey: string;
  rawLabel: string;
  body: string;
  chips: ConversationChip[];
  refs: ConversationRefs;
  /** system rows fold by default; never true for alert / milestone / message / review. */
  hidden: boolean;
  /** what today's DELEGATE / REVIEWER tab would have listed; the 委派與審核 filter must include these. */
  delegationReview: boolean;
  /** nesting depth inside a thread (capped at 3 for display). */
  depth?: number;
  raw: { comment?: CardComment; log?: TaskLog; action?: CardAction; product?: WorkProduct };
};
export type ConversationThreadKind = 'delegation' | 'brainstorm' | 'split' | 'checkpoint' | 'reply';
export type ConversationThreadMeta =
  | { kind: 'delegation'; status?: string; assigneeAgentId?: string; reviewerAgentId?: string; reviewerScope?: ReviewerScope; visibleIds: string[]; processCount: number; retryCount: number }
  | { kind: 'brainstorm'; round: number; answered: number; total: number; closed: boolean }
  | { kind: 'split'; round: number; childIds: string[] }
  | { kind: 'checkpoint'; approvalId: string; approvalStatus: 'pending' | 'answered' | 'cancelled' | 'unknown' | string; reminders: number }
  | { kind: 'reply' };
export type ConversationItem =
  | { type: 'event'; event: ConversationEvent }
  | { type: 'thread'; kind: ConversationThreadKind; root: ConversationEvent; children: ConversationEvent[]; lastActivityAt: number; meta: ConversationThreadMeta }
  | { type: 'fold'; events: ConversationEvent[]; tally: Record<string, number> }
  | { type: 'day'; at: number }
  | { type: 'unread' }
  | { type: 'horizon'; at: number };
export type ConversationApproval = { id: string; type: string; status: string; cardId?: string | null; createdAt?: string; payload?: Record<string, unknown> | null };
export type ConversationContext = { agents: Agent[]; you?: { id?: string; name?: string } };
export type ConversationInput = {
  comments: CardComment[];
  logs: TaskLog[];
  actions: CardAction[];
  workProducts: WorkProduct[];
  approvals?: ConversationApproval[] | null;
  agents: Agent[];
  you?: { id?: string; name?: string };
  logsHasMore?: boolean;
  lastSeenAt?: number | string | null;
  now?: number;
};
export type ConversationFilter = 'all' | 'talk' | 'milestones' | 'delegationReview' | 'system';
export type ConversationSort = 'newest' | 'oldest';
export type ConversationView = { sort: ConversationSort; filter: ConversationFilter };
export type ConversationCounts = { all: number; conversation: number; talk: number; milestones: number; delegationReview: number; system: number; products: number; alerts: number; unread: number };
export type Conversation = { items: ConversationItem[]; counts: ConversationCounts; latest: ConversationEvent | null };

// === Small helpers ==========================================================

const SOURCE_RANK: Record<ConversationSource, number> = { action: 0, log: 1, comment: 2, product: 3 };
const SYSTEM_ACTOR: ConversationActor = { type: 'system', name: 'system' };
const EXACT_WINDOW_MS = 10_000;
const STAGE_WINDOW_MS = 3_000;
const FAMILY_WINDOW_MS = 5_000;
const MAX_THREAD_DEPTH = 8;
const MAX_DISPLAY_DEPTH = 3;

function parseTime(value?: string | null): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function metadataOf(row: { metadata?: unknown }): Record<string, unknown> {
  const metadata = row.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

export function labelKeyFor(action: string): string {
  return `kanban.event.${action.replace(/[^A-Za-z0-9_]+/g, '_')}`;
}

function agentActor(ctx: ConversationContext, id: string): ConversationActor {
  const agent = ctx.agents.find((item) => item.id === id);
  if (!agent) return { type: 'agent', id, name: id.slice(0, 8), missing: true };
  return { type: 'agent', id, name: agent.name, role: agent.role };
}

function youActor(ctx: ConversationContext, id?: string | null): ConversationActor {
  return { type: 'you', id: id ?? ctx.you?.id, name: ctx.you?.name ?? 'you' };
}

function agentName(ctx: ConversationContext, id: string | undefined): string {
  if (!id) return '';
  return ctx.agents.find((item) => item.id === id)?.name ?? id.slice(0, 8);
}

function compareEvents(a: ConversationEvent, b: ConversationEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// === Classification =========================================================

const MESSAGE_TONES: Record<string, ConversationTone> = {
  comment: 'neutral', note: 'neutral', agent_note: 'neutral', agent_question: 'accent', agent_update: 'neutral', agent_escalated: 'warning', handoff: 'accent',
  pause_agent: 'danger', continue_run: 'success', send_to_agent: 'neutral', escalate_to_reviewer: 'warning', peer_question: 'neutral', peer_answer: 'neutral',
};
const MILESTONE_TONES: Record<string, ConversationTone> = {
  split_opened: 'accent', split_child_opened: 'accent', split_round_complete: 'success', split_rejected: 'warning',
  brainstorm_opened: 'accent', brainstorm_closed: 'accent', brainstorm_rejected: 'warning',
  client_checkpoint_asked: 'warning', client_checkpoint_answered: 'success', client_checkpoint_rejected: 'warning',
  create_card: 'accent',
  review_round_opened: 'accent', review_round_closed: 'accent', review_round_cancelled: 'neutral', review_unavailable: 'warning', review_fix_exhausted: 'danger',
};
const DELEGATION_TONES: Record<string, ConversationTone> = {
  delegate_request: 'accent', delegate_to_agent: 'accent', delegate: 'accent', agent_delegated: 'neutral', delegate_report: 'accent',
  delegate_failed: 'danger', delegate_timeout: 'danger', delegate_retry_queued: 'warning', delegate_review_retry_queued: 'warning',
  delegate_review_rejected: 'danger', delegate_review_failed: 'danger', delegate_review_escalated: 'warning',
  delegate_cancelled: 'neutral', delegate_review_cancelled: 'neutral', phase_review_approved: 'success', final_review_approved: 'success',
};
const REVIEW_TONES: Record<string, ConversationTone> = {
  review_note: 'accent', review_guidance: 'accent', review_rejected: 'danger', review_escalated: 'warning', review_blocked: 'warning',
  review_auto_approved: 'success', review_waiting_on_children: 'neutral', review_result: 'accent',
  review_fix_submitted: 'accent', review_fix_escalated: 'warning',
};
const REVIEW_ROUND_ACTIONS = new Set(['review_round_opened', 'review_round_closed', 'review_round_cancelled', 'review_slot']);

/** review_round_closed takes its tone from the decision the server stamped on it. */
function roundClosedTone(decision: string | undefined): ConversationTone {
  if (decision === 'approved') return 'success';
  if (decision === 'revision_requested' || decision === 'unavailable') return 'warning';
  if (decision === 'cancelled') return 'neutral';
  return 'accent';
}
const ALERT_COMMENT_ACTIONS = new Set(['agent_error', 'agent_blocked', 'review_error']);
const STATUS_COMMENT_ACTIONS = new Set(['claim', 'cancel', 'block', 'wait_external']);
const SYSTEM_COMMENT_ACTIONS = new Set(['update_card']);
export const DELEGATION_RETRY_ACTIONS = new Set(['delegate_retry_queued', 'delegate_review_retry_queued']);
export const DELEGATION_TERMINAL_ACTIONS = new Set(['phase_review_approved', 'final_review_approved', 'delegate_review_rejected', 'delegate_review_failed', 'delegate_failed', 'delegate_timeout']);
const DELEGATION_PROCESS_ACTIONS = new Set(['agent_delegated', 'delegate_retry_queued', 'delegate_review_retry_queued', 'delegate_cancelled', 'delegate_review_cancelled']);

export function classifyComment(comment: CardComment, ctx: ConversationContext): ConversationEvent {
  const metadata = metadataOf(comment);
  const action = comment.action;
  const hasDelegationFields = Boolean(comment.delegationStatus || comment.assigneeAgentId || comment.reviewerAgentId || comment.reviewerScope);
  const actor: ConversationActor = comment.agentId
    ? agentActor(ctx, comment.agentId)
    : comment.authorType === 'system'
      ? SYSTEM_ACTOR
      : comment.authorType === 'agent'
        ? { type: 'agent', name: 'agent', missing: true }
        : youActor(ctx, comment.authorId);
  const event: ConversationEvent = {
    id: `c-${comment.id}`,
    source: 'comment',
    kind: 'message',
    tone: 'neutral',
    at: parseTime(comment.createdAt),
    createdAt: comment.createdAt ?? '',
    actor,
    labelKey: labelKeyFor(action),
    rawLabel: action,
    body: comment.body ?? '',
    chips: [],
    refs: {
      parentCommentId: comment.parentCommentId ?? undefined,
      approvalId: str(metadata.approvalId),
      round: num(metadata.round),
      childIds: strList(metadata.childIds),
      childCardId: str(metadata.childCardId),
      parentCardId: str(metadata.parentCardId),
      reviewerScope: comment.reviewerScope ?? undefined,
      assigneeAgentId: comment.assigneeAgentId ?? undefined,
      reviewerAgentId: comment.reviewerAgentId ?? undefined,
      delegationStatus: comment.delegationStatus ?? undefined,
      via: str(metadata.via),
      targetSlug: str(metadata.targetSlug),
      sourceCommentId: str(metadata.sourceCommentId),
      departmentName: str(metadata.departmentName),
      departmentIds: strList(metadata.departmentIds),
      brainstorm: metadata.brainstorm === true ? true : undefined,
      mention: metadata.mention === true ? true : undefined,
      roundId: str(metadata.roundId),
      action,
    },
    hidden: false,
    delegationReview: isDelegationReviewComment(comment),
    raw: { comment },
  };
  if (event.refs.childCardId) event.chips.push({ kind: 'child', text: event.refs.childCardId, cardId: event.refs.childCardId });
  // metadata.kind means something else on checkpoint rows, so the round kind
  // and decision are read only off the blind review rows.
  if (REVIEW_ROUND_ACTIONS.has(action)) {
    event.refs.reviewRoundKind = str(metadata.kind);
    event.refs.decision = str(metadata.decision);
  }

  // Peer questions reuse the delegation columns (assignee + queued status) but
  // they are conversation, so they are recognised before the field rule.
  if (action === 'peer_question' && metadata.mention === true) {
    return { ...event, kind: 'message', tone: 'accent', labelKey: labelKeyFor('mention_question'), rawLabel: 'mention_question' };
  }
  if (action === 'peer_question_failed') {
    return { ...event, kind: 'message', tone: 'warning', actor: SYSTEM_ACTOR, labelKey: labelKeyFor('mention_unresolved'), rawLabel: 'mention_unresolved' };
  }
  if (action === 'peer_question' || action === 'peer_answer') return { ...event, kind: 'message', tone: 'neutral' };
  if (action === 'comment' && actor.type === 'agent') return { ...event, kind: 'message', tone: 'neutral', labelKey: labelKeyFor('agent_comment'), rawLabel: 'agent_comment' };
  if (DELEGATION_TONES[action] || action.startsWith('delegate_')) return { ...event, kind: 'delegation', tone: DELEGATION_TONES[action] ?? 'neutral' };
  if (hasDelegationFields) return { ...event, kind: 'delegation', tone: 'neutral' };
  if (action === 'review_round_closed') return { ...event, kind: 'milestone', tone: roundClosedTone(event.refs.decision) };
  if (MILESTONE_TONES[action]) return { ...event, kind: 'milestone', tone: MILESTONE_TONES[action] ?? 'accent' };
  if (REVIEW_TONES[action]) return { ...event, kind: 'review', tone: REVIEW_TONES[action] ?? 'accent' };
  if (ALERT_COMMENT_ACTIONS.has(action)) return { ...event, kind: 'alert', tone: 'danger' };
  if (STATUS_COMMENT_ACTIONS.has(action)) return { ...event, kind: 'status', tone: action === 'block' || action === 'cancel' ? 'danger' : 'neutral' };
  if (SYSTEM_COMMENT_ACTIONS.has(action)) return { ...event, kind: 'system', tone: 'neutral', hidden: true };
  if (MESSAGE_TONES[action]) return { ...event, kind: 'message', tone: MESSAGE_TONES[action] ?? 'neutral' };
  // Unknown comment action: still a visible message with the raw label.
  return event;
}

const ALERT_LOG_TYPES = new Set(['lock_expired', 'card_blocked', 'budget_override_required']);
const REVIEW_LOG_TYPES = new Set(['review', 'task_review']);
const DELEGATION_LOG_TYPES = new Set(['message_delegation', 'message_review']);
const SYSTEM_LOG_TYPES = new Set([
  'dispatch', 'queue', 'lock', 'schedule', 'retry', 'approval', 'approval_pending', 'needs_review', 'external', 'client_checkpoint', 'client_checkpoint_reminder',
  'children', 'cascade', 'decomposition', 'comment', 'escalation', 'handoff', 'budget', 'cancel', 'webhook', 'assignee', 'reviewer', 'blocked_assignee', 'user',
]);

export function stageTargetFromMessage(message: string): string | undefined {
  const changed = /Stage changed from [a-z_]+ to ([a-z_]+)/.exec(message);
  if (changed?.[1]) return changed[1];
  const set = /Stage set to ([a-z_]+)/.exec(message);
  return set?.[1] ?? undefined;
}

export function classifyLog(log: TaskLog, _ctx: ConversationContext): ConversationEvent {
  const failed = log.status === 'failed' || log.status === 'error';
  const type = log.type;
  const rawLabel = type === 'stage' ? 'stage_changed' : type;
  const event: ConversationEvent = {
    id: `l-${log.id}`,
    source: 'log',
    kind: 'system',
    tone: 'neutral',
    at: parseTime(log.createdAt),
    createdAt: log.createdAt ?? '',
    actor: SYSTEM_ACTOR,
    labelKey: labelKeyFor(rawLabel),
    rawLabel,
    body: [log.message, log.output].filter(Boolean).join('\n\n'),
    chips: [],
    refs: {
      logType: type,
      logStatus: log.status,
      costUsd: log.costUsd,
      durationSeconds: log.durationSeconds,
      to: type === 'stage' ? stageTargetFromMessage(log.message ?? '') : undefined,
    },
    hidden: false,
    delegationReview: false,
    raw: { log },
  };
  if (failed) return { ...event, kind: 'alert', tone: 'danger' };
  if (type === 'stage') return { ...event, kind: 'status', tone: 'neutral' };
  if (ALERT_LOG_TYPES.has(type)) return { ...event, kind: 'alert', tone: 'danger' };
  if (REVIEW_LOG_TYPES.has(type)) return { ...event, kind: 'review', tone: log.status === 'success' ? 'success' : 'warning', delegationReview: true };
  if (DELEGATION_LOG_TYPES.has(type)) return { ...event, kind: 'delegation', tone: log.status === 'warning' ? 'warning' : 'neutral', delegationReview: true };
  if (SYSTEM_LOG_TYPES.has(type)) return { ...event, kind: 'system', hidden: true };
  // Unknown log type: system, but visible (never silently folded away).
  return event;
}

const SYSTEM_ACTION_PREFIXES = ['context.', 'task.'];
// review_round.closed is the card_action twin of the review_round_closed
// comment (same round, same decision); the comment carries the findings.
const SYSTEM_ACTION_NAMES = new Set(['card.created', 'card.updated', 'card.dependencies_updated', 'review_round.closed']);
const TRANSITION_ACTIONS = new Set(['claim', 'submit_review', 'request_help', 'wait_external', 'external_success', 'external_failure', 'ask_client', 'client_answered', 'open_brainstorm', 'brainstorm_closed', 'approve', 'reject', 'complete', 'block', 'cancel', 'release', 'resume', 'reopen', 'manual_move']);

function actorForAction(action: CardAction, ctx: ConversationContext): ConversationActor {
  const type = action.actorType ?? '';
  if (type === 'user') return youActor(ctx, action.actorId);
  if (type.startsWith('agent')) return agentActor(ctx, action.actorId);
  return SYSTEM_ACTOR;
}

export function classifyAction(action: CardAction, ctx: ConversationContext): ConversationEvent {
  const metadata = metadataOf(action);
  const name = action.action;
  const from = action.fromStatus ?? undefined;
  const to = action.toStatus ?? undefined;
  const event: ConversationEvent = {
    id: `a-${action.id}`,
    source: 'action',
    kind: 'status',
    tone: 'neutral',
    at: parseTime(action.createdAt),
    createdAt: action.createdAt ?? '',
    actor: actorForAction(action, ctx),
    labelKey: labelKeyFor(name === 'stage.changed' ? 'stage_changed' : name),
    rawLabel: name,
    body: action.detail ?? '',
    chips: [],
    refs: { from, to, action: name, commentId: str(metadata.commentId), reviewerAgentId: str(metadata.reviewerId) },
    hidden: false,
    delegationReview: false,
    raw: { action },
  };
  if (name === 'create') return { ...event, kind: 'milestone', tone: 'accent', labelKey: labelKeyFor('create_card') };
  if (SYSTEM_ACTION_NAMES.has(name) || SYSTEM_ACTION_PREFIXES.some((prefix) => name.startsWith(prefix))) return { ...event, kind: 'system', hidden: true };
  if (name === 'integration.conflict' || name === 'integration.conflict_recorded') return { ...event, kind: 'milestone', tone: 'warning', labelKey: labelKeyFor('integration_conflict') };
  if (to === 'blocked') return { ...event, kind: 'alert', tone: 'danger' };
  if (to === 'done') return { ...event, kind: 'milestone', tone: 'success' };
  if (to === 'cancelled') return { ...event, kind: 'milestone', tone: 'neutral' };
  if (from || to || TRANSITION_ACTIONS.has(name)) return { ...event, kind: 'status', tone: 'neutral' };
  // Unknown card action: visible status row with the raw label.
  return event;
}

export function classifyProduct(product: WorkProduct, ctx: ConversationContext): ConversationEvent {
  const url = product.pullRequestUrl || product.url || (product.repoUrl && product.commitSha ? `${product.repoUrl.replace(/\/$/, '')}/commit/${product.commitSha}` : '');
  return {
    id: `p-${product.id}`,
    source: 'product',
    kind: 'product',
    tone: 'product',
    at: parseTime(product.createdAt),
    createdAt: product.createdAt ?? '',
    actor: product.agentId ? agentActor(ctx, product.agentId) : SYSTEM_ACTOR,
    labelKey: labelKeyFor('work_product'),
    rawLabel: product.type,
    body: [product.title, product.summary].filter(Boolean).join('\n\n'),
    chips: [],
    refs: { url: url || undefined },
    hidden: false,
    delegationReview: false,
    raw: { product },
  };
}

// === De-duplication =========================================================

type EventPatch = (event: ConversationEvent) => ConversationEvent;

function applyPatches(events: ConversationEvent[], patches: Map<string, EventPatch[]>): ConversationEvent[] {
  return events.map((event) => {
    const list = patches.get(event.id);
    if (!list) return event;
    return list.reduce((current, patch) => patch(current), { ...event, chips: [...event.chips], refs: { ...event.refs } });
  });
}

function addPatch(patches: Map<string, EventPatch[]>, id: string, patch: EventPatch) {
  const list = patches.get(id) ?? [];
  list.push(patch);
  patches.set(id, list);
}

function nearest<T extends ConversationEvent>(candidates: T[], at: number, windowMs: number): T | undefined {
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.at - at);
    if (distance <= windowMs && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

const COMMENT_ECHO_RE = / added a \w+ message\.$/;
const COMMENT_QUEUED_MESSAGE = 'Comment queued for agent context on the next run.';

/**
 * Exact-key de-duplication (design §4.4). Rows removed here never come back,
 * not even under the 系統 filter; the 歷史 tab still shows them raw.
 */
export function dedupeByExactKeys(events: ConversationEvent[], agents: Agent[] = []): { kept: ConversationEvent[]; dropped: ConversationEvent[] } {
  const ctx: ConversationContext = { agents };
  const drop = new Set<string>();
  const patches = new Map<string, EventPatch[]>();
  const comments = events.filter((event) => event.source === 'comment');
  const actions = events.filter((event) => event.source === 'action');
  const commentByRowId = new Map(comments.map((event) => [event.raw.comment?.id ?? '', event]));

  // 1. card_action.metadata.commentId → consequence chip on the human comment.
  for (const action of actions) {
    const commentId = action.refs.commentId;
    if (!commentId) continue;
    const target = commentByRowId.get(commentId);
    if (!target) continue;
    const to = action.refs.to;
    const reviewerAgentId = action.refs.reviewerAgentId;
    addPatch(patches, target.id, (event) => ({
      ...event,
      chips: [...event.chips, { kind: 'consequence', text: to ?? action.rawLabel, status: to }],
      refs: { ...event.refs, from: action.refs.from ?? event.refs.from, to: to ?? event.refs.to, reviewerAgentId: reviewerAgentId ?? event.refs.reviewerAgentId },
    }));
    drop.add(action.id);
  }

  for (const event of events) {
    if (event.source !== 'log' || !event.raw.log) continue;
    const log = event.raw.log;
    // 2. "<author> added a <action> message." echoes the comment itself.
    if (log.type === 'comment' && COMMENT_ECHO_RE.test(log.message ?? '')) {
      drop.add(event.id);
      continue;
    }
    // 3. send_to_agent queue notice → chip on the comment.
    if (log.type === 'comment' && log.message === COMMENT_QUEUED_MESSAGE) {
      const output = (log.output ?? '').trim();
      const target = nearest(comments.filter((comment) => comment.rawLabel === 'send_to_agent' && comment.body.trim() === output), event.at, EXACT_WINDOW_MS);
      if (target) {
        addPatch(patches, target.id, (item) => ({ ...item, chips: [...item.chips, { kind: 'queued', text: 'queued' }] }));
        drop.add(event.id);
      }
      continue;
    }
    // 4. stage log mirrored by the card_action recordStageAction wrote with it.
    if (log.type === 'stage') {
      const to = event.refs.to;
      const mirror = to ? nearest(actions.filter((action) => action.refs.to === to), event.at, STAGE_WINDOW_MS) : undefined;
      if (mirror) drop.add(event.id);
      continue;
    }
    // 5. escalation log → chip on the escalate_to_reviewer comment (queued) or standalone alert (failed).
    if (log.type === 'escalation' && log.status !== 'failed') {
      const output = (log.output ?? '').trim();
      const target = nearest(comments.filter((comment) => comment.rawLabel === 'escalate_to_reviewer' && comment.body.trim() === output), event.at, EXACT_WINDOW_MS);
      if (target) {
        addPatch(patches, target.id, (item) => {
          const reviewerId = item.refs.reviewerAgentId;
          return { ...item, chips: [...item.chips, { kind: 'escalated', text: agentName(ctx, reviewerId) || (reviewerId ?? '') }] };
        });
        drop.add(event.id);
      }
      continue;
    }
  }

  const patched = applyPatches(events, patches);
  return { kept: patched.filter((event) => !drop.has(event.id)), dropped: patched.filter((event) => drop.has(event.id)) };
}

type Family = { logTypes: Set<string>; matches: (comment: ConversationEvent) => boolean };
const FAMILIES: Family[] = [
  { logTypes: new Set(['review', 'task_review']), matches: (comment) => comment.rawLabel.startsWith('review_') },
  { logTypes: new Set(['message_delegation', 'message_review']), matches: (comment) => comment.rawLabel.startsWith('delegate_') || comment.rawLabel === 'agent_delegated' || comment.rawLabel === 'phase_review_approved' || comment.rawLabel === 'final_review_approved' },
  { logTypes: new Set(['client_checkpoint']), matches: (comment) => comment.rawLabel.startsWith('client_checkpoint_') },
  { logTypes: new Set(['children', 'cascade', 'decomposition']), matches: (comment) => comment.rawLabel.startsWith('split_') || comment.rawLabel.startsWith('brainstorm_') },
  { logTypes: new Set(['handoff']), matches: (comment) => comment.rawLabel === 'handoff' },
];

function costChip(event: ConversationEvent): ConversationChip | null {
  const parts = [event.refs.costUsd ? `$${event.refs.costUsd}` : '', event.refs.durationSeconds !== undefined ? `${event.refs.durationSeconds}s` : ''].filter(Boolean);
  return parts.length ? { kind: 'cost', text: parts.join(' · ') } : null;
}

/**
 * Time-window fallback (design §4.4): a log within ±5s of a comment of the
 * same family only contributes cost / duration and folds as system. Human
 * comments are never swallowed by this pass.
 */
export function dedupeByFamilyWindow(events: ConversationEvent[]): ConversationEvent[] {
  const patches = new Map<string, EventPatch[]>();
  const comments = events.filter((event) => event.source === 'comment' && event.actor.type !== 'you');
  for (const event of events) {
    if (event.source !== 'log' || event.kind === 'alert') continue;
    const family = FAMILIES.find((item) => item.logTypes.has(event.refs.logType ?? ''));
    if (!family) continue;
    const target = nearest(comments.filter(family.matches), event.at, FAMILY_WINDOW_MS);
    if (!target) continue;
    const chip = costChip(event);
    if (chip) addPatch(patches, target.id, (item) => ({ ...item, chips: [...item.chips, chip] }));
    addPatch(patches, event.id, (item) => ({ ...item, kind: 'system', tone: 'neutral', hidden: true, refs: { ...item.refs, mergedInto: target.id } }));
  }
  return applyPatches(events, patches);
}

const VERDICT_ACTIONS = new Set(['approve', 'reject', 'request_help', 'block']);

/** review comments get a verdict chip from the card_action recorded next to them. */
export function attachReviewVerdicts(events: ConversationEvent[]): ConversationEvent[] {
  const patches = new Map<string, EventPatch[]>();
  const verdicts = events.filter((event) => event.source === 'action' && VERDICT_ACTIONS.has(event.rawLabel));
  for (const event of events) {
    if (event.source !== 'comment' || event.kind !== 'review') continue;
    const verdict = nearest(verdicts, event.at, FAMILY_WINDOW_MS);
    if (!verdict) continue;
    addPatch(patches, event.id, (item) => ({ ...item, chips: [...item.chips, { kind: 'verdict', text: verdict.rawLabel, status: verdict.refs.to }] }));
  }
  return applyPatches(events, patches);
}

// === Threads ================================================================

export type ThreadContext = { approvals?: ConversationApproval[] | null };

function walkToRoot(event: ConversationEvent, byRowId: Map<string, ConversationEvent>): { root: ConversationEvent; depth: number } {
  const visited = new Set<string>([event.id]);
  let current = event;
  let depth = 0;
  while (current.refs.parentCommentId && depth < MAX_THREAD_DEPTH) {
    const parent = byRowId.get(current.refs.parentCommentId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    current = parent;
    depth += 1;
  }
  return { root: current, depth };
}

function delegationMeta(root: ConversationEvent, children: ConversationEvent[]): ConversationThreadMeta {
  const reports = children.filter((child) => child.rawLabel === 'delegate_report');
  const latestReport = reports.length ? reports.reduce((best, item) => (compareEvents(item, best) > 0 ? item : best)) : undefined;
  const visibleIds = children
    .filter((child) => child === latestReport || DELEGATION_TERMINAL_ACTIONS.has(child.rawLabel) || child.rawLabel === 'delegate_review_escalated' || (!DELEGATION_PROCESS_ACTIONS.has(child.rawLabel) && child.rawLabel !== 'delegate_report' && child.kind !== 'system'))
    .map((child) => child.id);
  const retryCount = children.filter((child) => DELEGATION_RETRY_ACTIONS.has(child.rawLabel)).length;
  return {
    kind: 'delegation',
    status: root.refs.delegationStatus,
    assigneeAgentId: root.refs.assigneeAgentId,
    reviewerAgentId: root.refs.reviewerAgentId,
    reviewerScope: root.refs.reviewerScope,
    visibleIds,
    processCount: children.length - visibleIds.length,
    retryCount,
  };
}

function makeThread(kind: ConversationThreadKind, root: ConversationEvent, children: ConversationEvent[], meta: ConversationThreadMeta): ConversationItem {
  const sorted = [...children].sort(compareEvents);
  const lastActivityAt = sorted.reduce((max, child) => Math.max(max, child.at), root.at);
  return { type: 'thread', kind, root, children: sorted, lastActivityAt, meta };
}

/**
 * Groups events into containers (design §4.3): checkpoint (approvalId),
 * brainstorm round, split round, delegation / reply chains by parentCommentId.
 * Every input event appears exactly once in the output.
 */
export function assembleThreads(events: ConversationEvent[], ctx: ThreadContext = {}): ConversationItem[] {
  const claimed = new Set<string>();
  const items: ConversationItem[] = [];
  const comments = events.filter((event) => event.source === 'comment');
  const logs = events.filter((event) => event.source === 'log');
  const byRowId = new Map(comments.map((event) => [event.raw.comment?.id ?? '', event]));
  const approvalStatus = new Map((ctx.approvals ?? []).map((approval) => [approval.id, approval.status]));
  const claim = (list: ConversationEvent[]) => list.forEach((event) => claimed.add(event.id));
  const descendantsOf = (root: ConversationEvent): Array<{ event: ConversationEvent; depth: number }> => comments
    .filter((event) => event !== root && !claimed.has(event.id))
    .map((event) => ({ event, ...walkToRoot(event, byRowId) }))
    .filter((entry) => entry.root === root)
    .map((entry) => ({ event: entry.event, depth: entry.depth }));

  // 1. Checkpoint containers keyed by approvalId.
  for (const root of comments) {
    if (claimed.has(root.id) || root.rawLabel !== 'client_checkpoint_asked' || !root.refs.approvalId) continue;
    const approvalId = root.refs.approvalId;
    const answers = comments.filter((event) => !claimed.has(event.id) && event !== root && event.rawLabel === 'client_checkpoint_answered' && event.refs.approvalId === approvalId);
    const answeredAt = answers.length ? Math.max(...answers.map((event) => event.at)) : Number.POSITIVE_INFINITY;
    const reminders = logs.filter((event) => !claimed.has(event.id) && event.refs.logType === 'client_checkpoint_reminder' && event.at >= root.at && event.at <= answeredAt);
    const children = [...answers, ...reminders];
    claim([root, ...children]);
    items.push(makeThread('checkpoint', root, children, { kind: 'checkpoint', approvalId, approvalStatus: approvalStatus.get(approvalId) ?? 'unknown', reminders: reminders.length }));
  }

  // 2. Brainstorm rounds keyed by brainstorm_opened.metadata.round.
  for (const root of comments) {
    if (claimed.has(root.id) || root.rawLabel !== 'brainstorm_opened' || root.refs.round === undefined) continue;
    const round = root.refs.round;
    const questions = comments.filter((event) => !claimed.has(event.id) && event !== root && event.refs.brainstorm && event.refs.round === round && event.rawLabel === 'peer_question');
    const answers: ConversationEvent[] = [];
    for (const question of questions) {
      for (const entry of descendantsOf(question)) {
        if (claimed.has(entry.event.id) || answers.includes(entry.event)) continue;
        const proposal = entry.event.rawLabel === 'peer_answer'
          ? { ...entry.event, labelKey: labelKeyFor('brainstorm_proposal'), rawLabel: 'brainstorm_proposal', refs: { ...entry.event.refs, brainstorm: true, round, departmentName: entry.event.refs.departmentName ?? question.refs.departmentName }, depth: Math.min(entry.depth, MAX_DISPLAY_DEPTH) }
          : { ...entry.event, depth: Math.min(entry.depth, MAX_DISPLAY_DEPTH) };
        answers.push(proposal);
        claimed.add(entry.event.id);
      }
    }
    const closed = comments.filter((event) => !claimed.has(event.id) && event !== root && event.rawLabel === 'brainstorm_closed' && event.refs.round === round);
    const roundLogs = logs.filter((event) => !claimed.has(event.id) && event.refs.logType === 'decomposition' && new RegExp(`round ${round}\\b`).test(event.body));
    const children = [...questions.map((question) => ({ ...question, depth: 1 })), ...answers, ...closed, ...roundLogs];
    claim([root, ...questions, ...closed, ...roundLogs]);
    const total = root.refs.departmentIds?.length ?? questions.length;
    items.push(makeThread('brainstorm', root, children, { kind: 'brainstorm', round, answered: answers.filter((event) => event.rawLabel === 'brainstorm_proposal').length, total, closed: closed.length > 0 }));
  }

  // 3. Split rounds keyed by split_opened.metadata.round.
  const splitRoots = comments.filter((event) => !claimed.has(event.id) && event.rawLabel === 'split_opened' && event.refs.round !== undefined).sort(compareEvents);
  splitRoots.forEach((root, index) => {
    const round = root.refs.round ?? 0;
    const nextAt = splitRoots[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    const completes = comments.filter((event) => !claimed.has(event.id) && event !== root && event.rawLabel === 'split_round_complete' && event.refs.round === round);
    const roundLogs = logs.filter((event) => !claimed.has(event.id) && (event.refs.logType === 'children' || event.refs.logType === 'cascade') && event.at >= root.at && event.at < nextAt);
    const children = [...completes, ...roundLogs];
    claim([root, ...children]);
    items.push(makeThread('split', root, children, { kind: 'split', round, childIds: root.refs.childIds ?? [] }));
  });

  // 4. Delegation / reply chains by parentCommentId (root = walk up, orphans are their own root).
  const chains = new Map<string, Array<{ event: ConversationEvent; depth: number }>>();
  const roots = new Map<string, ConversationEvent>();
  for (const event of comments) {
    if (claimed.has(event.id)) continue;
    const { root, depth } = walkToRoot(event, byRowId);
    if (claimed.has(root.id)) continue;
    roots.set(root.id, root);
    if (root === event) continue;
    const list = chains.get(root.id) ?? [];
    list.push({ event, depth });
    chains.set(root.id, list);
  }
  for (const [rootId, root] of roots) {
    if (claimed.has(rootId)) continue;
    const entries = (chains.get(rootId) ?? []).filter((entry) => !claimed.has(entry.event.id));
    if (entries.length === 0 && root.kind !== 'delegation') continue;
    const children = entries.map((entry) => ({ ...entry.event, depth: Math.min(entry.depth, MAX_DISPLAY_DEPTH) }));
    claim([root, ...entries.map((entry) => entry.event)]);
    const kind: ConversationThreadKind = root.kind === 'delegation' ? 'delegation' : 'reply';
    items.push(makeThread(kind, root, children, kind === 'delegation' ? delegationMeta(root, children) : { kind: 'reply' }));
  }

  // 5. Everything else stands alone.
  for (const event of events) {
    if (claimed.has(event.id)) continue;
    claimed.add(event.id);
    items.push({ type: 'event', event });
  }
  return items;
}

// === Folding, sorting, assembly =============================================

/** Consecutive folded system rows become one `系統運行 n 則` item; nothing else is ever swallowed. */
export function foldSystemRuns(items: ConversationItem[]): ConversationItem[] {
  const out: ConversationItem[] = [];
  let run: ConversationEvent[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const tally: Record<string, number> = {};
    for (const event of run) tally[event.rawLabel] = (tally[event.rawLabel] ?? 0) + 1;
    out.push({ type: 'fold', events: run, tally });
    run = [];
  };
  for (const item of items) {
    if (item.type === 'event' && item.event.kind === 'system' && item.event.hidden) {
      run.push(item.event);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

function passesFilter(event: ConversationEvent, filter: ConversationFilter): boolean {
  if (filter === 'all' || filter === 'system') return true;
  if (filter === 'talk') return event.kind === 'message' || event.kind === 'delegation' || event.kind === 'review' || event.kind === 'product';
  if (filter === 'milestones') return event.kind === 'milestone' || event.kind === 'status' || event.kind === 'alert';
  return event.kind === 'delegation' || event.kind === 'review' || event.delegationReview;
}

function itemPassesFilter(item: ConversationItem, filter: ConversationFilter): boolean {
  if (item.type === 'event') return passesFilter(item.event, filter);
  if (item.type === 'thread') return passesFilter(item.root, filter) || item.children.some((child) => passesFilter(child, filter));
  return true;
}

function representative(item: ConversationItem): ConversationEvent | null {
  if (item.type === 'event') return item.event;
  if (item.type === 'thread') return item.root;
  return null;
}

function itemTime(item: ConversationItem, sort: ConversationSort): number {
  if (item.type === 'event') return item.event.at;
  if (item.type === 'thread') return sort === 'newest' ? item.lastActivityAt : item.root.at;
  if (item.type === 'day' || item.type === 'horizon') return item.at;
  return 0;
}

function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function parseSeen(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return parseTime(value);
}

export function buildConversation(input: ConversationInput, view: ConversationView): Conversation {
  const ctx: ConversationContext = { agents: input.agents, you: input.you };
  const seen = new Set<string>();
  const classified: ConversationEvent[] = [];
  const push = (event: ConversationEvent) => {
    if (seen.has(event.id)) return; // optimistic row already replaced by the server row
    seen.add(event.id);
    classified.push(event);
  };
  // Sealed panel seats (review_slot, metadata.sealed) never reach the board:
  // nothing to read there until the round closes, and no filter shows them.
  input.comments.filter((comment) => !isSealedComment(comment)).forEach((comment) => push(classifyComment(comment, ctx)));
  input.logs.forEach((log) => push(classifyLog(log, ctx)));
  input.actions.forEach((action) => push(classifyAction(action, ctx)));
  input.workProducts.forEach((product) => push(classifyProduct(product, ctx)));

  const { kept: exact, dropped } = dedupeByExactKeys(classified, input.agents);
  const kept = attachReviewVerdicts(dedupeByFamilyWindow(exact));

  const threaded = assembleThreads(kept, { approvals: input.approvals ?? undefined });
  const filtered = threaded.filter((item) => itemPassesFilter(item, view.filter));
  const direction = view.sort === 'newest' ? -1 : 1;
  filtered.sort((a, b) => {
    const delta = itemTime(a, view.sort) - itemTime(b, view.sort);
    if (delta !== 0) return delta * direction;
    const left = representative(a);
    const right = representative(b);
    return left && right ? compareEvents(left, right) * direction : 0;
  });

  // Day separators, unread line, horizon marker.
  const seenAt = parseSeen(input.lastSeenAt);
  const withMarkers: ConversationItem[] = [];
  let lastDay = '';
  let unreadPlaced = false;
  const isNew = (item: ConversationItem) => seenAt > 0 && itemTime(item, view.sort) > seenAt;
  filtered.forEach((item, index) => {
    const at = itemTime(item, view.sort);
    if (view.sort === 'oldest' && seenAt > 0 && !unreadPlaced && isNew(item) && index > 0) {
      withMarkers.push({ type: 'unread' });
      unreadPlaced = true;
    }
    if (at > 0) {
      const key = dayKey(at);
      if (key !== lastDay) {
        withMarkers.push({ type: 'day', at });
        lastDay = key;
      }
    }
    withMarkers.push(item);
    if (view.sort === 'newest' && seenAt > 0 && !unreadPlaced && isNew(item)) {
      const next = filtered[index + 1];
      if (next && !isNew(next)) {
        withMarkers.push({ type: 'unread' });
        unreadPlaced = true;
      }
    }
  });
  if (input.logsHasMore) {
    const logTimes = [...kept, ...dropped].filter((event) => event.source === 'log' && event.at > 0).map((event) => event.at);
    const horizon: ConversationItem = { type: 'horizon', at: logTimes.length ? Math.min(...logTimes) : 0 };
    if (view.sort === 'newest') withMarkers.push(horizon);
    else withMarkers.unshift(horizon);
  }

  const items = view.filter === 'system' ? withMarkers : foldSystemRuns(withMarkers);

  const systemCount = kept.filter((event) => event.kind === 'system' && event.hidden).length;
  const counts: ConversationCounts = {
    all: kept.length,
    conversation: kept.length - systemCount,
    talk: kept.filter((event) => passesFilter(event, 'talk')).length,
    milestones: kept.filter((event) => passesFilter(event, 'milestones')).length,
    delegationReview: kept.filter((event) => passesFilter(event, 'delegationReview')).length,
    system: systemCount,
    products: kept.filter((event) => event.kind === 'product').length,
    alerts: kept.filter((event) => event.kind === 'alert').length,
    unread: seenAt > 0 ? kept.filter((event) => event.at > seenAt).length : 0,
  };
  const latest = kept.filter((event) => event.kind !== 'system').sort(compareEvents).at(-1) ?? null;
  return { items, counts, latest };
}

// === Composer payload =======================================================

export type CommentComposerForm = {
  body: string;
  agentId: string;
  delegateAssigneeId: string;
  delegateReviewerId: string;
  delegateScope: ReviewerScope;
};
export type CommentPayload = {
  body: string;
  action: CommentActionMode;
  agentId: string | null;
  assigneeAgentId: string | null;
  reviewerAgentId: string | null;
  reviewerScope: ReviewerScope | null;
};

/** Bit-identical to the body kanban-board.tsx `addComment` posts today (parity test B). */
export function buildCommentPayload(mode: CommentActionMode, form: CommentComposerForm, card: Pick<Card, 'assigneeId' | 'reviewerId'>): CommentPayload {
  const effectiveAction: CommentActionMode = form.agentId ? 'agent_note' : mode;
  return {
    body: form.body.trim(),
    action: effectiveAction,
    agentId: form.agentId || null,
    assigneeAgentId: effectiveAction === 'delegate_to_agent' ? form.delegateAssigneeId : null,
    reviewerAgentId: effectiveAction === 'delegate_to_agent' ? form.delegateReviewerId || card.assigneeId || card.reviewerId || null : null,
    reviewerScope: effectiveAction === 'delegate_to_agent' ? form.delegateScope : null,
  };
}

// === Mentions ===============================================================

export type MentionAgent = { slug: string; name: string };
export type MentionSegment = { type: 'text' | 'mention'; text: string; slug?: string; known?: boolean };

// Same token rule as the server (card-mentions.ts MENTION_PATTERN): "@" at the
// start or after whitespace / ( （ , ， : ： ; ； 「 [, then [\p{L}\p{N}_.-]{1,64}.
// "a@b.com" does not match because the "@" follows a letter; "@ben and 。@ben
// do not match either — the server never delivers those, so they must not be
// shown as sent mentions.
const MENTION_RE = new RegExp(`(^|[${MENTION_LEAD_CHARS}])@([\\p{L}\\p{N}_.-]{1,64})`, 'gu');

export function highlightMentions(body: string, agents: MentionAgent[] = []): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const known = new Set(agents.map((agent) => agent.slug.toLowerCase()));
  let cursor = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const index = match.index ?? 0;
    const lead = match[1] ?? '';
    const slug = match[2] ?? '';
    const start = index + lead.length;
    if (start > cursor) segments.push({ type: 'text', text: body.slice(cursor, start) });
    segments.push({ type: 'mention', text: `@${slug}`, slug, known: known.has(slug.toLowerCase()) || slug.toLowerCase() === 'client' });
    cursor = start + slug.length + 1;
  }
  if (cursor < body.length) segments.push({ type: 'text', text: body.slice(cursor) });
  if (segments.length === 0 && body.length > 0) segments.push({ type: 'text', text: body });
  return segments;
}

export function mentionCandidates<T extends MentionAgent>(query: string, agents: T[], limit = 6): T[] {
  const needle = query.trim().toLowerCase();
  const matches = agents.filter((agent) => !needle || agent.slug.toLowerCase().startsWith(needle) || agent.name.toLowerCase().startsWith(needle));
  return matches.slice(0, Math.max(0, limit));
}

// === Render window ==========================================================

export const EMPTY_CONVERSATION: Conversation = {
  items: [],
  counts: { all: 0, conversation: 0, talk: 0, milestones: 0, delegationReview: 0, system: 0, products: 0, alerts: 0, unread: 0 },
  latest: null,
};

/** Top-level items the 60-item window counts; day / unread / horizon markers ride along with their rows. */
export const CONVERSATION_PAGE_SIZE = 60;
const ROW_ITEM_TYPES = new Set<ConversationItem['type']>(['event', 'thread', 'fold']);
export type ConversationWindow = { visible: ConversationItem[]; hiddenCount: number };

export function isConversationRow(item: ConversationItem): boolean {
  return ROW_ITEM_TYPES.has(item.type);
}

/**
 * The render window (design §4.7): newest-first keeps the head of the list,
 * oldest-first the tail. Markers that introduce a visible row stay with it;
 * the horizon only appears once every row is visible, because the hidden rows
 * sit between it and the window.
 */
export function sliceConversationWindow(items: ConversationItem[], sort: ConversationSort, limit: number): ConversationWindow {
  const cap = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : CONVERSATION_PAGE_SIZE));
  const rowIndexes: number[] = [];
  items.forEach((item, index) => { if (isConversationRow(item)) rowIndexes.push(index); });
  if (rowIndexes.length <= cap) return { visible: items, hiddenCount: 0 };
  const hiddenCount = rowIndexes.length - cap;
  if (sort === 'newest') return { visible: items.slice(0, rowIndexes[cap - 1]! + 1), hiddenCount };
  let first = rowIndexes[rowIndexes.length - cap]!;
  while (first > 0) {
    const previous = items[first - 1]!;
    if (isConversationRow(previous) || previous.type === 'horizon') break;
    first -= 1;
  }
  return { visible: items.slice(first), hiddenCount };
}

/** Oldest timestamp among the rows these items show; 0 when none carries one. */
export function oldestItemTime(items: ConversationItem[]): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const times = item.type === 'event'
      ? [item.event.at]
      : item.type === 'thread'
        ? [item.root.at, ...item.children.map((child) => child.at)]
        : item.type === 'fold'
          ? item.events.map((event) => event.at)
          : [];
    for (const time of times) if (time > 0 && time < oldest) oldest = time;
  }
  return Number.isFinite(oldest) ? oldest : 0;
}
