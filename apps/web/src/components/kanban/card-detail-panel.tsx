'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { CardDetailsForm } from './card-details-form';
import { statusColor } from './card-helpers';
import { CardHistoryTab } from './card-history-tab';
import { DelegationTab, MessageBoardTab, ThreadTab } from './card-legacy-tabs';
import type { Agent, ApiEvent, Card, CardAction, CardComment, CardDelegationSummary, CardDetailTab, CardTabKey, CommentActionMode, Department, Goal, Project, ReviewerScope, TaskLog, WorkProduct, WorkProductType } from './card-types';
import { CardWorkProductsTab } from './card-work-products-tab';

// The card detail overlay, moved verbatim out of kanban-board.tsx. State,
// loaders and handlers stay on the board and arrive here as fat props; the
// panel only decides which tab body to render.

export type CardDetailPanelProps = {
  selected: Card | null;
  setSelected: (card: Card | null) => void;
  tab: CardDetailTab;
  selectTab: (tab: CardDetailTab) => void;
  cards: Card[];
  agents: Agent[];
  departments: Department[];
  projects: Project[];
  goals: Goal[];
  draft: Partial<Card> | null;
  setDraft: (draft: Partial<Card> | null) => void;
  logs: TaskLog[];
  actions: CardAction[];
  apiLogs: ApiEvent[];
  comments: CardComment[];
  workProducts: WorkProduct[];
  delegationSummary: CardDelegationSummary | null;
  logsHasMore: boolean;
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
  workProductType: WorkProductType;
  setWorkProductType: (value: WorkProductType) => void;
  workProductTitle: string;
  setWorkProductTitle: (value: string) => void;
  workProductSummary: string;
  setWorkProductSummary: (value: string) => void;
  workProductUrl: string;
  setWorkProductUrl: (value: string) => void;
  workProductRepoProvider: string;
  setWorkProductRepoProvider: (value: string) => void;
  workProductRepoUrl: string;
  setWorkProductRepoUrl: (value: string) => void;
  workProductBranch: string;
  setWorkProductBranch: (value: string) => void;
  workProductCommitSha: string;
  setWorkProductCommitSha: (value: string) => void;
  workProductPullRequestUrl: string;
  setWorkProductPullRequestUrl: (value: string) => void;
  saveSelected: () => void | Promise<void>;
  resetDraft: () => void;
  deleteSelected: () => void | Promise<void>;
  action: (path: string, message: string) => void | Promise<void>;
  addComment: () => void | Promise<void>;
  addWorkProduct: () => void | Promise<void>;
  loadMoreCardLogs: (card: Card) => Promise<void>;
  loadCardComments: (card: Card, force?: boolean) => Promise<CardComment[]>;
};

export function CardDetailPanel(props: CardDetailPanelProps) {
  const { t } = useLocale();
  const { selected, setSelected, tab, selectTab } = props;
  return <AnimatePresence>
    {selected && (
      <motion.div className="overlay kanban-detail-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelected(null)}>
      <motion.aside initial={{ scale: 0.97, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 16 }} transition={{ duration: 0.16 }}
        className="card detail-panel" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <div><h2>{selected.title}</h2><span className="status-pill" style={{ borderColor: statusColor(selected.columnStatus) }}>{selected.columnStatus}</span></div>
          <button className="btn" onClick={() => setSelected(null)}><X size={16} /></button>
        </div>
        <div className="tab-row">
          {(['details', 'comments', 'delegation', 'thread', 'logs', 'workProducts'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => selectTab(next)}>{next === 'comments' ? t('kanban.tabMessageBoard') : next === 'delegation' ? t('kanban.tabDelegationReview') : next === 'thread' ? t('kanban.tabThread') : next === 'workProducts' ? t('kanban.tabWorkProducts') : next === 'details' ? t('kanban.tabDetails') : t('kanban.tabLogs')}</button>)}
        </div>
        {tab === 'details' && <CardDetailsForm
          selected={selected}
          draft={props.draft}
          setDraft={props.setDraft}
          cards={props.cards}
          agents={props.agents}
          departments={props.departments}
          projects={props.projects}
          goals={props.goals}
          delegationSummary={props.delegationSummary}
          busy={props.busy}
          saveSelected={props.saveSelected}
          resetDraft={props.resetDraft}
          deleteSelected={props.deleteSelected}
          action={props.action}
          selectTab={selectTab}
          setCommentAction={props.setCommentAction}
        />}
        {tab === 'comments' && <MessageBoardTab
          selected={selected}
          agents={props.agents}
          comments={props.comments}
          tabLoading={props.tabLoading}
          busy={props.busy}
          commentBody={props.commentBody}
          setCommentBody={props.setCommentBody}
          commentAction={props.commentAction}
          setCommentAction={props.setCommentAction}
          commentAgentId={props.commentAgentId}
          setCommentAgentId={props.setCommentAgentId}
          commentDelegateAssigneeId={props.commentDelegateAssigneeId}
          setCommentDelegateAssigneeId={props.setCommentDelegateAssigneeId}
          commentDelegateReviewerId={props.commentDelegateReviewerId}
          setCommentDelegateReviewerId={props.setCommentDelegateReviewerId}
          commentDelegateScope={props.commentDelegateScope}
          setCommentDelegateScope={props.setCommentDelegateScope}
          addComment={props.addComment}
        />}
        {tab === 'thread' && <ThreadTab
          agents={props.agents}
          logs={props.logs}
          actions={props.actions}
          workProducts={props.workProducts}
          tabLoading={props.tabLoading}
        />}
        {tab === 'logs' && <CardHistoryTab
          selected={selected}
          logs={props.logs}
          actions={props.actions}
          apiLogs={props.apiLogs}
          logsHasMore={props.logsHasMore}
          tabLoading={props.tabLoading}
          loadMoreCardLogs={props.loadMoreCardLogs}
        />}
        {tab === 'workProducts' && <CardWorkProductsTab
          workProducts={props.workProducts}
          tabLoading={props.tabLoading}
          busy={props.busy}
          workProductType={props.workProductType}
          setWorkProductType={props.setWorkProductType}
          workProductTitle={props.workProductTitle}
          setWorkProductTitle={props.setWorkProductTitle}
          workProductSummary={props.workProductSummary}
          setWorkProductSummary={props.setWorkProductSummary}
          workProductUrl={props.workProductUrl}
          setWorkProductUrl={props.setWorkProductUrl}
          workProductRepoProvider={props.workProductRepoProvider}
          setWorkProductRepoProvider={props.setWorkProductRepoProvider}
          workProductRepoUrl={props.workProductRepoUrl}
          setWorkProductRepoUrl={props.setWorkProductRepoUrl}
          workProductBranch={props.workProductBranch}
          setWorkProductBranch={props.setWorkProductBranch}
          workProductCommitSha={props.workProductCommitSha}
          setWorkProductCommitSha={props.setWorkProductCommitSha}
          workProductPullRequestUrl={props.workProductPullRequestUrl}
          setWorkProductPullRequestUrl={props.setWorkProductPullRequestUrl}
          addWorkProduct={props.addWorkProduct}
        />}
        {tab === 'delegation' && <DelegationTab
          selected={selected}
          agents={props.agents}
          comments={props.comments}
          tabLoading={props.tabLoading}
          loadCardComments={props.loadCardComments}
        />}
      </motion.aside>
      </motion.div>
    )}
  </AnimatePresence>;
}
