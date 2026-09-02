'use client';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleHelp, ExternalLink, Flag, GitBranch, Milestone, Package, ShieldCheck, Sparkles, Split, TriangleAlert, type LucideIcon } from 'lucide-react';
import {
  CONVERSATION_PAGE_SIZE,
  highlightMentions,
  isConversationRow,
  oldestItemTime,
  sliceConversationWindow,
  type Conversation,
  type ConversationActor,
  type ConversationChip,
  type ConversationEvent,
  type ConversationFilter,
  type ConversationItem,
  type ConversationSort,
  type ConversationView,
} from '@/lib/card-conversation';
import { useLocale } from '@/lib/locale-context';
import { formatRelative } from '@/lib/relative-time';
import { childChipTone } from './card-overview-chips';
import { type Agent, type Card, type CardStatus, type CardTabKey, type TaskLog, statusLabels } from './card-types';

// The 對話 tab: renders whatever buildConversation() produced. Nothing here
// classifies or de-duplicates — the pure model owns the rules, this file owns
// the pixels. Rail = .ticket-entry-rail, avatars = .chat-avatar, everything
// else .conv-*. Whole-panel scrolling; the scroll container is .detail-panel.

type ThreadItem = Extract<ConversationItem, { type: 'thread' }>;
type FoldItem = Extract<ConversationItem, { type: 'fold' }>;
type Translate = (key: string) => string;
type TranslateVars = (key: string, vars?: Record<string, string | number>) => string;
type RenderCtx = {
  t: Translate;
  tf: TranslateVars;
  locale: string;
  now: number;
  agents: Agent[];
  cards: Card[];
  mentionAgents: Array<{ slug: string; name: string }>;
  openCard: (card: Card) => void;
  /** Scrolls the panel to the needs-you strip (the checkpoint's 在上方回答). */
  answerAbove: () => void;
};

const FILTERS: ConversationFilter[] = ['all', 'talk', 'milestones', 'delegationReview', 'system'];
const ANSWERED_MENTION = new Set(['done', 'submitted', 'answered']);
const FAILED_MENTION = new Set(['failed', 'timeout', 'cancelled', 'error']);

// --- small helpers ------------------------------------------------------------------

function labelOf(event: ConversationEvent, t: Translate): string {
  const translated = t(event.labelKey);
  return translated === event.labelKey ? event.rawLabel : translated;
}

function actorName(actor: ConversationActor, t: Translate): string {
  if (actor.type === 'you') return t('common.you');
  if (actor.type === 'system') return t('common.system');
  return actor.name;
}

function actorLine(actor: ConversationActor, t: Translate): string {
  const name = actorName(actor, t);
  return actor.type === 'agent' && actor.role ? `${name} · ${actor.role}` : name;
}

function initialOf(actor: ConversationActor, t: Translate): string {
  const name = actorName(actor, t).trim();
  const first = [...name][0];
  return first ? first.toUpperCase() : '?';
}

function statusText(status: string | undefined, locale: string): string {
  return status ? statusLabels[status as CardStatus]?.[locale] ?? status : '';
}

function agentNameOf(agents: Agent[], id: string | undefined): string {
  if (!id) return '';
  return agents.find((agent) => agent.id === id)?.name ?? id.slice(0, 8);
}

function timeTitle(createdAt: string): string {
  const time = Date.parse(createdAt);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '';
}

function depthStyle(depth: number): CSSProperties | undefined {
  return depth > 0 ? ({ '--depth': Math.min(depth, 3) } as CSSProperties) : undefined;
}

function relativeAt(at: number, ctx: RenderCtx): string {
  return at > 0 ? formatRelative(new Date(at), ctx.now, ctx.locale) || '—' : '—';
}

// --- primitives -----------------------------------------------------------------------

function Rail({ tone }: { tone: string }) {
  return <div className={`ticket-entry-rail conv-rail ${tone}`}><span /></div>;
}

function When({ event, ctx }: { event: ConversationEvent; ctx: RenderCtx }) {
  const relative = event.createdAt ? formatRelative(event.createdAt, ctx.now, ctx.locale) : '';
  return <time className="conv-time" dateTime={event.createdAt || undefined} title={timeTitle(event.createdAt)}>{relative || '—'}</time>;
}

function Avatar({ actor, ctx }: { actor: ConversationActor; ctx: RenderCtx }) {
  return <span className={`chat-avatar conv-avatar ${actor.type}`} aria-hidden="true">{initialOf(actor, ctx.t)}</span>;
}

