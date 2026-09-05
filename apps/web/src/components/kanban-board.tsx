'use client';
import { inferWorkProductType } from './kanban/work-product-input';
import { KanbanListView } from './kanban-list-view';
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isCancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, GripVertical, Plus, RefreshCw, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { insertBriefTemplate } from '@/lib/card-brief';
import { EMPTY_CONVERSATION, buildConversation, type Conversation, type ConversationView } from '@/lib/card-conversation';
import { readCardSeen, rememberCardSeen, writeCardSeen } from '@/lib/card-seen';
import { createKeyedDebounce } from '@/lib/keyed-debounce';
import { useLocale } from '@/lib/locale-context';
import { CardDetailPanel } from './kanban/card-detail-panel';
import { agentDisplayName, draftFromCard, goalScope, isDraftDirty, parseCsv, priorityNumber, priorityValue, scopedGoalOptions, shouldReseedDraft, statusColor } from './kanban/card-helpers';
import { type Agent, type ApiEvent, type CachedRows, type CachedValue, type Card, type CardAction, type CardApproval, type CardComment, type CardDelegationSummary, type CardDetailTab, type CardStatus, type CardTabCache, type CardTabKey, type Company, type Department, type DetailLayout, type Goal, type LocaleLabels, type Project, type ReviewRound, type SubtreeCard, type TaskLog, type TaskRun, type WorkProduct, priorities, statusLabels, statuses, workProductTypes } from './kanban/card-types';
import { DependencyPicker } from './kanban/dependency-picker';
import { PanelReviewerPicker } from './kanban/panel-reviewer-picker';

type StatusGroupId = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked_cancelled';
type StatusGroup = { id: StatusGroupId; statuses: readonly CardStatus[]; dropStatus: CardStatus };
const statusGroups: readonly StatusGroup[] = [
  { id: 'todo', statuses: ['todo'], dropStatus: 'todo' },
  { id: 'in_progress', statuses: ['in_progress', 'waiting_on_brainstorm'], dropStatus: 'in_progress' },
  { id: 'review', statuses: ['in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client'], dropStatus: 'in_review' },
  { id: 'done', statuses: ['done'], dropStatus: 'done' },
  { id: 'blocked_cancelled', statuses: ['blocked', 'cancelled'], dropStatus: 'blocked' },
] as const;
const statusGroupLabels: Record<StatusGroupId, LocaleLabels> = {
  todo: statusLabels.todo,
  in_progress: statusLabels.in_progress,
  review: { 'zh-TW': '審核中 / 求助審核', en: 'In Review / Needs Review', ja: 'レビュー中 / 支援レビュー' },
  done: statusLabels.done,
  blocked_cancelled: { 'zh-TW': '受阻 / 已取消', en: 'Blocked / Cancelled', ja: 'ブロック / キャンセル' },
};

type CardUpdatePayload = Omit<Partial<Card>, 'priority'> & { priority?: (typeof priorities)[number] };
type LiveEvent = { type: string; cardId?: string | null; entityId?: string; projectId?: string | null };

const CARD_TAB_CACHE_KEY = 'megacorps.kanban.card-tabs.v2';
const CARD_TAB_CACHE_TTL_MS = 2 * 60 * 1000;
// The merged 對話 tab fills all four arrays for every card opened, so the
// sessionStorage cache keeps fewer cards and refuses writes past 2 MB
// (the browser quota is ~5 MB and the in-memory copy still works).
const CARD_TAB_CACHE_LIMIT = 20;
const CARD_TAB_CACHE_MAX_CHARS = 2 * 1024 * 1024;
const CARD_LOG_PAGE_SIZE = 80;
const DETAIL_LAYOUT_KEY = 'megacorps.kanban.detailLayout';
const CONVERSATION_VIEW_KEY = 'megacorps.kanban.conversation.v1';
const DEFAULT_CONVERSATION_VIEW: ConversationView = { sort: 'newest', filter: 'all' };
// One live burst (a human pause = comment.created + 2 × card.updated; a
// dispatch = 3 × task_log.created + card.updated) collapses into one reload per key.
const LIVE_DEBOUNCE_MS = 400;
const CONVERSATION_SORTS = new Set<ConversationView['sort']>(['newest', 'oldest']);
const CONVERSATION_FILTERS = new Set<ConversationView['filter']>(['all', 'talk', 'milestones', 'delegationReview', 'system']);

function readDetailLayout(): DetailLayout {
  try { return window.localStorage.getItem(DETAIL_LAYOUT_KEY) === 'legacy' ? 'legacy' : 'v2'; } catch { return 'v2'; }
}

function readConversationView(): ConversationView {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_VIEW_KEY);
    if (!raw) return DEFAULT_CONVERSATION_VIEW;
    const parsed = JSON.parse(raw) as Partial<ConversationView> | null;
    return {
      sort: parsed?.sort && CONVERSATION_SORTS.has(parsed.sort) ? parsed.sort : DEFAULT_CONVERSATION_VIEW.sort,
      filter: parsed?.filter && CONVERSATION_FILTERS.has(parsed.filter) ? parsed.filter : DEFAULT_CONVERSATION_VIEW.filter,
    };
  } catch {
    return DEFAULT_CONVERSATION_VIEW;
  }
}

// The tab a freshly opened card shows. Legacy keeps the details tab; the v2
// panel opens on the merged 對話 tab. PR-4 narrows CardDetailTab once the
// legacy layout goes.
function defaultTabFor(layout: DetailLayout): CardDetailTab {
  return layout === 'legacy' ? 'details' : 'conversation';
}

function isFresh<T>(entry?: CachedRows<T> | CachedValue<T>): boolean {
  return Boolean(entry && Date.now() - entry.cachedAt < CARD_TAB_CACHE_TTL_MS);
}

function readCardTabCache(): Record<string, CardTabCache> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(CARD_TAB_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CardTabCache>;
  } catch {
    return {};
  }
}

function writeCardTabCache(cache: Record<string, CardTabCache>): void {
  if (typeof window === 'undefined') return;
  try {
    const serialized = JSON.stringify(cache);
    if (serialized.length > CARD_TAB_CACHE_MAX_CHARS) return;
    window.sessionStorage.setItem(CARD_TAB_CACHE_KEY, serialized);
  } catch {
    // Keep the in-memory cache even if the browser refuses sessionStorage writes.
  }
}

function newestCacheTime(cache: CardTabCache): number {
  return Math.max(cache.comments?.cachedAt ?? 0, cache.logs?.cachedAt ?? 0, cache.actions?.cachedAt ?? 0, cache.apiLogs?.cachedAt ?? 0, cache.workProducts?.cachedAt ?? 0, cache.delegationSummary?.cachedAt ?? 0);
}

function pruneCardTabCache(cache: Record<string, CardTabCache>): Record<string, CardTabCache> {
  return Object.fromEntries(Object.entries(cache).sort((a, b) => newestCacheTime(b[1]) - newestCacheTime(a[1])).slice(0, CARD_TAB_CACHE_LIMIT));
}

function apiEventMentionsCard(event: ApiEvent, cardId: string): boolean {
  if (event.path.includes(cardId)) return true;
  try {
    return JSON.stringify(event.requestBody ?? {}).includes(cardId) || JSON.stringify(event.responseBody ?? {}).includes(cardId);
  } catch {
    return false;
  }
}

function statusGroupColor(groupId: StatusGroupId) {
  if (groupId === 'review') return statusColor('in_review');
  if (groupId === 'blocked_cancelled') return statusColor('blocked');
  return statusColor(groupId);
}

function statusGroupById(id: string): StatusGroup | undefined {
  return statusGroups.find((group) => group.id === id);
}

