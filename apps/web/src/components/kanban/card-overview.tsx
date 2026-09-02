'use client';
import { useEffect, useRef, useState } from 'react';
import { Ban, Pencil, Play, ShieldCheck, StopCircle, Trash2 } from 'lucide-react';
import type { ConversationEvent } from '@/lib/card-conversation';
import { describeSituation } from '@/lib/card-situation';
import { useLocale } from '@/lib/locale-context';
import { formatRelative } from '@/lib/relative-time';
import type { DecisionStatus } from '../approval-decision-form';
import { statusColor } from './card-helpers';
import { CardNeedsYou } from './card-needs-you';
import { childChipTone, overviewChips, type OverviewChipField } from './card-overview-chips';
import { CardRuntimeDetails } from './card-runtime-details';
import { type Agent, type Card, type CardApproval, type CardComment, type CardDelegationSummary, type CardDetailTab, type CardStatus, type CommentActionMode, type Department, type Project, type SubtreeCard, type TaskLog, statusLabels } from './card-types';

// ① The overview zone: always visible, outside the tabs, read-only. Top to
// bottom: situation line, needs-you strip, last activity, people strip,
// clamped body, child-card chips (parent cards), field chips (each opens the
// editor focused on that field), review feedback, action row, runtime details.

export type CardOverviewProps = {
  selected: Card;
  cards: Card[];
  agents: Agent[];
  departments: Department[];
  projects: Project[];
  comments: CardComment[];
  logs: TaskLog[];
  /** GET /api/approvals?cardId=; null while loading. */
  approvals: CardApproval[] | null;
  /** Direct children from GET /api/cards/:id/subtree; null when not a parent or not loaded. */
  childCards: SubtreeCard[] | null;
  delegationSummary: CardDelegationSummary | null;
  /** buildConversation(...).latest over whatever rows are loaded; null falls back to updatedAt. */
  latest: ConversationEvent | null;
  busy: boolean;
  onEdit: (field: OverviewChipField | null) => void;
  onOpenCard: (card: Card) => void;
  action: (path: string, message: string) => void | Promise<void>;
  deleteSelected: () => void | Promise<void>;
  selectTab: (tab: CardDetailTab) => void;
  setCommentAction: (mode: CommentActionMode) => void;
  onCheckpointAnswered: () => void | Promise<void>;
  onApprovalDecided: (status: DecisionStatus) => void | Promise<void>;
};

