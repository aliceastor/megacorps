'use client';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { delegationReviewTone, isDelegationReviewComment } from './card-helpers';
import type { Agent, Card, CardAction, CardComment, CardTabKey, CommentActionMode, ReviewerScope, TaskLog, WorkProduct } from './card-types';

// The three legacy tabs (message board, DELEGATE / REVIEWER, ticket thread)
// exactly as they rendered inside kanban-board.tsx. They stay reachable
// behind the detail-layout toggle until the owner removes them.

export type MessageBoardTabProps = {
  selected: Card;
  agents: Agent[];
  comments: CardComment[];
  tabLoading: Record<CardTabKey, boolean>;
  busy: boolean;
  commentBody: string;
  setCommentBody: (value: string) => void;
  commentAction: CommentActionMode;
  setCommentAction: (value: CommentActionMode) => void;
  commentAgentId: string;
  setCommentAgentId: (value: string) => void;
  commentDelegateAssigneeId: string;
  setCommentDelegateAssigneeId: (value: string) => void;
  commentDelegateReviewerId: string;
  setCommentDelegateReviewerId: (value: string) => void;
  commentDelegateScope: ReviewerScope;
  setCommentDelegateScope: (value: ReviewerScope) => void;
  addComment: () => void | Promise<void>;
};

export function MessageBoardTab({
  selected,
  agents,
  comments,
  tabLoading,
  busy,
  commentBody,
  setCommentBody,
  commentAction,
  setCommentAction,
  commentAgentId,
  setCommentAgentId,
  commentDelegateAssigneeId,
  setCommentDelegateAssigneeId,
  commentDelegateReviewerId,
  setCommentDelegateReviewerId,
  commentDelegateScope,
  setCommentDelegateScope,
  addComment,
}: MessageBoardTabProps) {
  const { t } = useLocale();
  return <div style={{ display: 'grid', gap: 12 }}>
    <div className="panel-title">
      <div><h2>{t('kanban.tabMessageBoard')}</h2><span className="status-pill">{comments.length} {t('kanban.messagesCount')}{tabLoading.comments ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
    </div>
    <div className="message-board-list">
      {comments.length === 0 && !tabLoading.comments ? <p style={{ opacity: 0.6 }}>{t('kanban.noMessages')}</p> : comments.map((comment) => {
        const authorAgent = comment.agentId ? agents.find((agent) => agent.id === comment.agentId) : undefined;
        const assigneeAgent = comment.assigneeAgentId ? agents.find((agent) => agent.id === comment.assigneeAgentId) : undefined;
        const reviewerAgent = comment.reviewerAgentId ? agents.find((agent) => agent.id === comment.reviewerAgentId) : undefined;
        const author = authorAgent?.name ?? (comment.authorType === 'system' ? t('common.system') : comment.authorType === 'agent' ? t('common.agent') : t('common.you'));
        return <article className="message-board-entry" key={comment.id}>
          <div className="message-board-entry-head"><b>{author}</b><span>{comment.action} / {comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}</span></div>
          {(comment.delegationStatus || comment.assigneeAgentId || comment.reviewerAgentId) && <div className="message-board-meta">
            {comment.delegationStatus && <span className="status-pill">{comment.delegationStatus}</span>}
            {assigneeAgent && <span>{t('kanban.delegateAssignee')}: {assigneeAgent.name}</span>}
            {reviewerAgent && <span>{comment.reviewerScope === 'final' ? t('kanban.finalReviewer') : t('kanban.phaseReviewer')}: {reviewerAgent.name}</span>}
          </div>}
          <p>{comment.body}</p>
        </article>;
      })}
    </div>
    <div className="form-grid">
      <label className="field-label">{t('kanban.author')}
        <select className="input" value={commentAgentId} onChange={(event) => {
          setCommentAgentId(event.target.value);
          if (event.target.value) setCommentAction('agent_note');
        }}>
          <option value="">{t('common.you')}</option>
          {agents.filter((agent) => !selected.companyId || agent.companyId === selected.companyId).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}{agent.role ? ` / ${agent.role}` : ''}</option>)}
        </select>
      </label>
      <label className="field-label">{t('kanban.action')}
        <select className="input" value={commentAgentId ? 'agent_note' : commentAction} disabled={Boolean(commentAgentId)} onChange={(event) => {
          const next = event.target.value as CommentActionMode;
          setCommentAction(next);
          if (next === 'delegate_to_agent') setCommentAgentId('');
        }}>
          <option value="comment">{t('kanban.commentOnly')}</option>
          <option value="agent_note">{t('kanban.agentNote')}</option>
          <option value="delegate_to_agent">{t('kanban.delegateToAgent')}</option>
          <option value="pause_agent">{t('kanban.stopAgentBlock')}</option>
          <option value="escalate_to_reviewer">{t('kanban.escalateReviewer')}</option>
          <option value="send_to_agent">{t('kanban.sendToAgent')}</option>
          <option value="continue_run">{t('kanban.continueWithComment')}</option>
        </select>
      </label>
    </div>
    {commentAction === 'delegate_to_agent' && !commentAgentId && <div className="form-grid">
      <label className="field-label">{t('kanban.delegateAssignee')}
        <select className="input" value={commentDelegateAssigneeId} onChange={(event) => setCommentDelegateAssigneeId(event.target.value)}>
          <option value="">{t('kanban.delegateAssignee')}</option>
          {agents.filter((agent) => !selected.companyId || agent.companyId === selected.companyId).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}{agent.role ? ` / ${agent.role}` : ''}</option>)}
        </select>
      </label>
      <label className="field-label">{t('kanban.reviewScope')}
        <select className="input" value={commentDelegateScope} onChange={(event) => setCommentDelegateScope(event.target.value as ReviewerScope)}>
          <option value="phase">{t('kanban.phaseReviewer')}</option>
          <option value="final">{t('kanban.finalReviewer')}</option>
        </select>
      </label>
      <label className="field-label">{commentDelegateScope === 'final' ? t('kanban.finalReviewer') : t('kanban.phaseReviewer')}
        <select className="input" value={commentDelegateReviewerId} onChange={(event) => setCommentDelegateReviewerId(event.target.value)}>
          <option value="">{t('kanban.reviewer')}</option>
          {agents.filter((agent) => !selected.companyId || agent.companyId === selected.companyId).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}{agent.role ? ` / ${agent.role}` : ''}</option>)}
        </select>
      </label>
    </div>}
    <label className="field-label">{t('kanban.message')}
      <textarea className="input" rows={5} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder={t('kanban.messageHint')} />
    </label>
    <button className="btn btn-primary" disabled={busy || !commentBody.trim()} onClick={addComment}><MessageSquare size={15} /> {t('kanban.addMessage')}</button>
  </div>;
}