function cardStatusRank(group: StatusGroup, status: string): number {
  const index = group.statuses.indexOf(status as CardStatus);
  return index === -1 ? group.statuses.length : index;
}

function cardsForStatusGroup(cards: Card[], group: StatusGroup): Card[] {
  const grouped = cards.filter((card) => group.statuses.includes(card.columnStatus as CardStatus));
  if (group.statuses.length === 1) return grouped;
  return [...grouped].sort((left, right) => cardStatusRank(group, left.columnStatus) - cardStatusRank(group, right.columnStatus));
}

function cardWorkflowTag(card: Card, agents: Agent[]): { type: 'Process' | 'Review'; name: string } | null {
  const reviewId = card.workflowReviewAgentId ?? (['in_review', 'needs_review'].includes(card.columnStatus) ? card.reviewerId : null);
  const processId = card.workflowProcessAgentId ?? (!reviewId && ['todo', 'in_progress', 'waiting_on_external'].includes(card.columnStatus) ? card.assigneeId : null);
  if (reviewId) return { type: 'Review', name: agentDisplayName(agents.find((agent) => agent.id === reviewId)) ?? reviewId.slice(0, 8) };
  if (processId) return { type: 'Process', name: agentDisplayName(agents.find((agent) => agent.id === processId)) ?? processId.slice(0, 8) };
  return null;
}

function isQueryCancellation(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof Error && error.name === 'CancelledError');
}

async function fetchKanbanBoard() {
  const [cards, agents, companies, departments, projects, goals] = await Promise.all([
    api<Card[]>('/api/cards'),
    api<Agent[]>('/api/agents'),
    api<Company[]>('/api/companies'),
    api<Department[]>('/api/departments'),
    api<Project[]>('/api/projects'),
    api<Goal[]>('/api/goals'),
  ]);
  return { cards, agents, companies, departments, projects, goals };
}

function Column({
  group,
  cards,
  agents,
  companies,
  onSelect,
}: {
  group: StatusGroup;
  cards: Card[];
  agents: Agent[];
  companies: Company[];
  onSelect: (card: Card) => void;
}) {
  const { locale } = useLocale();
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  return <section className="kanban-column">
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, margin: '0 0 8px' }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: statusGroupColor(group.id) }} />
      {statusGroupLabels[group.id]?.[locale] ?? group.id}
      <span style={{ background: 'var(--border)', borderRadius: 99, padding: '2px 8px', fontSize: 12 }}>{cards.length}</span>
    </h3>
    <div ref={setNodeRef} className={`card kanban-column-dropzone ${cards.length === 0 ? 'is-empty' : ''}`} style={{ outline: isOver ? '2px solid var(--primary)' : 'none', transition: 'outline 150ms' }}>
      {cards.map((card) => <DraggableCard
        key={card.id}
        card={card}
        agents={agents}
        companyName={companies.find((company) => company.id === card.companyId)?.name}
        onSelect={onSelect}
      />)}
    </div>
  </section>;
}

function DraggableCard({
  card,
  agents,
  companyName,
  onSelect,
}: {
  card: Card;
  agents: Agent[];
  companyName?: string;
  onSelect: (card: Card) => void;
}) {
  const { t } = useLocale();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  const workflowTag = cardWorkflowTag(card, agents);
  return <article
    ref={setNodeRef}
    data-card-id={card.id}
    tabIndex={0}
    aria-label={`${t('kanban.openTask')} ${card.title}`}
    className="card kanban-card"
    style={{
      transform: CSS.Translate.toString(transform),
      opacity: isDragging ? 0.65 : 1,
      borderLeft: `4px solid ${card.priority >= 3 ? '#ef4444' : card.priority >= 2 ? '#f97316' : card.priority <= -1 ? '#60a5fa' : statusColor(card.columnStatus)}`,
    }}
    onClick={() => onSelect(card)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(card);
      }
    }}
  >
    <div className="kanban-card-head">
      <b className="kanban-card-title">{card.title}</b>
      <button
        className="drag-handle"
        aria-label={t('kanban.dragTask')}
        title={t('kanban.dragTask')}
        onClick={(event) => event.stopPropagation()}
        {...listeners}
        {...attributes}
      >
        <GripVertical size={14} />
      </button>
      <span className="kanban-priority">{t(`kanban.priority.${priorityValue(card.priority)}`)}</span>
    </div>
    <div className="kanban-card-id">{card.id}</div>
    {companyName && <div className="kanban-card-company">{companyName}</div>}
    <p className="kanban-card-body">{card.body.slice(0, 100)}{card.body.length > 100 ? '...' : ''}</p>
    <div className="kanban-card-badges">
      {card.requiresApproval && <span className="badge">{t('kanban.review')}</span>}
      {card.recurEveryMinutes ? <span className="badge">↻ {card.recurEveryMinutes}m</span> : null}
      {!card.recurEveryMinutes && card.scheduleAt && new Date(card.scheduleAt) > new Date() ? <span className="badge">⏰ {new Date(card.scheduleAt).toLocaleString()}</span> : null}
      {card.retryCount ? <span className="badge">{t('kanban.retry')} {card.retryCount}/{card.maxRetries ?? 3}</span> : null}
      {card.costUsd && <span className="badge">${card.costUsd}</span>}
      {card.tags?.map((tag) => <span className="badge" key={tag}>{tag}</span>)}
    </div>
    {workflowTag && <div className={`kanban-card-owner-tag ${workflowTag.type === 'Review' ? 'review' : 'process'}`}>[{workflowTag.type}: {workflowTag.name}]</div>}
  </article>;
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3200); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 8, background: type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontSize: 14, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.25)' }}>
    {message}
  </motion.div>;
}