export function CardOverview({
  selected,
  cards,
  agents,
  departments,
  projects,
  comments,
  logs,
  approvals,
  childCards,
  delegationSummary,
  latest,
  busy,
  onEdit,
  onOpenCard,
  action,
  deleteSelected,
  selectTab,
  setCommentAction,
  onCheckpointAnswered,
  onApprovalDecided,
}: CardOverviewProps) {
  const { t, tf, locale } = useLocale();
  const now = Date.now();
  const statusLabel = (status: string) => statusLabels[status as CardStatus]?.[locale] ?? status;
  const situation = describeSituation(selected, { now, locale, tf, agents, children: childCards, approvals, delegationSummary, latestComments: comments, latestLogs: logs });

  // B. last activity: the newest non-system conversation event, else updatedAt.
  const latestLabel = latest ? (t(latest.labelKey) === latest.labelKey ? latest.rawLabel : t(latest.labelKey)) : '';
  const latestActor = latest
    ? latest.actor.type === 'system' ? t('common.system') : latest.actor.type === 'you' ? t('common.you') : latest.actor.role ? `${latest.actor.name} · ${latest.actor.role}` : latest.actor.name
    : '';

  // D. people strip.
  const assignee = selected.assigneeId ? agents.find((agent) => agent.id === selected.assigneeId) : undefined;
  const reviewer = selected.reviewerId ? agents.find((agent) => agent.id === selected.reviewerId) : undefined;
  const personLabel = (agent: Agent | undefined) => (agent ? [agent.name, agent.role].filter(Boolean).join(' · ') : '');
  const assigneeText = personLabel(assignee) || t('kanban.noneAssigned');
  const reviewerText = reviewer
    ? (selected.requiresApproval ? `${reviewer.name} · ${t('common.you')}` : personLabel(reviewer))
    : selected.requiresApproval ? t('kanban.youApprover') : t('kanban.noneAssigned');
  const departmentText = departments.find((department) => department.id === selected.departmentId)?.name ?? t('kanban.noneAssigned');
  const projectText = projects.find((project) => project.id === selected.projectId)?.name ?? t('kanban.noneAssigned');

  // E. body with a 6-line clamp; the toggle only shows when the clamp bites.
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => { setExpanded(false); }, [selected.id]);
  useEffect(() => {
    if (expanded) return;
    const element = bodyRef.current;
    if (!element) return;
    setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [selected.id, selected.body, expanded]);

  const chips = overviewChips(selected, { tf, cards, children: childCards });
  const reviewOpen = selected.columnStatus === 'in_review' || selected.columnStatus === 'needs_review';

  return <section className="card-overview" aria-label={t('kanban.tabDetails')}>
    <p className={`overview-situation ${situation.tone}`} role="status" style={{ borderLeftColor: statusColor(selected.columnStatus) }}>{situation.text}</p>

    <CardNeedsYou
      card={selected}
      approvals={approvals}
      comments={comments}
      busy={busy}
      onRunNow={() => void action(`/api/cards/${selected.id}/run`, t('kanban.taskDispatched'))}
      onReview={() => void action(`/api/cards/${selected.id}/review`, t('kanban.reviewCompleted'))}
      onContinueWithComment={() => { selectTab('comments'); setCommentAction('continue_run'); }}
      onCheckpointAnswered={onCheckpointAnswered}
      onApprovalDecided={onApprovalDecided}
    />

    <p className="overview-last">
      {latest
        ? <>{t('kanban.overviewLastEvent')} · {latestActor} {latestLabel} · {formatRelative(latest.createdAt, now, locale) || '—'}</>
        : <>{t('kanban.overviewUpdatedAt')} {formatRelative(selected.updatedAt, now, locale) || '—'}</>}
    </p>

    <div className="overview-people">
      <span>{t('kanban.assignee')}<b>{assigneeText}</b></span>
      <span>{t('kanban.reviewer')}<b>{reviewerText}</b></span>
      <span>{t('common.department')}<b>{departmentText}</b></span>
      <span>{t('common.project')}<b>{projectText}</b></span>
    </div>

    {selected.body && <>
      <p ref={bodyRef} className={`overview-body ${expanded ? '' : 'clamped'}`}>{selected.body}</p>
      {(expanded || overflowing) && <button type="button" className="overview-body-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? t('kanban.bodyCollapse') : t('kanban.bodyExpand')}</button>}
    </>}

    {childCards && childCards.length > 0 && <div className="overview-children">
      <span className="overview-children-label">{t('kanban.chipChildren')}</span>
      {childCards.map((child) => <button type="button" key={child.id} className={`overview-child ${childChipTone(child.columnStatus)}`} title={child.title} onClick={() => onOpenCard(child)}>{child.title} · {statusLabel(child.columnStatus)}</button>)}
    </div>}

    <div className="overview-chips">
      {chips.map((chip) => <button
        type="button"
        key={chip.id}
        className={`overview-chip ${chip.tone}`}
        disabled={!chip.field}
        title={chip.field ? t('kanban.overviewEdit') : undefined}
        onClick={() => { if (chip.field) onEdit(chip.field); }}
      >{chip.text}</button>)}
    </div>

    {selected.reviewFeedback && <details key={`review-${selected.id}`} className="runtime-details overview-review" open={reviewOpen}>
      <summary>{t('kanban.reviewFeedback')}</summary>
      <pre className="log-block">{selected.reviewFeedback}</pre>
    </details>}

    <div className="card-overview-actions">
      <button className="btn btn-primary" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/run`, t('kanban.taskDispatched'))}><Play size={15} /> {t('common.runNow')}</button>
      <button className="btn" disabled={busy} title={t('kanban.reviewEnqueuesAgent')} onClick={() => action(`/api/cards/${selected.id}/review`, t('kanban.reviewCompleted'))}><ShieldCheck size={15} /> {t('kanban.review')}</button>
      <button className="btn" disabled={busy} onClick={() => { selectTab('comments'); setCommentAction('pause_agent'); }}><StopCircle size={15} /> {t('kanban.pauseWithComment')}</button>
      <button className="btn" disabled={busy} onClick={() => onEdit(null)}><Pencil size={15} /> {t('kanban.overviewEdit')}</button>
      <span className="card-overview-actions-spacer" />
      <button className="btn" disabled={busy || selected.columnStatus === 'cancelled'} onClick={() => action(`/api/cards/${selected.id}/cancel`, t('kanban.taskCancelled'))}><Ban size={15} /> {t('kanban.cancelTask')}</button>
      <button className="btn" disabled={busy} onClick={deleteSelected} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> {t('kanban.deleteTask')}</button>
    </div>

    <CardRuntimeDetails selected={selected} agents={agents} delegationSummary={delegationSummary} annotatePhase />
  </section>;
}