function Icon({ icon: Glyph, tone }: { icon: LucideIcon; tone: string }) {
  return <span className={`conv-icon ${tone}`} aria-hidden="true"><Glyph size={14} /></span>;
}

/** A body with @mentions bolded and a 12-line clamp; the toggle shows only when the clamp bites. */
function Body({ text, ctx, clamp = true, className = '' }: { text: string; ctx: RenderCtx; clamp?: boolean; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (expanded || !clamp) return;
    const element = ref.current;
    if (!element) return;
    setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [text, expanded, clamp]);
  if (!text) return null;
  const segments = highlightMentions(text, ctx.mentionAgents);
  return <>
    <p ref={ref} className={`conv-body ${className} ${clamp && !expanded ? 'clamped' : ''}`}>
      {segments.map((segment, index) => segment.type === 'mention'
        ? <b key={index} className={`conv-mention ${segment.known ? '' : 'unknown'}`}>{segment.text}</b>
        : <Fragment key={index}>{segment.text}</Fragment>)}
    </p>
    {clamp && (expanded || overflowing) && <button type="button" className="overview-body-toggle conv-body-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? ctx.t('kanban.bodyCollapse') : ctx.t('kanban.bodyExpand')}</button>}
  </>;
}

function Chip({ chip, ctx }: { chip: ConversationChip; ctx: RenderCtx }) {
  switch (chip.kind) {
    case 'consequence':
      return <span className="conv-chip consequence">{ctx.tf('kanban.convConsequence', { status: statusText(chip.status ?? chip.text, ctx.locale) })}</span>;
    case 'queued':
      return <span className="conv-chip queued">{ctx.t('kanban.convQueuedForAgent')}</span>;
    case 'escalated':
      return <span className="conv-chip queued">{ctx.tf('kanban.convEscalatedTo', { name: chip.text || ctx.t('kanban.reviewer') })}</span>;
    case 'child':
    case 'parent': {
      const card = chip.cardId ? ctx.cards.find((item) => item.id === chip.cardId) : undefined;
      const prefix = chip.kind === 'child' ? ctx.t('kanban.convOpenChild') : ctx.t('kanban.convOpenParent');
      const title = card?.title ?? (chip.cardId ?? chip.text).slice(0, 8);
      const tone = card ? childChipTone(card.columnStatus) : 'neutral';
      return <button type="button" className={`conv-chip child ${tone}`} disabled={!card} title={card ? `${title} · ${statusText(card.columnStatus, ctx.locale)}` : undefined} onClick={() => { if (card) ctx.openCard(card); }}>{prefix} ▸ {title}</button>;
    }
    case 'verdict': {
      const key = `kanban.convVerdict.${chip.text}`;
      const translated = ctx.t(key);
      return <span className={`conv-chip verdict ${chip.text}`}>{translated === key ? chip.text : translated}</span>;
    }
    case 'reminded':
      return <span className="conv-chip">{ctx.tf('kanban.convReminded', { count: chip.text })}</span>;
    default:
      return <span className={`conv-chip ${chip.kind}`}>{chip.text}</span>;
  }
}

function Chips({ event, ctx, extra }: { event: ConversationEvent; ctx: RenderCtx; extra?: ReactNode }) {
  const mentionsClient = event.kind === 'message' && event.actor.type !== 'you' && highlightMentions(event.body, ctx.mentionAgents).some((segment) => segment.type === 'mention' && segment.slug?.toLowerCase() === 'client');
  if (event.chips.length === 0 && !extra && !mentionsClient) return null;
  return <div className="conv-chips">
    {event.chips.map((chip, index) => <Chip key={`${chip.kind}-${index}`} chip={chip} ctx={ctx} />)}
    {mentionsClient && <span className="conv-chip mention-state client">{ctx.t('kanban.convMentionClient')}</span>}
    {extra}
  </div>;
}

// --- rows -----------------------------------------------------------------------------

export function ConversationMessage({ event, ctx, depth = 0, extraChips }: { event: ConversationEvent; ctx: RenderCtx; depth?: number; extraChips?: ReactNode }) {
  return <article className={`conv-row message ${event.kind} ${event.tone} ${depth > 0 ? 'conv-reply' : ''}`} style={depthStyle(depth)} id={`conv-${event.id}`}>
    <Rail tone={event.tone} />
    <div className="conv-main">
      <header className="conv-head">
        <Avatar actor={event.actor} ctx={ctx} />
        <span className="conv-who">
          <b>{actorLine(event.actor, ctx.t)}</b>
          <span className="conv-label">{labelOf(event, ctx.t)}</span>
          {event.refs.via && <span className="conv-via">{event.refs.via}</span>}
        </span>
        <When event={event} ctx={ctx} />
      </header>
      <Body text={event.body} ctx={ctx} />
      <Chips event={event} ctx={ctx} extra={extraChips} />
    </div>
  </article>;
}

export function ConversationReview({ event, ctx, depth = 0 }: { event: ConversationEvent; ctx: RenderCtx; depth?: number }) {
  return <article className={`conv-row review ${event.tone} ${depth > 0 ? 'conv-reply' : ''}`} style={depthStyle(depth)} id={`conv-${event.id}`}>
    <Rail tone="review" />
    <div className="conv-main">
      <header className="conv-head">
        {event.actor.type === 'system' ? <Icon icon={ShieldCheck} tone="review" /> : <Avatar actor={event.actor} ctx={ctx} />}
        <span className="conv-who">
          <b>{actorLine(event.actor, ctx.t)}</b>
          <span className="conv-label">{labelOf(event, ctx.t)}</span>
        </span>
        <When event={event} ctx={ctx} />
      </header>
      <Body text={event.body} ctx={ctx} />
      <Chips event={event} ctx={ctx} />
    </div>
  </article>;
}

export function ConversationMilestone({ event, ctx, icon, extra }: { event: ConversationEvent; ctx: RenderCtx; icon: LucideIcon; extra?: ReactNode }) {
  const childChips = event.refs.childIds?.length
    ? event.refs.childIds.filter((id) => id !== event.refs.childCardId).map((id) => <Chip key={id} chip={{ kind: 'child', text: id, cardId: id }} ctx={ctx} />)
    : null;
  return <article className={`conv-row ${event.kind} ${event.tone}`} id={`conv-${event.id}`}>
    <Rail tone={event.tone} />
    <div className="conv-main">
      <header className="conv-head">
        <Icon icon={icon} tone={event.tone} />
        <span className="conv-who"><b>{actorLine(event.actor, ctx.t)} · {labelOf(event, ctx.t)}</b></span>
        <When event={event} ctx={ctx} />
      </header>
      <Body text={event.body} ctx={ctx} />
      <Chips event={event} ctx={ctx} extra={childChips || extra ? <>{childChips}{extra}</> : undefined} />
    </div>
  </article>;
}

export function ConversationStatusRow({ event, ctx }: { event: ConversationEvent; ctx: RenderCtx }) {
  const from = statusText(event.refs.from, ctx.locale);
  const to = statusText(event.refs.to, ctx.locale);
  const transition = Boolean(from || to);
  const line = transition ? ctx.tf('kanban.convStage', { from: from || '—', to: to || '—' }) : labelOf(event, ctx.t);
  const rawTransition = `${event.refs.from ?? 'none'} -> ${event.refs.to ?? 'none'}`;
  const body = event.body && event.body !== rawTransition ? event.body : '';
  return <div className={`conv-row status ${event.tone}`} id={`conv-${event.id}`}>
    <Rail tone={event.tone} />
    <div className="conv-main conv-inline">
      <span className="conv-status-line">
        <b>{line}</b> · {actorLine(event.actor, ctx.t)}
        {transition && <span className="conv-label">{labelOf(event, ctx.t)}</span>}
      </span>
      <When event={event} ctx={ctx} />
      {body && <Body text={body} ctx={ctx} className="muted" />}
      <Chips event={event} ctx={ctx} />
    </div>
  </div>;
}

function ConversationSystemRow({ event, ctx }: { event: ConversationEvent; ctx: RenderCtx }) {
  const lines = event.body.split('\n').filter(Boolean);
  const first = lines[0] ?? '';
  return <div className={`conv-row system ${event.tone}`} id={`conv-${event.id}`}>
    <Rail tone="system" />
    <div className="conv-main conv-inline">
      <span className="conv-status-line" title={lines.length > 1 ? event.body : undefined}>
        <span className="conv-label">{labelOf(event, ctx.t)}</span>
        {event.refs.logStatus && event.refs.logStatus !== 'success' && <span className="conv-via">{event.refs.logStatus}</span>}
        {' '}{first}
      </span>
      <When event={event} ctx={ctx} />
      <Chips event={event} ctx={ctx} />
    </div>
  </div>;
}

export function ConversationProduct({ event, ctx }: { event: ConversationEvent; ctx: RenderCtx }) {
  const product = event.raw.product;
  return <article className="conv-row product" id={`conv-${event.id}`}>
    <Rail tone="product" />
    <div className="conv-main">
      <header className="conv-head">
        <Icon icon={Package} tone="product" />
        <span className="conv-who">
          <b>{event.rawLabel} · {product?.title ?? ''}</b>
          <span className="conv-label">{actorLine(event.actor, ctx.t)}</span>
        </span>
        <When event={event} ctx={ctx} />
      </header>
      {product?.summary && <Body text={product.summary} ctx={ctx} />}
      {event.refs.url && <a className="btn conv-open-product" href={event.refs.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {ctx.t('kanban.openProduct')}</a>}
    </div>
  </article>;
}

function ConversationMentionRow({ event, ctx, answered, rootBody }: { event: ConversationEvent; ctx: RenderCtx; answered: boolean; rootBody: string }) {
  const status = (event.refs.delegationStatus ?? '').toLowerCase();
  const state = answered || ANSWERED_MENTION.has(status) ? 'answered' : FAILED_MENTION.has(status) ? 'failed' : 'waiting';
  const name = agentNameOf(ctx.agents, event.refs.assigneeAgentId) || (event.refs.targetSlug ? `@${event.refs.targetSlug}` : ctx.t('common.agent'));
  const text = state === 'answered' ? ctx.tf('kanban.convMentionAnswered', { name }) : state === 'failed' ? ctx.tf('kanban.convMentionFailed', { name }) : ctx.tf('kanban.convMentionWaiting', { name });
  const showBody = event.body.trim().length > 0 && event.body.trim() !== rootBody.trim();
  return <div className={`conv-row mention-row conv-reply ${state}`} style={depthStyle(event.depth ?? 1)} id={`conv-${event.id}`}>
    <Rail tone={state === 'failed' ? 'danger' : state === 'answered' ? 'success' : 'accent'} />
    <div className="conv-main conv-inline">
      <span className="conv-status-line">
        → <b className="conv-mention">@{event.refs.targetSlug ?? name}</b> · <span className={`conv-chip mention-state ${state}`}>{text}</span>
      </span>
      <When event={event} ctx={ctx} />
      {showBody && <Body text={event.body} ctx={ctx} className="muted" />}
    </div>
  </div>;
}

function renderEvent(event: ConversationEvent, ctx: RenderCtx, depth = 0): ReactNode {
  switch (event.kind) {
    case 'message':
    case 'delegation':
      return <ConversationMessage key={event.id} event={event} ctx={ctx} depth={depth} />;
    case 'review':
      return <ConversationReview key={event.id} event={event} ctx={ctx} depth={depth} />;
    case 'milestone':
      return <ConversationMilestone key={event.id} event={event} ctx={ctx} icon={Milestone} />;
    case 'alert':
      return <ConversationMilestone key={event.id} event={event} ctx={ctx} icon={TriangleAlert} />;
    case 'status':
      return <ConversationStatusRow key={event.id} event={event} ctx={ctx} />;
    case 'product':
      return <ConversationProduct key={event.id} event={event} ctx={ctx} />;
    default:
      return <ConversationSystemRow key={event.id} event={event} ctx={ctx} />;
  }
}

// --- containers -------------------------------------------------------------------------

function ThreadShell({ className, icon, tone, title, meta, children, defaultOpen = true }: { className: string; icon: LucideIcon; tone: string; title: ReactNode; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`conv-thread ${className}`}>
    <header className="conv-thread-head">
      <button type="button" className="conv-thread-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      <Icon icon={icon} tone={tone} />
      <span className="conv-thread-title">{title}</span>
      {meta && <span className="conv-thread-meta">{meta}</span>}
    </header>
    {open && <div className="conv-children">{children}</div>}
  </section>;
}

function ProcessToggle({ count, open, onToggle, ctx }: { count: number; open: boolean; onToggle: () => void; ctx: RenderCtx }) {
  if (count === 0) return null;
  return <button type="button" className="conv-fold-toggle" aria-expanded={open} onClick={onToggle}>
    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    <span>{open ? ctx.t('kanban.bodyCollapse') : ctx.tf('kanban.convShowProcess', { count })}</span>
  </button>;
}

export function ConversationDelegationThread({ item, ctx }: { item: ThreadItem; ctx: RenderCtx }) {
  const [showProcess, setShowProcess] = useState(false);
  if (item.meta.kind !== 'delegation') return null;
  const meta = item.meta;
  const assignee = agentNameOf(ctx.agents, meta.assigneeAgentId) || ctx.t('kanban.noneAssigned');
  const reviewer = agentNameOf(ctx.agents, meta.reviewerAgentId);
  const scope = meta.reviewerScope === 'final' ? ctx.t('kanban.finalReviewer') : ctx.t('kanban.phaseReviewer');
  const title = `${ctx.tf('kanban.convDelegatedTo', { author: actorName(item.root.actor, ctx.t), assignee })}${reviewer ? `（${scope} ${reviewer}）` : ''}`;
  const visible = new Set(meta.visibleIds);
  const shown = item.children.filter((child) => visible.has(child.id));
  const process = item.children.filter((child) => !visible.has(child.id));
  return <ThreadShell className={`delegation ${item.root.tone}`} icon={GitBranch} tone={item.root.tone} title={title} meta={<>
    {meta.status && <span className={`status-pill conv-status-pill ${meta.status}`}>{meta.status}</span>}
    {meta.retryCount > 0 && <span className="conv-chip queued">{ctx.tf('kanban.convRetries', { count: meta.retryCount })}</span>}
    <span className="conv-thread-last">{ctx.t('kanban.convLastActivity')} {relativeAt(item.lastActivityAt, ctx)}</span>
  </>}>
    {renderEvent(item.root, ctx)}
    {shown.map((child) => renderEvent(child, ctx, child.depth ?? 1))}
    <ProcessToggle count={process.length} open={showProcess} onToggle={() => setShowProcess((value) => !value)} ctx={ctx} />
    {showProcess && process.map((child) => renderEvent(child, ctx, child.depth ?? 1))}
  </ThreadShell>;
}

export function ConversationRound({ item, ctx }: { item: ThreadItem; ctx: RenderCtx }) {
  const [showProcess, setShowProcess] = useState(false);
  const meta = item.meta;
  if (meta.kind === 'brainstorm') {
    const proposals = item.children.filter((child) => child.rawLabel === 'brainstorm_proposal');
    const closing = item.children.filter((child) => child.rawLabel === 'brainstorm_closed');
    const process = item.children.filter((child) => !proposals.includes(child) && !closing.includes(child));
    return <ThreadShell className="round brainstorm" icon={Sparkles} tone="accent" title={ctx.tf('kanban.convBrainstormRound', { round: meta.round, answered: meta.answered, total: meta.total })} meta={<>
      <span className={`conv-chip ${meta.closed ? '' : 'queued'}`}>{meta.closed ? ctx.t('kanban.convRoundClosed') : ctx.t('kanban.convRoundOpen')}</span>
      <span className="conv-thread-last">{ctx.t('kanban.convLastActivity')} {relativeAt(item.lastActivityAt, ctx)}</span>
    </>}>
      {item.root.body && <div className="conv-round-intro"><Body text={item.root.body} ctx={ctx} /></div>}
      {proposals.map((proposal) => <ConversationMessage key={proposal.id} event={proposal} ctx={ctx} depth={1} extraChips={proposal.refs.departmentName ? <span className="conv-chip child">{proposal.refs.departmentName}</span> : undefined} />)}
      {closing.map((row) => <ConversationMilestone key={row.id} event={row} ctx={ctx} icon={Flag} />)}
      <ProcessToggle count={process.length} open={showProcess} onToggle={() => setShowProcess((value) => !value)} ctx={ctx} />
      {showProcess && process.map((child) => renderEvent(child, ctx, child.depth ?? 1))}
    </ThreadShell>;
  }
  if (meta.kind === 'split') {
    const completes = item.children.filter((child) => child.rawLabel === 'split_round_complete');
    const process = item.children.filter((child) => !completes.includes(child));
    return <ThreadShell className="round split" icon={Split} tone="accent" title={ctx.tf('kanban.convSplitRound', { round: meta.round, count: meta.childIds.length })} meta={<span className="conv-thread-last">{ctx.t('kanban.convLastActivity')} {relativeAt(item.lastActivityAt, ctx)}</span>}>
      {item.root.body && <div className="conv-round-intro"><Body text={item.root.body} ctx={ctx} /></div>}
      {meta.childIds.length > 0 && <div className="conv-chips conv-round-intro">{meta.childIds.map((id) => <Chip key={id} chip={{ kind: 'child', text: id, cardId: id }} ctx={ctx} />)}</div>}
      {completes.map((row) => <ConversationMilestone key={row.id} event={row} ctx={ctx} icon={Flag} />)}
      <ProcessToggle count={process.length} open={showProcess} onToggle={() => setShowProcess((value) => !value)} ctx={ctx} />
      {showProcess && process.map((child) => renderEvent(child, ctx, child.depth ?? 1))}
    </ThreadShell>;
  }
  return null;
}

export function ConversationCheckpoint({ item, ctx }: { item: ThreadItem; ctx: RenderCtx }) {
  if (item.meta.kind !== 'checkpoint') return null;
  const meta = item.meta;
  const answers = item.children.filter((child) => child.rawLabel === 'client_checkpoint_answered');
  const state = meta.approvalStatus === 'pending' ? 'pending' : meta.approvalStatus === 'answered' || answers.length > 0 ? 'answered' : meta.approvalStatus === 'cancelled' ? 'withdrawn' : 'unknown';
  return <section className={`conv-thread checkpoint ${state}`}>
    <ConversationMilestone event={item.root} ctx={ctx} icon={CircleHelp} extra={<>
      {state === 'pending' && <button type="button" className="btn conv-answer-above" onClick={ctx.answerAbove}>{ctx.t('kanban.convAnswerAbove')}</button>}
      {state === 'answered' && <span className="conv-chip verdict approve">{ctx.t('kanban.convAnswered')}</span>}
      {state === 'withdrawn' && <span className="conv-chip">{ctx.t('kanban.convWithdrawn')}</span>}
      {meta.reminders > 0 && <span className="conv-chip">{ctx.tf('kanban.convReminded', { count: meta.reminders })}</span>}
    </>} />
    {answers.length > 0 && <div className="conv-children">{answers.map((answer) => renderEvent(answer, ctx, 1))}</div>}
  </section>;
}

function ConversationReplyThread({ item, ctx }: { item: ThreadItem; ctx: RenderCtx }) {
  return <div className="conv-thread reply">
    {renderEvent(item.root, ctx)}
    <div className="conv-children">
      {item.children.map((child) => {
        if (child.rawLabel === 'mention_question') {
          const rowId = child.raw.comment?.id;
          const answered = item.children.some((other) => other.rawLabel === 'peer_answer' && other.refs.parentCommentId === rowId);
          return <ConversationMentionRow key={child.id} event={child} ctx={ctx} answered={answered} rootBody={item.root.body} />;
        }
        return renderEvent(child, ctx, child.depth ?? 1);
      })}
    </div>
  </div>;
}

function ConversationThread({ item, ctx }: { item: ThreadItem; ctx: RenderCtx }) {
  if (item.kind === 'delegation') return <ConversationDelegationThread item={item} ctx={ctx} />;
  if (item.kind === 'brainstorm' || item.kind === 'split') return <ConversationRound item={item} ctx={ctx} />;
  if (item.kind === 'checkpoint') return <ConversationCheckpoint item={item} ctx={ctx} />;
  return <ConversationReplyThread item={item} ctx={ctx} />;
}

export function ConversationFold({ item, ctx, loaded }: { item: FoldItem; ctx: RenderCtx; loaded: boolean }) {
  const [open, setOpen] = useState(false);
  const tally = Object.entries(item.tally).map(([raw, count]) => {
    const sample = item.events.find((event) => event.rawLabel === raw);
    const label = sample ? labelOf(sample, ctx.t) : raw;
    return count > 1 ? `${label} ×${count}` : label;
  }).join(ctx.t('kanban.listSeparator'));
  return <div className="conv-fold">
    <button type="button" className="conv-fold-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span>{ctx.tf('kanban.convSystemFold', { count: item.events.length })}{loaded ? ` ${ctx.t('kanban.convLoaded')}` : ''}</span>
      <span className="conv-fold-tally">({tally})</span>
    </button>
    {open && <div className="conv-fold-body">{item.events.map((event) => <ConversationSystemRow key={event.id} event={event} ctx={ctx} />)}</div>}
  </div>;
}

function ConversationDay({ at, ctx }: { at: number; ctx: RenderCtx }) {
  const date = new Date(at);
  const today = new Date(ctx.now);
  const yesterday = new Date(ctx.now - 86_400_000);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const label = sameDay(date, today) ? ctx.t('kanban.convToday') : sameDay(date, yesterday) ? ctx.t('kanban.convYesterday') : date.toLocaleDateString(ctx.locale, { year: 'numeric', month: 'short', day: 'numeric' });
  return <div className="conv-day" role="separator"><span>{label}</span></div>;
}

export function ConversationHorizon({ ctx, disabled, onLoad }: { ctx: RenderCtx; disabled: boolean; onLoad: () => void }) {
  return <div className="conv-horizon" role="note">
    <span>{ctx.t('kanban.convOlderLogsMissing')}</span>
    <button type="button" className="overview-body-toggle" disabled={disabled} onClick={onLoad}>{ctx.t('kanban.loadOlderLogs')}</button>
  </div>;
}

// --- the tab -----------------------------------------------------------------------------

export type CardConversationProps = {
  selected: Card;
  cards: Card[];
  agents: Agent[];
  conversation: Conversation;
  view: ConversationView;
  setView: (view: ConversationView) => void;
  logs: TaskLog[];
  logsHasMore: boolean;
  tabLoading: Record<CardTabKey, boolean>;
  loadMoreCardLogs: (card: Card) => Promise<void>;
  openCard: (card: Card) => void;
};

export function CardConversation({ selected, cards, agents, conversation, view, setView, logs, logsHasMore, tabLoading, loadMoreCardLogs, openCard }: CardConversationProps) {
  const { t, tf, locale } = useLocale();
  const now = Date.now();
  const listRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLElement>(null);
  const [limit, setLimit] = useState(CONVERSATION_PAGE_SIZE);
  const [pendingNew, setPendingNew] = useState(0);
  const anchorRef = useRef<{ height: number; top: number; sort: ConversationSort } | null>(null);
  const latestRef = useRef<{ cardId: string; latestId: string | null; all: number } | null>(null);

  useEffect(() => {
    setLimit(CONVERSATION_PAGE_SIZE);
    setPendingNew(0);
    anchorRef.current = null;
  }, [selected.id, view.filter, view.sort]);

  const mentionAgents = useMemo(() => agents.filter((agent) => agent.slug).map((agent) => ({ slug: agent.slug ?? '', name: agent.name })), [agents]);
  // The panel is the scroller. Resolved from the tab section, which is always
  // rendered, so the scroll listener below exists before any rows arrive (the
  // list itself renders only once there are rows). Without a panel, the list.
  const scrollContainer = () => (tabRef.current ?? listRef.current)?.closest<HTMLElement>('.detail-panel') ?? listRef.current ?? null;
  const answerAbove = () => {
    const panel = scrollContainer();
    const cta = panel?.querySelector<HTMLElement>('.overview-cta');
    if (!cta) return;
    cta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cta.querySelector<HTMLElement>('button, textarea, input')?.focus({ preventScroll: true });
  };
  const ctx: RenderCtx = { t, tf, locale, now, agents, cards, mentionAgents, openCard, answerAbove };

  const windowed = useMemo(() => sliceConversationWindow(conversation.items, view.sort, limit), [conversation.items, view.sort, limit]);
  const oldestLogAt = useMemo(() => logs.reduce((oldest, log) => {
    const time = Date.parse(log.createdAt ?? '');
    return Number.isFinite(time) && time > 0 && time < oldest ? time : oldest;
  }, Number.POSITIVE_INFINITY), [logs]);

  // New-events pill: counts arrivals while the "new" end of the list is scrolled out of view.
  const newEndInView = () => {
    const container = scrollContainer();
    const list = listRef.current;
    if (!container || !list) return true;
    const outer = container.getBoundingClientRect();
    const inner = list.getBoundingClientRect();
    return view.sort === 'newest' ? inner.top >= outer.top - 8 : inner.bottom <= outer.bottom + 8;
  };
  useEffect(() => {
    const previous = latestRef.current;
    const latestId = conversation.latest?.id ?? null;
    latestRef.current = { cardId: selected.id, latestId, all: conversation.counts.all };
    if (!previous || previous.cardId !== selected.id || previous.latestId === null || previous.latestId === latestId) return;
    if (newEndInView()) return;
    setPendingNew((count) => count + Math.max(1, conversation.counts.all - previous.all));
  }, [conversation, selected.id]);
  useEffect(() => {
    const container = scrollContainer();
    if (!container) return;
    const onScroll = () => { if (newEndInView()) setPendingNew(0); };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [view.sort, selected.id]);
  function jumpToNew() {
    const list = listRef.current;
    if (list) {
      if (view.sort === 'newest') list.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else (list.lastElementChild ?? list).scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    setPendingNew(0);
  }

  // Oldest-first prepends keep the reader's rows where they were.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const container = scrollContainer();
    if (!container || anchor.sort !== view.sort) return;
    container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
  }, [windowed.visible, view.sort]);

  function showOlder() {
    const container = scrollContainer();
    if (view.sort === 'oldest' && container) anchorRef.current = { height: container.scrollHeight, top: container.scrollTop, sort: view.sort };
    const nextLimit = limit + CONVERSATION_PAGE_SIZE;
    if (windowed.hiddenCount > 0) setLimit(nextLimit);
    if (!logsHasMore || tabLoading.logs) return;
    const next = sliceConversationWindow(conversation.items, view.sort, nextLimit);
    const oldestNext = oldestItemTime(next.visible);
    if (next.hiddenCount === 0 || !Number.isFinite(oldestLogAt) || oldestNext <= oldestLogAt) void loadMoreCardLogs(selected);
  }

  const filterCount = (filter: ConversationFilter): number => {
    if (filter === 'talk') return conversation.counts.talk;
    if (filter === 'milestones') return conversation.counts.milestones;
    if (filter === 'delegationReview') return conversation.counts.delegationReview;
    if (filter === 'system') return conversation.counts.all;
    return conversation.counts.conversation;
  };
  const loading = conversation.counts.all === 0 && (tabLoading.comments || tabLoading.logs || tabLoading.actions);
  const empty = !loading && conversation.counts.all === 0;
  const filteredEmpty = !loading && !empty && !windowed.visible.some(isConversationRow);
  const showOlderButton = windowed.hiddenCount > 0
    ? <button type="button" className="btn conv-show-older" disabled={tabLoading.logs} onClick={showOlder}>{tf('kanban.convShowOlder', { count: windowed.hiddenCount })}</button>
    : null;

  function renderItem(item: ConversationItem): ReactNode {
    switch (item.type) {
      case 'event': return renderEvent(item.event, ctx);
      case 'thread': return <ConversationThread key={`thread-${item.root.id}`} item={item} ctx={ctx} />;
      case 'fold': return <ConversationFold key={`fold-${item.events[0]?.id ?? ''}`} item={item} ctx={ctx} loaded={logsHasMore} />;
      case 'day': return <ConversationDay key={`day-${item.at}`} at={item.at} ctx={ctx} />;
      case 'unread': return <div key="unread" className="conv-unread" role="separator"><span>{t('kanban.convUnreadAbove')}</span></div>;
      case 'horizon': return <ConversationHorizon key="horizon" ctx={ctx} disabled={tabLoading.logs} onLoad={() => void loadMoreCardLogs(selected)} />;
      default: return null;
    }
  }

  return <section ref={tabRef} className="conv-tab" aria-label={t('kanban.tabConversation')}>
    <div className="conv-filters" role="toolbar" aria-label={t('kanban.tabConversation')}>
      {FILTERS.map((filter) => <button key={filter} type="button" className={`conv-filter ${view.filter === filter ? 'active' : ''}`} aria-pressed={view.filter === filter} onClick={() => setView({ ...view, filter })}>
        {t(`kanban.convFilter.${filter}`)}<span className="conv-tab-count">{filterCount(filter)}</span>
      </button>)}
      <span className="conv-filters-spacer" />
      <select className="input compact conv-sort" aria-label={t('kanban.convNewestFirst')} value={view.sort} onChange={(event) => setView({ ...view, sort: event.target.value as ConversationSort })}>
        <option value="newest">{t('kanban.convNewestFirst')}</option>
        <option value="oldest">{t('kanban.convOldestFirst')}</option>
      </select>
    </div>
    <div className="conv-new-pill-host" aria-live="polite">
      {pendingNew > 0 && <button type="button" className="conv-new-pill" onClick={jumpToNew}>{tf('kanban.convNewEvents', { count: pendingNew })}</button>}
    </div>
    {loading && <p className="conv-empty">{t('common.loading')}</p>}
    {empty && <p className="conv-empty">{t('kanban.convEmpty')}</p>}
    {filteredEmpty && <button type="button" className="conv-empty conv-empty-filter" onClick={() => setView({ ...view, filter: 'all' })}>{t('kanban.convEmptyFilter')}</button>}
    {!loading && !empty && !filteredEmpty && <div className="conv-list" ref={listRef} key={selected.id}>
      {view.sort === 'oldest' && showOlderButton}
      {windowed.visible.map((item) => renderItem(item))}
      {view.sort === 'newest' && showOlderButton}
    </div>}
  </section>;
}