export function KanbanBoard() {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const [cards, setCards] = useState<Card[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [draft, setDraft] = useState<Partial<Card> | null>(null);
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [actions, setActions] = useState<CardAction[]>([]);
  const [apiLogs, setApiLogs] = useState<ApiEvent[]>([]);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [workProducts, setWorkProducts] = useState<WorkProduct[]>([]);
  const [delegationSummary, setDelegationSummary] = useState<CardDelegationSummary | null>(null);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [cardTabCache, setCardTabCache] = useState<Record<string, CardTabCache>>(() => readCardTabCache());
  const [tabLoading, setTabLoading] = useState<Record<CardTabKey, boolean>>({ comments: false, logs: false, actions: false, apiLogs: false, workProducts: false, delegationSummary: false });
  // Detail layout: the v2 overview panel by default, the PR-0 tabs one toggle away.
  const [detailLayout, setDetailLayoutState] = useState<DetailLayout>(() => readDetailLayout());
  const defaultDetailTab = defaultTabFor(detailLayout);
  const [tab, setTab] = useState<CardDetailTab>(() => defaultTabFor(readDetailLayout()));
  const [overviewEditing, setOverviewEditing] = useState(false);
  // 對話 tab sort + filter, persisted per viewer; the unread line's baseline is
  // captured when a card opens and written back when it closes.
  const [conversationView, setConversationViewState] = useState<ConversationView>(() => readConversationView());
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const [liveDebounce] = useState(() => createKeyedDebounce(LIVE_DEBOUNCE_MS));
  useEffect(() => () => liveDebounce.cancel(), [liveDebounce]);
  const [commentBody, setCommentBody] = useState('');
  const [commentAction, setCommentAction] = useState<'comment' | 'agent_note' | 'pause_agent' | 'send_to_agent' | 'continue_run' | 'escalate_to_reviewer' | 'delegate_to_agent'>('comment');
  const [commentAgentId, setCommentAgentId] = useState('');
  const [commentDelegateAssigneeId, setCommentDelegateAssigneeId] = useState('');
  const [commentDelegateReviewerId, setCommentDelegateReviewerId] = useState('');
  const [commentDelegateScope, setCommentDelegateScope] = useState<'phase' | 'final'>('phase');
  const [modalOpen, setModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newReviewer, setNewReviewer] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newDepartment, setNewDepartment] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [newPriority, setNewPriority] = useState<(typeof priorities)[number]>('normal');
  const [newTags, setNewTags] = useState('');
  const [newDependencies, setNewDependencies] = useState<string[]>([]);
  const [newDecisionMode, setNewDecisionMode] = useState<'auto' | 'solo' | 'pair' | 'swarm'>('auto');
  // Blind review panel (§17): the review mode, the critical flag and the named seats (max 2).
  const [newReviewMode, setNewReviewMode] = useState<'single' | 'panel'>('single');
  const [newCritical, setNewCritical] = useState(false);
  const [newReviewerIds, setNewReviewerIds] = useState<string[]>([]);
  const [newScheduleAt, setNewScheduleAt] = useState('');
  const [newRecurMinutes, setNewRecurMinutes] = useState('');
  const [workProductType, setWorkProductType] = useState<(typeof workProductTypes)[number] | 'auto'>('auto');
  const [workProductTitle, setWorkProductTitle] = useState('');
  const [workProductSummary, setWorkProductSummary] = useState('');
  const [workProductUrl, setWorkProductUrl] = useState('');
  const [workProductRepoProvider, setWorkProductRepoProvider] = useState('');
  const [workProductRepoUrl, setWorkProductRepoUrl] = useState('');
  const [workProductBranch, setWorkProductBranch] = useState('');
  const [workProductCommitSha, setWorkProductCommitSha] = useState('');
  const [workProductPullRequestUrl, setWorkProductPullRequestUrl] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [forceBrainstorm, setForceBrainstorm] = useState(false);
  const [brainstormDepartmentIds, setBrainstormDepartmentIds] = useState<string[]>([]);
  const [filterCompany, setFilterCompany] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [sortMode, setSortMode] = useState<'priority' | 'company' | 'created_desc' | 'created_asc' | 'updated_desc'>('priority');
  // List is the manager's default view; the wall stays one toggle away.
  const [viewMode, setViewMode] = useState<'list' | 'wall'>(() => {
    try { return window.localStorage.getItem('megacorps.kanbanView') === 'wall' ? 'wall' : 'list'; } catch { return 'list'; }
  });
  function switchView(next: 'list' | 'wall') {
    setViewMode(next);
    try { window.localStorage.setItem('megacorps.kanbanView', next); } catch { /* per-viewer convenience only */ }
  }
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedIdRef = useRef<string | null>(null);
  // The card the edit draft was seeded from. The close guard measures the
  // draft against this row, not the live `selected`: a status or assignee
  // change landing under an open panel is not an edit the reader made.
  const draftBaseRef = useRef<Card | null>(null);
  const boardQuery = useQuery({ queryKey: ['kanbanBoard'], queryFn: fetchKanbanBoard });
  const selectedId = selected?.id ?? null;
  // A parent card: rollup set, a split round recorded, or a board card pointing at it.
  const selectedIsParent = useMemo(() => Boolean(selected && (selected.rollupStatus || (selected.splitRound ?? 0) > 0 || cards.some((card) => card.parentCardId === selected.id))), [selected, cards]);
  const approvalsQuery = useQuery({
    queryKey: ['cardApprovals', selectedId],
    queryFn: () => api<CardApproval[]>(`/api/approvals?cardId=${selectedId}&limit=20`),
    enabled: Boolean(selectedId),
  });
  const subtreeQuery = useQuery({
    queryKey: ['cardSubtree', selectedId],
    queryFn: () => api<SubtreeCard[]>(`/api/cards/${selectedId}/subtree`),
    enabled: Boolean(selectedId) && selectedIsParent,
  });
  // Blind review rounds (§17): the situation line, the chips and the 對話
  // tab's findings tables read them; invalidated on card.* live events below.
  const reviewRoundsQuery = useQuery({
    queryKey: ['cardReviewRounds', selectedId],
    queryFn: () => api<ReviewRound[]>(`/api/cards/${selectedId}/review-rounds`),
    enabled: Boolean(selectedId),
  });
  const cardApprovals = selectedId && approvalsQuery.data ? approvalsQuery.data : null;
  const cardReviewRounds = selectedId && reviewRoundsQuery.data ? reviewRoundsQuery.data : null;
  const cardChildren = useMemo(() => (selectedId && selectedIsParent && subtreeQuery.data ? subtreeQuery.data.filter((row) => row.depth === 1) : null), [selectedId, selectedIsParent, subtreeQuery.data]);

  // Every selection change goes through here so selectedIdRef is right before
  // the commit: the loaders compare against it, and a board reload resolves
  // the selection from it when the rows arrive.
  function selectCard(card: Card | null) {
    selectedIdRef.current = card?.id ?? null;
    setSelected(card);
  }

  function seedDraft(card: Card) {
    draftBaseRef.current = card;
    setDraft(draftFromCard(card));
  }

  // Selection after a board reload, resolved when the rows arrive rather than
  // in the render that scheduled it: a panel the reader closed meanwhile stays
  // closed, a switch to another card sticks, and a card the board's rows do
  // not include (a child opened from the subtree; GET /api/cards is capped)
  // stays open. Only card.deleted and deleteSelected close the panel.
  function syncSelectedWith(nextCards: Card[]) {
    setSelected((previous) => {
      const id = selectedIdRef.current;
      if (!id) return null;
      return nextCards.find((card) => card.id === id) ?? previous;
    });
  }

  async function refresh() {
    setLoading(true);
    try {
      const { cards: nextCards, agents: nextAgents, companies: nextCompanies, departments: nextDepartments, projects: nextProjects, goals: nextGoals } = await queryClient.fetchQuery({ queryKey: ['kanbanBoard'], queryFn: fetchKanbanBoard });
      setCards(nextCards);
      setAgents(nextAgents);
      setCompanies(nextCompanies);
      setDepartments(nextDepartments);
      setProjects(nextProjects);
      setGoals(nextGoals);
      if (!newCompany && nextCompanies[0]) setNewCompany(nextCompanies[0].id);
      const onlyCompany = nextCompanies.length === 1 ? nextCompanies[0] : undefined;
      if (!filterCompany && onlyCompany) setFilterCompany(onlyCompany.id);
      syncSelectedWith(nextCards);
    } catch (err) {
      if (isQueryCancellation(err)) return;
      setToast({ message: err instanceof Error ? err.message : t('kanban.loadFailed'), type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  function saveCardTabCache(cardId: string, patch: CardTabCache) {
    setCardTabCache((current) => {
      const next = pruneCardTabCache({ ...current, [cardId]: { ...(current[cardId] ?? {}), ...patch } });
      writeCardTabCache(next);
      return next;
    });
  }

  function deleteCardTabCache(cardId: string) {
    setCardTabCache((current) => {
      const next = { ...current };
      delete next[cardId];
      writeCardTabCache(next);
      return next;
    });
  }

  function setLoadingKey(key: CardTabKey, value: boolean) {
    setTabLoading((current) => ({ ...current, [key]: value }));
  }

  async function loadCardComments(card: Card, force = false): Promise<CardComment[]> {
    const cached = cardTabCache[card.id]?.comments;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setComments(cached?.rows ?? []);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('comments', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardComments', card.id] });
      const rows = await queryClient.fetchQuery({ queryKey: ['cardComments', card.id], queryFn: () => api<CardComment[]>(`/api/cards/${card.id}/comments`) });
      saveCardTabCache(card.id, { comments: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setComments(rows);
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setComments([]);
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('comments', false);
    }
  }

  async function loadCardDelegationSummary(card: Card, force = false): Promise<CardDelegationSummary | null> {
    const cached = cardTabCache[card.id]?.delegationSummary;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setDelegationSummary(cached?.value ?? null);
      return cached?.value ?? null;
    }
    if (!cached) setLoadingKey('delegationSummary', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardDelegationSummary', card.id] });
      const value = await queryClient.fetchQuery({
        queryKey: ['cardDelegationSummary', card.id],
        queryFn: () => api<CardDelegationSummary>(`/api/cards/${card.id}/delegation-summary`),
      });
      saveCardTabCache(card.id, { delegationSummary: { value, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setDelegationSummary(value);
      return value;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setDelegationSummary(null);
      return cached?.value ?? null;
    } finally {
      setLoadingKey('delegationSummary', false);
    }
  }

  async function loadCardLogs(card: Card, force = false): Promise<TaskLog[]> {
    const cached = cardTabCache[card.id]?.logs;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setLogs(cached?.rows ?? []);
      if (selectedIdRef.current === card.id) setLogsHasMore((cached?.rows.length ?? 0) >= CARD_LOG_PAGE_SIZE);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('logs', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardLogs', card.id] });
      const rows = await queryClient.fetchQuery({ queryKey: ['cardLogs', card.id, CARD_LOG_PAGE_SIZE, 0], queryFn: () => api<TaskLog[]>(`/api/cards/${card.id}/logs?limit=${CARD_LOG_PAGE_SIZE}`) });
      saveCardTabCache(card.id, { logs: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) {
        setLogs(rows);
        setLogsHasMore(rows.length >= CARD_LOG_PAGE_SIZE);
      }
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) {
        setLogs([]);
        setLogsHasMore(false);
      }
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('logs', false);
    }
  }

  async function loadMoreCardLogs(card: Card): Promise<void> {
    setLoadingKey('logs', true);
    try {
      const offset = logs.length;
      const rows = await api<TaskLog[]>(`/api/cards/${card.id}/logs?limit=${CARD_LOG_PAGE_SIZE}&offset=${offset}`);
      const nextRows = [...logs, ...rows];
      setLogs(nextRows);
      setLogsHasMore(rows.length >= CARD_LOG_PAGE_SIZE);
      saveCardTabCache(card.id, { logs: { rows: nextRows, cachedAt: Date.now() } });
    } catch (err) {
      if (!isQueryCancellation(err)) setToast({ message: err instanceof Error ? err.message : t('kanban.loadFailed'), type: 'error' });
    } finally {
      setLoadingKey('logs', false);
    }
  }

  async function loadCardActions(card: Card, force = false): Promise<CardAction[]> {
    const cached = cardTabCache[card.id]?.actions;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setActions(cached?.rows ?? []);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('actions', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardActions', card.id] });
      const rows = await queryClient.fetchQuery({ queryKey: ['cardActions', card.id], queryFn: () => api<CardAction[]>(`/api/cards/${card.id}/actions`) });
      saveCardTabCache(card.id, { actions: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setActions(rows);
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setActions([]);
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('actions', false);
    }
  }

  async function loadCardApiLogs(card: Card, force = false): Promise<ApiEvent[]> {
    const cached = cardTabCache[card.id]?.apiLogs;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setApiLogs(cached?.rows ?? []);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('apiLogs', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['systemLogs', 250] });
      const events = await queryClient.fetchQuery({ queryKey: ['systemLogs', 250], queryFn: () => api<ApiEvent[]>('/api/system-logs?limit=250') });
      const rows = events.filter((event) => apiEventMentionsCard(event, card.id));
      saveCardTabCache(card.id, { apiLogs: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setApiLogs(rows);
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setApiLogs([]);
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('apiLogs', false);
    }
  }

  async function loadCardWorkProducts(card: Card, force = false): Promise<WorkProduct[]> {
    const cached = cardTabCache[card.id]?.workProducts;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setWorkProducts(cached?.rows ?? []);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('workProducts', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardWorkProducts', card.id] });
      const rows = await queryClient.fetchQuery({
        queryKey: ['cardWorkProducts', card.id],
        queryFn: () => api<WorkProduct[]>(`/api/cards/${card.id}/work-products`),
      });
      saveCardTabCache(card.id, { workProducts: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setWorkProducts(rows);
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setWorkProducts([]);
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('workProducts', false);
    }
  }

  function selectTab(next: CardDetailTab) {
    setTab(next);
    if (!selected) return;
    if (next === 'conversation') {
      void loadCardComments(selected);
      void loadCardLogs(selected);
      void loadCardActions(selected);
      void loadCardWorkProducts(selected);
    }
    if (next === 'details') void loadCardDelegationSummary(selected);
    if (next === 'comments' || next === 'delegation') void loadCardComments(selected);
    if (next === 'thread') {
      void loadCardLogs(selected);
      void loadCardActions(selected);
      void loadCardWorkProducts(selected);
    }
    if (next === 'logs') {
      void loadCardLogs(selected);
      void loadCardActions(selected);
      void loadCardApiLogs(selected);
    }
    if (next === 'workProducts') void loadCardWorkProducts(selected);
  }

  useEffect(() => {
    if (!boardQuery.data) return;
    setCards(boardQuery.data.cards);
    setAgents(boardQuery.data.agents);
    setCompanies(boardQuery.data.companies);
    setDepartments(boardQuery.data.departments);
    setProjects(boardQuery.data.projects);
    setGoals(boardQuery.data.goals);
    if (!newCompany && boardQuery.data.companies[0]) setNewCompany(boardQuery.data.companies[0].id);
    const onlyCompany = boardQuery.data.companies.length === 1 ? boardQuery.data.companies[0] : undefined;
    if (!filterCompany && onlyCompany) setFilterCompany(onlyCompany.id);
    syncSelectedWith(boardQuery.data.cards);
    setLoading(false);
  }, [boardQuery.data]);
  useEffect(() => {
    if (!boardQuery.error) return;
    setToast({ message: boardQuery.error instanceof Error ? boardQuery.error.message : t('kanban.loadFailed'), type: 'error' });
    setLoading(false);
  }, [boardQuery.error]);
  useEffect(() => {
    function onLive(event: Event) {
      const detail = (event as CustomEvent<LiveEvent>).detail;
      if (!detail?.type) return;
      if (detail.type === 'card.deleted' && detail.cardId === selected?.id) {
        selectCard(null);
        void refresh();
        return;
      }
      // Every reload below is debounced per key (400 ms, newest closure wins),
      // the whole-board refresh included, so one burst costs one request each.
      const cardEvent = detail.type.startsWith('card.') || detail.type === 'activity.created';
      if (cardEvent) liveDebounce.run('refresh', () => void refresh());
      if (selected && cardEvent) {
        // Approvals, the subtree and the review rounds have no live event of
        // their own, and a child card's event carries the child's id: refresh
        // all three on any card.* event.
        const id = selected.id;
        liveDebounce.run(`approvals:${id}`, () => {
          void queryClient.invalidateQueries({ queryKey: ['cardApprovals', id] });
          void queryClient.invalidateQueries({ queryKey: ['cardSubtree', id] });
          void queryClient.invalidateQueries({ queryKey: ['cardReviewRounds', id] });
        });
      }
      const affectsSelectedCard = Boolean(selected && detail.cardId === selected.id);
      if (!selected || !affectsSelectedCard) return;
      const card = selected;
      const reload = (key: CardTabKey, loader: (target: Card, force?: boolean) => Promise<unknown>) => liveDebounce.run(`${key}:${card.id}`, () => void loader(card, true));
      if (detail.type === 'card.comment.created') {
        reload('comments', loadCardComments);
        reload('delegationSummary', loadCardDelegationSummary);
      }
      if (detail.type === 'task_log.created') reload('logs', loadCardLogs);
      if (detail.type === 'card.action.created') reload('actions', loadCardActions);
      if (detail.type === 'work_product.created') reload('workProducts', loadCardWorkProducts);
      // POST /comments, PUT /approvals and recordStageAction insert task_logs and
      // card_actions without a live event of their own; card.updated is the
      // signal that they landed, so the system rows do not arrive late.
      if (detail.type === 'card.updated') {
        reload('logs', loadCardLogs);
        reload('actions', loadCardActions);
      }
    }
    window.addEventListener('megacorps-live', onLive);
    return () => window.removeEventListener('megacorps-live', onLive);
  }, [selected?.id, tab]);
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    setOverviewEditing(false);
    // Unread baseline: what this viewer had seen when the card opened. The
    // cleanup records the close time (also when switching straight to another card).
    const seenId = selected?.id ?? null;
    setLastSeenAt(seenId ? readCardSeen()[seenId] ?? null : null);
    const markSeen = () => { if (seenId) writeCardSeen(rememberCardSeen(readCardSeen(), seenId, Date.now())); };
    if (!selected) {
      draftBaseRef.current = null;
      setDraft(null);
      setLogs([]);
      setActions([]);
      setApiLogs([]);
      setComments([]);
      setWorkProducts([]);
      setDelegationSummary(null);
      setLogsHasMore(false);
      return;
    }
    seedDraft(selected);
    setCommentDelegateReviewerId(selected.assigneeId ?? selected.reviewerId ?? '');
    const cached = cardTabCache[selected.id] ?? {};
    setComments(cached.comments?.rows ?? []);
    setLogs(cached.logs?.rows ?? []);
    setActions(cached.actions?.rows ?? []);
    setApiLogs(cached.apiLogs?.rows ?? []);
    setWorkProducts(cached.workProducts?.rows ?? []);
    setDelegationSummary(cached.delegationSummary?.value ?? null);
    setLogsHasMore((cached.logs?.rows.length ?? 0) >= CARD_LOG_PAGE_SIZE);
    const timer = window.setTimeout(() => {
      // The overview's situation line and runtime block need the summary on every open.
      void loadCardDelegationSummary(selected);
      if (tab === 'conversation') {
        void loadCardComments(selected);
        void loadCardLogs(selected);
        void loadCardActions(selected);
        void loadCardWorkProducts(selected);
      }
      if (tab === 'comments' || tab === 'delegation') void loadCardComments(selected);
      if (tab === 'thread') {
        void loadCardLogs(selected);
        void loadCardActions(selected);
        void loadCardWorkProducts(selected);
      }
      if (tab === 'logs') {
        void loadCardLogs(selected);
        void loadCardActions(selected);
        void loadCardApiLogs(selected);
      }
      if (tab === 'workProducts') void loadCardWorkProducts(selected);
    }, 150);
    return () => {
      window.clearTimeout(timer);
      markSeen();
    };
  }, [selected?.id]);
  // Same card, fresher row (a reload, an action's response, a live event): a
  // clean draft follows it so a later save never posts a stale stage. An open
  // edit form or unsaved edits keep the draft the reader is working on.
  useEffect(() => {
    if (selected && shouldReseedDraft(draft, draftBaseRef.current, selected, overviewEditing)) seedDraft(selected);
  }, [selected]);

  const companyNameById = useMemo(() => new Map(companies.map((company) => [company.id, company.name])), [companies]);
  const visibleCards = useMemo(() => cards.filter((card) => {
    if (filterCompany && card.companyId !== filterCompany) return false;
    if (filterAssignee && card.assigneeId !== filterAssignee) return false;
    if (filterProject === '__none' && card.projectId) return false;
    if (filterProject && filterProject !== '__none' && card.projectId !== filterProject) return false;
    if (query && !`${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    if (sortMode === 'company') {
      const companyCompare = (companyNameById.get(a.companyId ?? '') ?? '').localeCompare(companyNameById.get(b.companyId ?? '') ?? '');
      if (companyCompare !== 0) return companyCompare;
      return b.priority - a.priority;
    }
    if (sortMode === 'created_desc') return Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '');
    if (sortMode === 'created_asc') return Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? '');
    if (sortMode === 'updated_desc') return Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '');
    return b.priority - a.priority;
  }), [cards, companyNameById, filterAssignee, filterCompany, filterProject, query, sortMode]);
  const boardCards = visibleCards;

  function changeNewCompany(next: string) {
    setNewCompany(next); setNewDepartment(''); setNewProject(''); setNewGoal('');
    setNewAssignee(''); setNewReviewer(''); setNewDependencies([]); setNewReviewerIds([]); setBrainstormDepartmentIds([]);
  }

  function openNewCard() {
    const next = companies.find(company => company.id === filterCompany)?.id
      ?? companies.find(company => company.id === newCompany)?.id ?? companies[0]?.id ?? '';
    if (next !== newCompany) changeNewCompany(next);
    setModalOpen(true);
  }

  async function create() {
    if (!newTitle.trim()) { setToast({ message: t('kanban.titleRequired'), type: 'error' }); return; }
    setBusy(true);
    try {
      const card = await api<Card>('/api/cards', {
        method: 'POST',
        body: JSON.stringify({
          title: newTitle.trim(),
          body: newBody.trim() || newTitle.trim(),
          tags: parseCsv(newTags),
          priority: newPriority,
          companyId: newCompany || undefined,
          departmentId: newDepartment || null,
          projectId: newProject || null,
          goalId: newGoal || null,
          assigneeId: newAssignee || null,
          reviewerId: newReviewer || null,
          dependencyCardIds: newDependencies,
          decisionMode: newDecisionMode,
          reviewMode: newReviewMode,
          critical: newCritical,
          reviewerIds: newReviewMode === 'panel' ? newReviewerIds : [],
          requiresApproval,
          forceBrainstorm,
          brainstormDepartmentIds: forceBrainstorm ? brainstormDepartmentIds : [],
          scheduleAt: newScheduleAt ? new Date(newScheduleAt).toISOString() : null,
          recurEveryMinutes: newRecurMinutes ? Number(newRecurMinutes) : null,
        }),
      });
      setCards([card, ...cards]);
      setNewTitle('');
      setNewBody('');
      setNewAssignee('');
      setNewReviewer('');
      setNewDepartment('');
      setNewProject('');
      setNewGoal('');
      setNewPriority('normal');
      setNewTags('');
      setNewDependencies([]);
      setNewDecisionMode('auto');
      setNewReviewMode('single');
      setNewCritical(false);
      setNewReviewerIds([]);
      setNewScheduleAt('');
      setNewRecurMinutes('');
      setRequiresApproval(false);
      setForceBrainstorm(false);
      setBrainstormDepartmentIds([]);
      setModalOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
      setToast({ message: `${t('kanban.cardCreated')}: ${card.title}`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.createFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function updateCard(card: Card, patch: CardUpdatePayload) {
    const updated = await api<Card>(`/api/cards/${card.id}`, { method: 'PUT', body: JSON.stringify({ ...patch, updatedAt: card.updatedAt }) });
    setCards(cards.map((item) => (item.id === updated.id ? updated : item)));
    selectCard(updated);
    seedDraft(updated);
    void loadCardLogs(updated, true);
    void loadCardActions(updated, true);
    void loadCardApiLogs(updated, true);
    void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
    return updated;
  }

  async function saveSelected() {
    if (!selected || !draft) return;
    setBusy(true);
    try {
      await updateCard(selected, {
        title: String(draft.title ?? selected.title),
        body: String(draft.body ?? selected.body),
        columnStatus: String(draft.columnStatus ?? selected.columnStatus),
        assigneeId: draft.assigneeId ?? null,
        reviewerId: draft.reviewerId ?? null,
        departmentId: draft.departmentId ?? null,
        projectId: draft.projectId ?? null,
        goalId: draft.goalId ?? null,
        priority: priorityValue(priorityNumber(draft.priority ?? selected.priority)),
        tags: draft.tags ?? [],
        dependencyCardIds: draft.dependencyCardIds ?? [],
        decisionMode: draft.decisionMode ?? null,
        requiresApproval: Boolean(draft.requiresApproval),
        maxRetries: Number(draft.maxRetries ?? selected.maxRetries ?? 3),
        reviewMode: draft.reviewMode ?? selected.reviewMode ?? 'single',
        critical: Boolean(draft.critical),
        reviewerIds: draft.reviewerIds ?? [],
      });
      setToast({ message: t('kanban.cardSaved'), type: 'success' });
      setOverviewEditing(false);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.saveFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    if (!selected) return;
    seedDraft(selected);
  }

  async function onDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const over = event.over?.id ? String(event.over.id) : '';
    const card = cards.find((c) => c.id === id);
    const group = statusGroupById(over);
    const nextStatus = group?.dropStatus ?? (statuses.includes(over as CardStatus) ? (over as CardStatus) : null);
    if (!card || !nextStatus || card.columnStatus === nextStatus || group?.statuses.includes(card.columnStatus as CardStatus)) return;
    try { await updateCard(card, { columnStatus: nextStatus }); }
    catch (err) { setToast({ message: err instanceof Error ? err.message : t('kanban.moveFailed'), type: 'error' }); }
  }

  async function action(path: string, message: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api<Card | Card[] | TaskRun>(path, { method: 'POST' });
      if (Array.isArray(result)) {
        setCards([...result, ...cards]);
        setToast({ message, type: 'success' });
      } else if ('kind' in result && 'cardId' in result) {
        setToast({ message: `${result.kind} ${t('kanban.queued')} (${result.status})`, type: 'success' });
        await refresh();
      } else {
        setCards(cards.map((card) => (card.id === result.id ? result : card)));
        // The reader may have closed the panel or moved on while the request ran.
        if (selectedIdRef.current === result.id) setSelected(result);
        setToast({ message, type: 'success' });
      }
      void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
      if (selected) await Promise.all([loadCardLogs(selected, true), loadCardActions(selected, true), loadCardApiLogs(selected, true)]);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('common.actionFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    const confirmed = window.confirm(`${t('kanban.deleteConfirm')} "${selected.title}"?`);
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`/api/cards/${selected.id}`, { method: 'DELETE' });
      setCards(cards.filter((card) => card.id !== selected.id).map((card) => (card.parentCardId === selected.id ? { ...card, parentCardId: null } : card)));
      deleteCardTabCache(selected.id);
      selectCard(null);
      void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
      setToast({ message: t('kanban.taskDeleted'), type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.deleteFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    if (!selected || !commentBody.trim()) return;
    if (commentAction === 'delegate_to_agent' && !commentDelegateAssigneeId) {
      setToast({ message: t('kanban.delegateAssigneeRequired'), type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const effectiveAction = commentAgentId ? 'agent_note' : commentAction;
      const comment = await api<CardComment>(`/api/cards/${selected.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: commentBody.trim(),
          action: effectiveAction,
          agentId: commentAgentId || null,
          assigneeAgentId: effectiveAction === 'delegate_to_agent' ? commentDelegateAssigneeId : null,
          reviewerAgentId: effectiveAction === 'delegate_to_agent' ? commentDelegateReviewerId || selected.assigneeId || selected.reviewerId || null : null,
          reviewerScope: effectiveAction === 'delegate_to_agent' ? commentDelegateScope : null,
        }),
      });
      const nextComments = [comment, ...comments];
      setComments(nextComments);
      saveCardTabCache(selected.id, { comments: { rows: nextComments, cachedAt: Date.now() } });
      void queryClient.invalidateQueries({ queryKey: ['cardComments', selected.id] });
      void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
      void loadCardActions(selected, true);
      setCommentBody('');
      if (effectiveAction === 'delegate_to_agent') setCommentDelegateAssigneeId('');
      setToast({ message: effectiveAction === 'pause_agent' ? t('kanban.agentPausedBlocked') : effectiveAction === 'continue_run' ? t('kanban.taskQueuedContinue') : effectiveAction === 'escalate_to_reviewer' ? t('kanban.taskEscalated') : effectiveAction === 'delegate_to_agent' ? t('kanban.delegationQueued') : t('kanban.messageAdded'), type: 'success' });
      await refresh();
      await Promise.all([loadCardLogs(selected, true), loadCardActions(selected, true), loadCardApiLogs(selected, true)]);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.commentFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function addWorkProduct() {
    if (!selected || !workProductTitle.trim()) return;
    setBusy(true);
    try {
      const product = await api<WorkProduct>(`/api/cards/${selected.id}/work-products`, {
        method: 'POST',
        body: JSON.stringify({
          type: workProductType === 'auto' ? inferWorkProductType(workProductUrl || workProductPullRequestUrl) : workProductType,
          title: workProductTitle.trim(),
          summary: workProductSummary || null,
          url: workProductUrl || null,
          repoProvider: workProductRepoProvider || null,
          repoUrl: workProductRepoUrl || null,
          branch: workProductBranch || null,
          commitSha: workProductCommitSha || null,
          pullRequestUrl: workProductPullRequestUrl || null,
        }),
      });
      const nextProducts = [product, ...workProducts];
      setWorkProducts(nextProducts);
      saveCardTabCache(selected.id, { workProducts: { rows: nextProducts, cachedAt: Date.now() } });
      void queryClient.invalidateQueries({ queryKey: ['cardWorkProducts', selected.id] });
      setWorkProductTitle('');
      setWorkProductSummary('');
      setWorkProductUrl('');
      setWorkProductRepoProvider('');
      setWorkProductRepoUrl('');
      setWorkProductBranch('');
      setWorkProductCommitSha('');
      setWorkProductPullRequestUrl('');
      setToast({ message: t('kanban.workProductAdded'), type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.workProductFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Close guard: an edited draft or an unsent comment keeps the panel open when
  // the backdrop is clicked; the × asks first. "Edited" is measured against the
  // row the draft was seeded from (draftBaseRef), so a card that changed under
  // the panel does not trip it. The card.deleted live path and deleteSelected
  // call selectCard(null) directly and bypass this.
  const draftBase = draftBaseRef.current;
  const draftDirty = Boolean(selected && draft && draftBase && isDraftDirty(draft, draftBase));
  const detailDirty = draftDirty || commentBody.trim().length > 0;
  function closePanel(source: 'overlay' | 'button') {
    if (!selected) return;
    if (detailDirty) {
      if (source === 'overlay') { setToast({ message: t('kanban.closeBlocked'), type: 'error' }); return; }
      if (!window.confirm(t('kanban.closeDiscard'))) return;
    }
    selectCard(null);
  }
  function openCard(card: Card) {
    if (selected?.id === card.id) return;
    if (selected && detailDirty && !window.confirm(t('kanban.closeDiscard'))) return;
    selectCard(cards.find((item) => item.id === card.id) ?? card);
    setTab(defaultDetailTab);
  }
  function setDetailLayout(next: DetailLayout) {
    setDetailLayoutState(next);
    try { window.localStorage.setItem(DETAIL_LAYOUT_KEY, next); } catch { /* per-viewer convenience only */ }
    setOverviewEditing(false);
    // A tab the target layout lacks maps onto its nearest equivalent.
    if (next === 'v2' && (tab === 'details' || tab === 'comments' || tab === 'delegation' || tab === 'thread')) selectTab(defaultTabFor(next));
    if (next === 'legacy' && tab === 'conversation') selectTab('comments');
  }
  function setConversationView(next: ConversationView) {
    setConversationViewState(next);
    try { window.localStorage.setItem(CONVERSATION_VIEW_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  }
  // The 對話 tab's model over whatever rows are loaded; `.latest` is the
  // overview's "last activity" line (computed from the unfiltered rows, so the
  // filter never changes it).
  const conversation = useMemo<Conversation>(() => {
    if (!selected) return EMPTY_CONVERSATION;
    try {
      return buildConversation({ comments, logs, actions, workProducts, approvals: cardApprovals, agents, you: { name: t('common.you') }, logsHasMore, lastSeenAt }, conversationView);
    } catch {
      return EMPTY_CONVERSATION;
    }
  }, [selected?.id, comments, logs, actions, workProducts, cardApprovals, agents, locale, logsHasMore, lastSeenAt, conversationView]);
  const conversationLatest = conversation.latest;
  async function afterApprovalChange(message: string) {
    if (!selected) return;
    const card = selected;
    setToast({ message, type: 'success' });
    await queryClient.invalidateQueries({ queryKey: ['cardApprovals', card.id] });
    void queryClient.invalidateQueries({ queryKey: ['cardReviewRounds', card.id] });
    void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
    await refresh();
    await Promise.all([loadCardComments(card, true), loadCardLogs(card, true), loadCardActions(card, true), loadCardDelegationSummary(card, true)]);
  }

  return <>
    <div className="kanban-toolbar">
      <div className="input-wrap" style={{ flex: '1 1 260px' }}><Search size={15} /><input placeholder={t('common.search')} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <select className="input compact" value={filterCompany} onChange={(e) => { setFilterCompany(e.target.value); setFilterProject(''); setFilterAssignee(''); }}>
        <option value="">{t('kanban.allCompanies')}</option>
        {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
      </select>
      <select className="input compact" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
        <option value="">{t('kanban.allAgents')}</option>
        {agents.filter((agent) => !filterCompany || agent.companyId === filterCompany).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
      </select>
      <select className="input compact" value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
        <option value="">{t('kanban.allProjects')}</option>
        <option value="__none">{t('chat.noProject')}</option>
        {projects.filter((project) => !filterCompany || project.companyId === filterCompany).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
      </select>
      <select className="input compact" value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)}>
        <option value="priority">{t('kanban.sortPriority')}</option>
        <option value="company">{t('kanban.sortCompany')}</option>
        <option value="created_desc">{t('kanban.sortNewest')}</option>
        <option value="created_asc">{t('kanban.sortOldest')}</option>
        <option value="updated_desc">{t('kanban.sortUpdated')}</option>
      </select>
      <div className="tab-row" style={{ margin: 0 }}>
        <button className={`tab ${viewMode === 'list' ? 'active' : ''}`} onClick={() => switchView('list')}>{t('kanban.viewList')}</button>
        <button className={`tab ${viewMode === 'wall' ? 'active' : ''}`} onClick={() => switchView('wall')}>{t('kanban.viewWall')}</button>
      </div>
      <button className="btn" onClick={() => void refresh()}><RefreshCw size={15} /></button>
      <button className="btn btn-primary" onClick={openNewCard}><Plus size={15} /> {t('newCard')}</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.55 }}>{t('common.loading')}</p> : viewMode === 'list' ? (
      <KanbanListView
        cards={boardCards}
        agents={agents}
        departments={departments}
        projects={projects}
        statusLabel={(status) => statusLabels[status as CardStatus]?.[locale] ?? status}
        statusColor={statusColor}
        onSelect={(card) => { const full = cards.find((item) => item.id === card.id); if (full) { selectCard(full); setTab(defaultDetailTab); } }}
      />
    ) : (
      <DndContext onDragEnd={onDragEnd}>
        <div className="kanban-columns">
          {statusGroups.map((group) => <Column
            key={group.id}
            group={group}
            agents={agents}
            companies={companies}
            cards={cardsForStatusGroup(boardCards, group)}
            onSelect={(card) => { selectCard(card); setTab(defaultDetailTab); }}
          />)}
        </div>
      </DndContext>
    )}

    <AnimatePresence>
      {modalOpen && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="card modal kanban-create-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('newCard')}
            initial={{ scale: 0.96, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 12 }}
            onKeyDown={(e) => { if (e.key === 'Escape') setModalOpen(false); }}
          >
            <div className="panel-title"><h2>{t('newCard')}</h2><button className="btn" aria-label={t('common.close')} onClick={() => setModalOpen(false)}><X size={16} /></button></div>
            <div className="kanban-create-modal-body">
              <label className="field-label">{t('common.title')}<input className="input" maxLength={160} required autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /></label>
              <label className="field-label">{t('forms.request')}<textarea className="input" value={newBody} onChange={(e) => setNewBody(e.target.value)} rows={5} /></label>
              <div className="form-grid">
                <label className="field-label">{t('common.company')}
                <select className="input" value={newCompany} onChange={(e) => changeNewCompany(e.target.value)}><option value="">{t('common.company')}</option>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select>
                </label>
                <label className="field-label">{t('common.project')}
                <select className="input" value={newProject} onChange={(e) => { setNewProject(e.target.value); setNewGoal(''); setNewDependencies([]); }}><option value="">{t('common.project')}</option>{projects.filter((project) => !newCompany || project.companyId === newCompany).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
                </label>
              </div>
              <p className="field-hint">{t('forms.routingHelp')}</p>
              <details className="form-advanced">
                <summary>{t('forms.advanced')}</summary>
              <div className="action-row brief-template-row">
                <button type="button" className="btn" onClick={() => setNewBody(insertBriefTemplate(newBody))}><FileText size={14} /> {t('kanban.insertBriefTemplate')}</button>
                <span className="field-hint">{t('kanban.briefTemplateHint')}</span>
              </div>
              <div className="form-grid">
                <label className="field-label">{t('common.department')}
                <select className="input" value={newDepartment} onChange={(e) => { setNewDepartment(e.target.value); setNewGoal(''); }}><option value="">{t('common.department')}</option>{departments.filter((department) => !newCompany || department.companyId === newCompany).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select>
                </label>
                <label className="field-label">{t('kanban.goal')}
                <select className="input" value={newGoal} onChange={(e) => setNewGoal(e.target.value)}><option value="">{t('kanban.goal')}</option>{scopedGoalOptions(goals, { companyId: newCompany, departmentId: newDepartment, projectId: newProject }).map((goal) => <option value={goal.id} key={goal.id}>{goalScope(goal)} / {goal.title}</option>)}</select>
                </label>
                <label className="field-label">{t('kanban.assignee')}
                <select className="input" value={newAssignee} onChange={(e) => { setNewAssignee(e.target.value); setNewReviewer(current => current === e.target.value ? '' : current); setNewReviewerIds((current) => current.filter((id) => id !== e.target.value)); }}><option value="">{t('kanban.assignee')}</option>{agents.filter((agent) => !newCompany || agent.companyId === newCompany).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                </label>
                <label className="field-label">{t('kanban.reviewer')}
                <select className="input" value={newReviewer} onChange={(e) => setNewReviewer(e.target.value)}><option value="">{t('kanban.reviewer')}</option>{agents.filter((agent) => agent.companyId === newCompany && agent.id !== newAssignee).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                </label>
                <label className="field-label">{t('kanban.priority')}
                <select className="input" value={newPriority} onChange={(e) => setNewPriority(e.target.value as (typeof priorities)[number])}>{priorities.map((priority) => <option key={priority} value={priority}>{t(`kanban.priority.${priority}`)}</option>)}</select>
                </label>
              </div>
              <label className="field-label">{t('kanban.tags')}<input className="input" value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="bug, release, research" /></label>
              <label className="field-label">{t('kanban.collaboration')}
                <select className="input" value={newDecisionMode} onChange={(e) => setNewDecisionMode(e.target.value as typeof newDecisionMode)}>
                  <option value="auto">{t('kanban.modeAuto')}</option>
                  <option value="solo">{t('kanban.modeSolo')}</option>
                  <option value="pair">{t('kanban.modePair')}</option>
                  <option value="swarm">{t('kanban.modeSwarm')}</option>
                </select>
              </label>
              <div className="form-grid">
                <label className="field-label">{t('kanban.reviewMode')}
                  <select className="input" value={newReviewMode} onChange={(e) => setNewReviewMode(e.target.value === 'panel' ? 'panel' : 'single')}>
                    <option value="single">{t('kanban.reviewModeSingle')}</option>
                    <option value="panel">{t('kanban.reviewModePanel')}</option>
                  </select>
                </label>
                <label className="check-row" style={{ alignSelf: 'end' }} title={t('kanban.criticalHint')}><input type="checkbox" checked={newCritical} onChange={(e) => setNewCritical(e.target.checked)} /> {t('kanban.critical')}</label>
              </div>
              <span className="field-hint">{t('kanban.criticalHint')}</span>
              {newReviewMode === 'panel' && <div className="field-label"><span>{t('kanban.panelReviewers')}</span>
                <PanelReviewerPicker agents={agents.filter((agent) => !newCompany || agent.companyId === newCompany)} excludeId={newAssignee || null} value={newReviewerIds} onChange={setNewReviewerIds} disabled={busy} />
              </div>}
              <p className="field-hint">{t('forms.dependencyHelp')}</p>
              <div className="field-label"><span>{t('kanban.dependencies')}</span><DependencyPicker cards={cards} companyId={newCompany} projectId={newProject || null} value={newDependencies} onChange={setNewDependencies} /></div>
              <div className="form-grid">
                <label className="field-label">{t('kanban.scheduleAt')}
                  <input className="input" type="datetime-local" value={newScheduleAt} onChange={(e) => setNewScheduleAt(e.target.value)} />
                </label>
                <label className="field-label">{t('kanban.recurEvery')}
                  <select className="input" value={newRecurMinutes} onChange={(e) => setNewRecurMinutes(e.target.value)}>
                    <option value="">—</option>
                    <option value="30">30</option>
                    <option value="60">60</option>
                    <option value="180">180</option>
                    <option value="360">360</option>
                    <option value="720">720</option>
                    <option value="1440">1440 (24h)</option>
                    <option value="10080">10080 (7d)</option>
                  </select>
                </label>
              </div>
              <label className="check-row"><input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} /> {t('forms.clientApproval')}</label>
              <label className="check-row" title={t('kanban.forceBrainstormHint')}><input type="checkbox" checked={forceBrainstorm} onChange={(e) => setForceBrainstorm(e.target.checked)} /> {t('kanban.forceBrainstorm')}</label>
              {forceBrainstorm && <div className="field-label"><span>{t('kanban.brainstormDepartments')}</span>
                <div className="action-row" style={{ flexWrap: 'wrap' }}>
                  {departments.filter((department) => !newCompany || department.companyId === newCompany).map((department) => {
                    const on = brainstormDepartmentIds.includes(department.id);
                    return <button type="button" key={department.id} className={`btn ${on ? 'btn-primary' : ''}`} onClick={() => setBrainstormDepartmentIds((current) => on ? current.filter((id) => id !== department.id) : [...current, department.id])}>{department.name}</button>;
                  })}
                </div>
                <span className="field-hint">{t('kanban.brainstormDepartmentsHint')}</span>
              </div>}
              </details>
              {toast?.type === 'error' && <p className="form-error" role="alert">{toast.message}</p>}
            </div>
            <div className="kanban-create-modal-footer">
              <button className="btn btn-primary" disabled={busy} onClick={create}><Plus size={15} /> {t('common.create')}</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <CardDetailPanel
      selected={selected}
      tab={tab}
      selectTab={selectTab}
      detailLayout={detailLayout}
      setDetailLayout={setDetailLayout}
      overviewEditing={overviewEditing}
      setOverviewEditing={setOverviewEditing}
      draftDirty={draftDirty}
      closePanel={closePanel}
      openCard={openCard}
      cardApprovals={cardApprovals}
      cardChildren={cardChildren}
      cardReviewRounds={cardReviewRounds}
      conversation={conversation}
      conversationView={conversationView}
      setConversationView={setConversationView}
      conversationLatest={conversationLatest}
      onCheckpointAnswered={() => afterApprovalChange(t('kanban.taskQueuedContinue'))}
      onApprovalDecided={() => afterApprovalChange(t('kanban.reviewCompleted'))}
      cards={cards}
      agents={agents}
      departments={departments}
      projects={projects}
      goals={goals}
      draft={draft}
      setDraft={setDraft}
      logs={logs}
      actions={actions}
      apiLogs={apiLogs}
      comments={comments}
      workProducts={workProducts}
      delegationSummary={delegationSummary}
      logsHasMore={logsHasMore}
      tabLoading={tabLoading}
      busy={busy}
      commentBody={commentBody}
      setCommentBody={setCommentBody}
      commentAction={commentAction}
      setCommentAction={setCommentAction}
      commentAgentId={commentAgentId}
      setCommentAgentId={setCommentAgentId}
      commentDelegateAssigneeId={commentDelegateAssigneeId}
      setCommentDelegateAssigneeId={setCommentDelegateAssigneeId}
      commentDelegateReviewerId={commentDelegateReviewerId}
      setCommentDelegateReviewerId={setCommentDelegateReviewerId}
      commentDelegateScope={commentDelegateScope}
      setCommentDelegateScope={setCommentDelegateScope}
      workProductType={workProductType}
      setWorkProductType={setWorkProductType}
      workProductTitle={workProductTitle}
      setWorkProductTitle={setWorkProductTitle}
      workProductSummary={workProductSummary}
      setWorkProductSummary={setWorkProductSummary}
      workProductUrl={workProductUrl}
      setWorkProductUrl={setWorkProductUrl}
      workProductRepoProvider={workProductRepoProvider}
      setWorkProductRepoProvider={setWorkProductRepoProvider}
      workProductRepoUrl={workProductRepoUrl}
      setWorkProductRepoUrl={setWorkProductRepoUrl}
      workProductBranch={workProductBranch}
      setWorkProductBranch={setWorkProductBranch}
      workProductCommitSha={workProductCommitSha}
      setWorkProductCommitSha={setWorkProductCommitSha}
      workProductPullRequestUrl={workProductPullRequestUrl}
      setWorkProductPullRequestUrl={setWorkProductPullRequestUrl}
      saveSelected={saveSelected}
      resetDraft={resetDraft}
      deleteSelected={deleteSelected}
      action={action}
      addComment={addComment}
      addWorkProduct={addWorkProduct}
      loadMoreCardLogs={loadMoreCardLogs}
      loadCardComments={loadCardComments}
    />

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}
