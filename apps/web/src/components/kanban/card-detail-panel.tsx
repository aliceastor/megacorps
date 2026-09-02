'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { Conversation, ConversationEvent, ConversationView } from '@/lib/card-conversation';
import { useLocale } from '@/lib/locale-context';
import type { DecisionStatus } from '../approval-decision-form';
import { CardConversation } from './card-conversation';
import { CardDetailsForm } from './card-details-form';
import { statusColor } from './card-helpers';
import { CardHistoryTab } from './card-history-tab';
import { DelegationTab, MessageBoardTab, ThreadTab } from './card-legacy-tabs';
import { CardOverview } from './card-overview';
import type { OverviewChipField } from './card-overview-chips';
import { CardOverviewEdit } from './card-overview-edit';
import { type Agent, type ApiEvent, type Card, type CardAction, type CardApproval, type CardComment, type CardDelegationSummary, type CardDetailTab, type CardStatus, type CardTabKey, type CommentActionMode, type Department, type DetailLayout, type Goal, type Project, type ReviewerScope, type SubtreeCard, type TaskLog, type WorkProduct, type WorkProductType, statusLabels } from './card-types';
import { CardWorkProductsTab } from './card-work-products-tab';
import { ConversationComposer } from './conversation-composer';

// The card detail overlay. State, loaders and handlers stay on the board and
// arrive here as fat props. Two layouts, one toggle away from each other
// (localStorage['megacorps.kanban.detailLayout'], default v2):
//   v2     = header + overview zone (read-only, or the edit form) + three tabs:
//            對話 (composer + merged conversation) / 產出 / 歷史
//   legacy = the PR-0 layout exactly.
// Whole panel scrolls; no sticky header in this iteration.

const LEGACY_TABS = ['details', 'comments', 'delegation', 'thread', 'logs', 'workProducts'] as const;
const V2_TABS = ['conversation', 'workProducts', 'logs'] as const;
const V2_TAB_SET: ReadonlySet<CardDetailTab> = new Set<CardDetailTab>(V2_TABS);