export type ThreadTabProps = {
  agents: Agent[];
  logs: TaskLog[];
  actions: CardAction[];
  workProducts: WorkProduct[];
  tabLoading: Record<CardTabKey, boolean>;
};

export function ThreadTab({ agents, logs, actions, workProducts, tabLoading }: ThreadTabProps) {
  const { t } = useLocale();
  const ticketThreadEntries = [
    ...logs.map((log) => ({
      id: `log-${log.id}`,
      createdAt: log.createdAt,
      type: log.type === 'stage' ? 'stage_changed' : log.type,
      actor: t('common.system'),
      tone: log.status === 'failed' ? 'error' : 'system',
      body: [log.message, log.output].filter(Boolean).join('\n\n'),
      meta: [log.createdAt ? new Date(log.createdAt).toLocaleString() : '', log.costUsd ? `$${log.costUsd}` : '', log.durationSeconds !== undefined ? `${log.durationSeconds}s` : ''].filter(Boolean).join(' / '),
    })),
    ...actions.map((action) => ({
      id: `action-${action.id}`,
      createdAt: action.createdAt,
      type: action.action,
      actor: action.actorType === 'user' ? `${t('common.user')} ${action.actorId}` : action.actorType === 'system' ? t('common.system') : action.actorId,
      tone: action.action.includes('block') || action.toStatus === 'blocked' ? 'error' : 'system',
      body: action.detail ?? `${action.fromStatus ?? 'none'} -> ${action.toStatus ?? 'none'}`,
      meta: [action.createdAt ? new Date(action.createdAt).toLocaleString() : '', `${action.actorType}:${action.actorId}`, action.fromStatus || action.toStatus ? `${action.fromStatus ?? 'none'} -> ${action.toStatus ?? 'none'}` : ''].filter(Boolean).join(' / '),
    })),
    ...workProducts.map((product) => ({
      id: `product-${product.id}`,
      createdAt: product.createdAt,
      type: 'work_product',
      actor: agents.find((agent) => agent.id === product.agentId)?.name ?? t('common.system'),
      tone: 'product',
      body: [product.title, product.summary].filter(Boolean).join('\n\n'),
      meta: [product.type, product.createdAt ? new Date(product.createdAt).toLocaleString() : '', product.pullRequestUrl || product.url || product.commitSha || ''].filter(Boolean).join(' / '),
    })),
  ].sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
  return <div style={{ display: 'grid', gap: 12 }}>
    <div className="panel-title">
      <div><h2>{t('kanban.tabThread')}</h2><span className="status-pill">{ticketThreadEntries.length} {t('kanban.tracedEntries')}{tabLoading.comments || tabLoading.logs || tabLoading.actions || tabLoading.workProducts ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
    </div>
    <div className="ticket-thread">
      {ticketThreadEntries.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noThreadEntries')}</p> : ticketThreadEntries.map((entry) => <article className={`ticket-entry ${entry.tone}`} key={entry.id}>
        <div className="ticket-entry-rail"><span /></div>
        <div className="ticket-entry-body">
          <div className="ticket-entry-head"><b>{entry.actor}</b><span>{entry.type} / {entry.meta}</span></div>
          <p>{entry.body}</p>
        </div>
      </article>)}
    </div>
  </div>;
}

export type DelegationTabProps = {
  selected: Card;
  agents: Agent[];
  comments: CardComment[];
  tabLoading: Record<CardTabKey, boolean>;
  loadCardComments: (card: Card, force?: boolean) => Promise<CardComment[]>;
};

export function DelegationTab({ selected, agents, comments, tabLoading, loadCardComments }: DelegationTabProps) {
  const { t } = useLocale();
  const delegationReviewRecords = comments.filter(isDelegationReviewComment).sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''));
  return <div style={{ display: 'grid', gap: 10 }}>
    <div className="panel-title">
      <div><h2>{t('kanban.tabDelegationReview')}</h2><span className="status-pill">{delegationReviewRecords.length} {t('kanban.delegationRecords')}{tabLoading.comments ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
      <button className="btn" disabled={tabLoading.comments} onClick={() => loadCardComments(selected, true)}><RefreshCw size={14} /> {t('common.refresh')}</button>
    </div>
    {tabLoading.comments && delegationReviewRecords.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingDelegationRecords')}</p> : delegationReviewRecords.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noDelegationRecords')}</p> : <div className="ticket-thread">
      {delegationReviewRecords.map((comment) => {
        const authorAgent = comment.agentId ? agents.find((agent) => agent.id === comment.agentId) : undefined;
        const assigneeAgent = comment.assigneeAgentId ? agents.find((agent) => agent.id === comment.assigneeAgentId) : undefined;
        const reviewerAgent = comment.reviewerAgentId ? agents.find((agent) => agent.id === comment.reviewerAgentId) : undefined;
        const author = authorAgent?.name ?? (comment.authorType === 'system' ? t('common.system') : comment.authorType === 'agent' ? t('common.agent') : t('common.you'));
        return <article className={`ticket-entry ${delegationReviewTone(comment)}`} key={comment.id}>
          <div className="ticket-entry-rail"><span /></div>
          <div className="ticket-entry-body">
            <div className="ticket-entry-head"><b>{author}</b><span>{comment.action} / {comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}</span></div>
            <div className="message-board-meta">
              {comment.delegationStatus && <span>{comment.delegationStatus}</span>}
              {assigneeAgent && <span>{t('kanban.delegateAssignee')}: {assigneeAgent.name}</span>}
              {reviewerAgent && <span>{comment.reviewerScope === 'final' ? t('kanban.finalReviewer') : t('kanban.phaseReviewer')}: {reviewerAgent.name}</span>}
              {comment.parentCommentId && <span>{t('kanban.parentRecord')}: {comment.parentCommentId.slice(0, 8)}</span>}
            </div>
            <p>{comment.body}</p>
          </div>
        </article>;
      })}
    </div>}
  </div>;
}