export type CardDetailPanelProps = {
  selected: Card | null;
  tab: CardDetailTab;
  selectTab: (tab: CardDetailTab) => void;
  detailLayout: DetailLayout;
  setDetailLayout: (layout: DetailLayout) => void;
  overviewEditing: boolean;
  setOverviewEditing: (editing: boolean) => void;
  /** The edit draft differs from the card (the comment composer is guarded on the board). */
  draftDirty: boolean;
  /** Backdrop click or the × button; the board applies the close guard. */
  closePanel: (source: 'overlay' | 'button') => void;
  /** Open another card from inside the panel (parent breadcrumb, child chips). */
  openCard: (card: Card) => void;
  cardApprovals: CardApproval[] | null;
  cardChildren: SubtreeCard[] | null;
  /** buildConversation(...) over the loaded rows, memoised on the board; `.latest` feeds the overview. */
  conversation: Conversation;
  conversationView: ConversationView;
  setConversationView: (view: ConversationView) => void;
  conversationLatest: ConversationEvent | null;
  onCheckpointAnswered: () => void | Promise<void>;
  onApprovalDecided: (status: DecisionStatus) => void | Promise<void>;
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
  const { t, locale } = useLocale();
  const { selected, tab, selectTab, detailLayout, setDetailLayout, overviewEditing, setOverviewEditing, closePanel, openCard } = props;
  const [focusField, setFocusField] = useState<OverviewChipField | null>(null);
  useEffect(() => { setFocusField(null); }, [selected?.id]);

  const isV2 = detailLayout === 'v2';
  // A legacy tab id can linger after a layout switch (and vice versa); map it
  // onto the closest tab the current layout has.
  const activeTab: CardDetailTab = isV2 ? (V2_TAB_SET.has(tab) ? tab : 'conversation') : tab === 'conversation' ? 'comments' : tab;
  const tabs: readonly CardDetailTab[] = isV2 ? V2_TABS : LEGACY_TABS;
  const conversationCount = props.tabLoading.comments && props.comments.length === 0 ? '—' : props.conversation.counts.conversation;
  const tabLabel = (next: CardDetailTab): ReactNode => {
    if (next === 'conversation') return <>{t('kanban.tabConversation')}<span className="conv-tab-count">{conversationCount}</span></>;
    if (next === 'workProducts') return isV2 ? <>{t('kanban.tabOutputs')}<span className="conv-tab-count">{props.workProducts.length}</span></> : t('kanban.tabWorkProducts');
    if (next === 'logs') return isV2 ? t('kanban.tabHistory') : t('kanban.tabLogs');
    return next === 'comments' ? t('kanban.tabMessageBoard') : next === 'delegation' ? t('kanban.tabDelegationReview') : next === 'thread' ? t('kanban.tabThread') : t('kanban.tabDetails');
  };
  const parent = selected?.parentCardId ? props.cards.find((card) => card.id === selected.parentCardId) ?? null : null;

  function startEditing(field: OverviewChipField | null) {
    setFocusField(field);
    setOverviewEditing(true);
  }

  function finishEditing() {
    if (props.draftDirty) {
      if (!window.confirm(t('kanban.closeDiscard'))) return;
      props.resetDraft();
    }
    setOverviewEditing(false);
  }

  return <AnimatePresence>
    {selected && (
      <motion.div className="overlay kanban-detail-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => closePanel('overlay')}>
      <motion.aside initial={{ scale: 0.97, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 16 }} transition={{ duration: 0.16 }}
        className="card detail-panel" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <div>
            {isV2 && selected.parentCardId && <p className="detail-breadcrumb">
              {parent
                ? <button type="button" onClick={() => openCard(parent)}>↖ {t('kanban.parentCard')}《{parent.title}》</button>
                : <>↖ {t('kanban.parentCard')} · {selected.parentCardId.slice(0, 8)}</>}
            </p>}
            <h2>{selected.title}</h2>
            <span className="status-pill" style={{ borderColor: statusColor(selected.columnStatus) }}>{statusLabels[selected.columnStatus as CardStatus]?.[locale] ?? selected.columnStatus}</span>
          </div>
          <button className="btn" aria-label={t('common.close')} onClick={() => closePanel('button')}><X size={16} /></button>
        </div>
        {isV2 && (overviewEditing
          ? <CardOverviewEdit
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
            focusField={focusField}
            onDone={finishEditing}
          />
          : <CardOverview
            key={selected.id}
            selected={selected}
            cards={props.cards}
            agents={props.agents}
            departments={props.departments}
            projects={props.projects}
            comments={props.comments}
            logs={props.logs}
            approvals={props.cardApprovals}
            childCards={props.cardChildren}
            delegationSummary={props.delegationSummary}
            latest={props.conversationLatest}
            busy={props.busy}
            onEdit={startEditing}
            onOpenCard={openCard}
            action={props.action}
            deleteSelected={props.deleteSelected}
            selectTab={selectTab}
            setCommentAction={props.setCommentAction}
            onCheckpointAnswered={props.onCheckpointAnswered}
            onApprovalDecided={props.onApprovalDecided}
          />)}
        <div className="tab-row">
          {tabs.map((next) => <button key={next} className={`tab ${activeTab === next ? 'active' : ''}`} onClick={() => selectTab(next)}>{tabLabel(next)}</button>)}
        </div>
        {activeTab === 'details' && !isV2 && <CardDetailsForm
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
        {activeTab === 'conversation' && isV2 && <>
          <ConversationComposer
            selected={selected}
            agents={props.agents}
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
          />
          <CardConversation
            selected={selected}
            cards={props.cards}
            agents={props.agents}
            conversation={props.conversation}
            view={props.conversationView}
            setView={props.setConversationView}
            logs={props.logs}
            logsHasMore={props.logsHasMore}
            tabLoading={props.tabLoading}
            loadMoreCardLogs={props.loadMoreCardLogs}
            openCard={openCard}
          />
        </>}
        {activeTab === 'comments' && <MessageBoardTab
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
        {activeTab === 'thread' && <ThreadTab
          agents={props.agents}
          logs={props.logs}
          actions={props.actions}
          workProducts={props.workProducts}
          tabLoading={props.tabLoading}
        />}
        {activeTab === 'logs' && <CardHistoryTab
          selected={selected}
          logs={props.logs}
          actions={props.actions}
          apiLogs={props.apiLogs}
          logsHasMore={props.logsHasMore}
          tabLoading={props.tabLoading}
          loadMoreCardLogs={props.loadMoreCardLogs}
        />}
        {activeTab === 'workProducts' && <CardWorkProductsTab
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
        {activeTab === 'delegation' && <DelegationTab
          selected={selected}
          agents={props.agents}
          comments={props.comments}
          tabLoading={props.tabLoading}
          loadCardComments={props.loadCardComments}
        />}
        <p className="detail-layout-toggle">
          <button type="button" onClick={() => setDetailLayout(isV2 ? 'legacy' : 'v2')}>{isV2 ? t('kanban.layoutLegacy') : t('kanban.layoutV2')}</button>
        </p>
      </motion.aside>
      </motion.div>
    )}
  </AnimatePresence>;
}
