'use client';
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isCancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ExternalLink, GitBranch, GripVertical, ListChecks, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, StopCircle, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

const statuses = ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'done', 'blocked', 'cancelled'] as const;
type CardStatus = (typeof statuses)[number];
const priorities = ['urgent', 'high', 'normal', 'low'] as const;
const workProductTypes = ['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external'] as const;
type LocaleLabels = Record<string, string>;
const statusLabels: Record<CardStatus, LocaleLabels> = {
  todo: { 'zh-TW': '待辦', en: 'Todo', ja: '未着手' },
  in_progress: { 'zh-TW': '執行中', en: 'In Progress', ja: '進行中' },
  in_review: { 'zh-TW': '審核中', en: 'In Review', ja: 'レビュー中' },
  needs_review: { 'zh-TW': '求助審核', en: 'Needs Review', ja: '支援レビュー' },
  waiting_on_external: { 'zh-TW': '等待外部', en: 'Waiting External', ja: '外部待ち' },
  done: { 'zh-TW': '完成', en: 'Done', ja: '完了' },
  blocked: { 'zh-TW': '受阻', en: 'Blocked', ja: 'ブロック' },
  cancelled: { 'zh-TW': '已取消', en: 'Cancelled', ja: 'キャンセル' },
};
type StatusGroupId = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked_cancelled';
type StatusGroup = { id: StatusGroupId; statuses: readonly CardStatus[]; dropStatus: CardStatus };
const statusGroups: readonly StatusGroup[] = [
  { id: 'todo', statuses: ['todo'], dropStatus: 'todo' },
  { id: 'in_progress', statuses: ['in_progress'], dropStatus: 'in_progress' },
  { id: 'review', statuses: ['in_review', 'needs_review', 'waiting_on_external'], dropStatus: 'in_review' },
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

type Card = {
  id: string;
  title: string;
  body: string;
  columnStatus: string;
  tags: string[];
  priority: number;
  companyId?: string;
  departmentId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  parentCardId?: string | null;
  dependencyCardIds?: string[];
  decisionMode?: string | null;
  requiresApproval?: boolean;
  retryCount?: number;
  maxRetries?: number;
  scheduleAt?: string | null;
  recurEveryMinutes?: number | null;
  recurNextAt?: string | null;
  scheduledFromCardId?: string | null;
  executionLog?: string | null;
  reviewFeedback?: string | null;
  sessionId?: string | null;
  costUsd?: string | null;
  executionLockId?: string | null;
  activeHeartbeatRunId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
type ChildTreeCard = Card & { depth: number; childCount: number };
type Agent = { id: string; companyId?: string; name: string; role?: string; adapterType?: string; isBusy?: boolean };
type Company = { id: string; name: string };
type Department = { id: string; companyId: string; name: string };
type Project = { id: string; companyId: string; name: string };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string };
type TaskLog = { id: string; type: string; status: string; message: string; output?: string; costUsd?: string; durationSeconds?: number; createdAt?: string };
type TaskRun = { id: string; cardId: string; kind: string; status: string };
type ApiEvent = { id: string; method: string; path: string; statusCode?: number; requestBody?: unknown; responseBody?: unknown; error?: string | null; durationMs?: number; createdAt?: string };
type CardComment = { id: string; body: string; action: string; authorType: string; agentId?: string | null; authorId?: string | null; createdAt?: string };
type CardAction = { id: string; actorType: string; actorId: string; action: string; fromStatus?: string | null; toStatus?: string | null; detail?: string | null; metadata?: unknown; createdAt?: string };
type WorkProduct = { id: string; cardId?: string | null; projectId?: string | null; agentId?: string | null; type: string; title: string; summary?: string | null; url?: string | null; repoProvider?: string | null; repoUrl?: string | null; branch?: string | null; commitSha?: string | null; pullRequestUrl?: string | null; createdAt?: string };
type CardUpdatePayload = Omit<Partial<Card>, 'priority'> & { priority?: (typeof priorities)[number] };
type LiveEvent = { type: string; cardId?: string | null; entityId?: string; projectId?: string | null };
type CachedRows<T> = { rows: T[]; cachedAt: number };
type CardTabCache = {
  comments?: CachedRows<CardComment>;
  logs?: CachedRows<TaskLog>;
  actions?: CachedRows<CardAction>;
  apiLogs?: CachedRows<ApiEvent>;
  workProducts?: CachedRows<WorkProduct>;
  childTree?: CachedRows<ChildTreeCard>;
};
type CardTabKey = keyof CardTabCache;

const CARD_TAB_CACHE_KEY = 'megacorps.kanban.card-tabs.v2';
const CARD_TAB_CACHE_TTL_MS = 2 * 60 * 1000;
const CARD_TAB_CACHE_LIMIT = 50;
const CARD_LOG_PAGE_SIZE = 80;
const CARD_TREE_LIMIT = 2000;

function isFresh<T>(entry?: CachedRows<T>): boolean {
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
    window.sessionStorage.setItem(CARD_TAB_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Keep the in-memory cache even if the browser refuses sessionStorage writes.
  }
}

function newestCacheTime(cache: CardTabCache): number {
  return Math.max(cache.comments?.cachedAt ?? 0, cache.logs?.cachedAt ?? 0, cache.actions?.cachedAt ?? 0, cache.apiLogs?.cachedAt ?? 0, cache.workProducts?.cachedAt ?? 0, cache.childTree?.cachedAt ?? 0);
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

function statusColor(status: string) {
  if (status === 'done') return '#16a34a';
  if (status === 'blocked') return '#dc2626';
  if (status === 'cancelled') return '#64748b';
  if (status === 'in_progress') return '#2563eb';
  if (status === 'in_review') return '#9333ea';
  if (status === 'needs_review') return '#ca8a04';
  if (status === 'waiting_on_external') return '#0d9488';
  return 'var(--border)';
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

function goalScope(goal: Goal): string {
  if (goal.projectId) return 'Project';
  if (goal.departmentId) return 'Department';
  return 'Company';
}

function scopedGoalOptions(goals: Goal[], input: { companyId?: string; departmentId?: string | null; projectId?: string | null }) {
  return goals.filter((goal) => {
    if (input.companyId && goal.companyId !== input.companyId) return false;
    if (!goal.departmentId && !goal.projectId) return true;
    if (goal.departmentId && input.departmentId && goal.departmentId === input.departmentId) return true;
    if (goal.projectId && input.projectId && goal.projectId === input.projectId) return true;
    return false;
  });
}

function priorityValue(priority: number): (typeof priorities)[number] {
  if (priority >= 3) return 'urgent';
  if (priority >= 2) return 'high';
  if (priority <= -1) return 'low';
  return 'normal';
}

function priorityNumber(priority: string | number | undefined): number {
  if (typeof priority === 'number') return priority;
  if (priority === 'urgent') return 3;
  if (priority === 'high') return 2;
  if (priority === 'low') return -1;
  return 0;
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function isQueryCancellation(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof Error && error.name === 'CancelledError');
}

function projectScopedDependencyCandidates(cards: Card[], input: { companyId?: string | null; projectId?: string | null; excludeCardId?: string | null; query?: string }) {
  const needle = input.query?.trim().toLowerCase() ?? '';
  return cards.filter((card) => {
    if (input.excludeCardId && card.id === input.excludeCardId) return false;
    if (input.companyId && card.companyId !== input.companyId) return false;
    if ((input.projectId ?? null) !== (card.projectId ?? null)) return false;
    if (!needle) return true;
    return `${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(needle);
  });
}

function DependencyPicker({
  cards,
  companyId,
  projectId,
  excludeCardId,
  value,
  onChange,
}: {
  cards: Card[];
  companyId?: string | null;
  projectId?: string | null;
  excludeCardId?: string | null;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => projectScopedDependencyCandidates(cards, { companyId, projectId, excludeCardId, query }), [cards, companyId, projectId, excludeCardId, query]);
  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedCount = value.length;

  function toggle(cardId: string, checked: boolean) {
    if (checked) {
      if (!selectedSet.has(cardId)) onChange([...value, cardId]);
      return;
    }
    onChange(value.filter((id) => id !== cardId));
  }

  return <div className="dependency-picker">
    <div className="input-wrap dependency-search"><Search size={14} /><input placeholder={t('kanban.searchDeps')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="dependency-list">
      {candidates.length === 0 ? <p className="field-hint">{projectId ? t('kanban.depNoProjectMatches') : t('kanban.depNoNoProjectMatches')}</p> : candidates.map((card) => (
        <label className="dependency-option" key={card.id}>
          <input type="checkbox" checked={selectedSet.has(card.id)} onChange={(event) => toggle(card.id, event.target.checked)} />
          <span>
            <b>{card.title}</b>
            <small>{card.columnStatus} / {card.id.slice(0, 8)}</small>
          </span>
        </label>
      ))}
    </div>
    <p className="field-hint">{selectedCount === 0 ? t('kanban.depNoneSelected') : `${selectedCount} ${t('kanban.depSelected')}`}</p>
  </div>;
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
  companies,
  childCardsByParent,
  expandedParentIds,
  onSelect,
  onToggleSubtasks,
}: {
  group: StatusGroup;
  cards: Card[];
  companies: Company[];
  childCardsByParent: Map<string, Card[]>;
  expandedParentIds: Set<string>;
  onSelect: (card: Card) => void;
  onToggleSubtasks: (cardId: string) => void;
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
        childCards={childCardsByParent.get(card.id) ?? []}
        subtasksExpanded={expandedParentIds.has(card.id)}
        companyName={companies.find((company) => company.id === card.companyId)?.name}
        onSelect={onSelect}
        onToggleSubtasks={onToggleSubtasks}
      />)}
    </div>
  </section>;
}

function DraggableCard({
  card,
  childCards,
  subtasksExpanded,
  companyName,
  onSelect,
  onToggleSubtasks,
}: {
  card: Card;
  childCards: Card[];
  subtasksExpanded: boolean;
  companyName?: string;
  onSelect: (card: Card) => void;
  onToggleSubtasks: (cardId: string) => void;
}) {
  const { t } = useLocale();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
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
    {childCards.length > 0 && <div className="kanban-subtasks">
      <button
        type="button"
        className="kanban-subtask-toggle"
        aria-expanded={subtasksExpanded}
        onClick={(event) => {
          event.stopPropagation();
          onToggleSubtasks(card.id);
        }}
      >
        <GitBranch size={13} />
        <span>{subtasksExpanded ? t('kanban.hideSubtasks') : t('kanban.subtasks')}</span>
        <b>{childCards.length}</b>
      </button>
      {subtasksExpanded && <div className="kanban-subtask-list">
        {childCards.map((child) => <button
          type="button"
          className="kanban-subtask-chip"
          key={child.id}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(child);
          }}
        >
          <span>{child.title}</span>
          <b>{child.columnStatus}</b>
        </button>)}
      </div>}
    </div>}
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
  const [childTree, setChildTree] = useState<ChildTreeCard[]>([]);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [cardTabCache, setCardTabCache] = useState<Record<string, CardTabCache>>(() => readCardTabCache());
  const [tabLoading, setTabLoading] = useState<Record<CardTabKey, boolean>>({ comments: false, logs: false, actions: false, apiLogs: false, workProducts: false, childTree: false });
  const [tab, setTab] = useState<'details' | 'comments' | 'thread' | 'logs' | 'workProducts' | 'subtasks'>('details');
  const [commentBody, setCommentBody] = useState('');
  const [commentAction, setCommentAction] = useState<'comment' | 'agent_note' | 'pause_agent' | 'send_to_agent' | 'continue_run' | 'escalate_to_reviewer'>('comment');
  const [commentAgentId, setCommentAgentId] = useState('');
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
  const [newDecisionMode, setNewDecisionMode] = useState<'agent_decides' | 'collaboration'>('agent_decides');
  const [newScheduleAt, setNewScheduleAt] = useState('');
  const [newRecurMinutes, setNewRecurMinutes] = useState('');
  const [workProductType, setWorkProductType] = useState<(typeof workProductTypes)[number]>('external');
  const [workProductTitle, setWorkProductTitle] = useState('');
  const [workProductSummary, setWorkProductSummary] = useState('');
  const [workProductUrl, setWorkProductUrl] = useState('');
  const [workProductRepoProvider, setWorkProductRepoProvider] = useState('');
  const [workProductRepoUrl, setWorkProductRepoUrl] = useState('');
  const [workProductBranch, setWorkProductBranch] = useState('');
  const [workProductCommitSha, setWorkProductCommitSha] = useState('');
  const [workProductPullRequestUrl, setWorkProductPullRequestUrl] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [filterCompany, setFilterCompany] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [sortMode, setSortMode] = useState<'priority' | 'company' | 'created_desc' | 'created_asc' | 'updated_desc'>('priority');
  const [query, setQuery] = useState('');
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedIdRef = useRef<string | null>(null);
  const boardQuery = useQuery({ queryKey: ['kanbanBoard'], queryFn: fetchKanbanBoard });

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
      if (selected) setSelected(nextCards.find((card) => card.id === selected.id) ?? null);
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

  async function loadCardChildTree(card: Card, force = false): Promise<ChildTreeCard[]> {
    const cached = cardTabCache[card.id]?.childTree;
    if (!force && isFresh(cached)) {
      if (selectedIdRef.current === card.id) setChildTree(cached?.rows ?? []);
      return cached?.rows ?? [];
    }
    if (!cached) setLoadingKey('childTree', true);
    try {
      if (force) await queryClient.invalidateQueries({ queryKey: ['cardSubtree', card.id] });
      const rows = await queryClient.fetchQuery({
        queryKey: ['cardSubtree', card.id, CARD_TREE_LIMIT],
        queryFn: () => api<ChildTreeCard[]>(`/api/cards/${card.id}/subtree?limit=${CARD_TREE_LIMIT}`),
      });
      saveCardTabCache(card.id, { childTree: { rows, cachedAt: Date.now() } });
      if (selectedIdRef.current === card.id) setChildTree(rows);
      return rows;
    } catch (err) {
      if (!isQueryCancellation(err) && selectedIdRef.current === card.id && !cached) setChildTree([]);
      return cached?.rows ?? [];
    } finally {
      setLoadingKey('childTree', false);
    }
  }

  function selectTab(next: typeof tab) {
    setTab(next);
    if (!selected) return;
    if (next === 'comments') void loadCardComments(selected);
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
    if (next === 'subtasks') void loadCardChildTree(selected);
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
    if (selected) setSelected(boardQuery.data.cards.find((card) => card.id === selected.id) ?? null);
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
        setSelected(null);
        void refresh();
        return;
      }
      if (detail.type.startsWith('card.') || detail.type === 'activity.created') void refresh();
      const affectsSelectedCard = Boolean(selected && detail.cardId === selected.id);
      const affectsSelectedTree = Boolean(selected && tab === 'subtasks' && detail.cardId && childTree.some((card) => card.id === detail.cardId));
      if (selected && tab === 'subtasks' && detail.type.startsWith('card.') && (affectsSelectedCard || affectsSelectedTree)) void loadCardChildTree(selected, true);
      if (!selected || !affectsSelectedCard) return;
      if (detail.type === 'card.comment.created') void loadCardComments(selected, true);
      if (detail.type === 'task_log.created') void loadCardLogs(selected, true);
      if (detail.type === 'card.action.created') void loadCardActions(selected, true);
      if (detail.type === 'work_product.created') void loadCardWorkProducts(selected, true);
    }
    window.addEventListener('megacorps-live', onLive);
    return () => window.removeEventListener('megacorps-live', onLive);
  }, [selected?.id, tab, childTree]);
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    if (!selected) {
      setDraft(null);
      setLogs([]);
      setActions([]);
      setApiLogs([]);
      setComments([]);
      setWorkProducts([]);
      setChildTree([]);
      setLogsHasMore(false);
      return;
    }
    setDraft({
      title: selected.title,
      body: selected.body,
      columnStatus: selected.columnStatus,
      assigneeId: selected.assigneeId ?? null,
      reviewerId: selected.reviewerId ?? null,
      departmentId: selected.departmentId ?? null,
      projectId: selected.projectId ?? null,
      goalId: selected.goalId ?? null,
      priority: selected.priority,
      tags: selected.tags ?? [],
      dependencyCardIds: selected.dependencyCardIds ?? [],
      decisionMode: selected.decisionMode ?? null,
      requiresApproval: selected.requiresApproval ?? false,
      maxRetries: selected.maxRetries ?? 3,
    });
    const cached = cardTabCache[selected.id] ?? {};
    setComments(cached.comments?.rows ?? []);
    setLogs(cached.logs?.rows ?? []);
    setActions(cached.actions?.rows ?? []);
    setApiLogs(cached.apiLogs?.rows ?? []);
    setWorkProducts(cached.workProducts?.rows ?? []);
    setChildTree(cached.childTree?.rows ?? []);
    setLogsHasMore((cached.logs?.rows.length ?? 0) >= CARD_LOG_PAGE_SIZE);
    const timer = window.setTimeout(() => {
      if (tab === 'comments') void loadCardComments(selected);
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
      if (tab === 'subtasks') void loadCardChildTree(selected);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [selected?.id]);

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
  const cardIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards]);
  const boardCards = useMemo(() => visibleCards.filter((card) => !card.parentCardId || !cardIds.has(card.parentCardId)), [cardIds, visibleCards]);
  const childCardsByParent = useMemo(() => {
    const next = new Map<string, Card[]>();
    for (const card of cards) {
      if (!card.parentCardId || !cardIds.has(card.parentCardId)) continue;
      const rows = next.get(card.parentCardId) ?? [];
      rows.push(card);
      next.set(card.parentCardId, rows);
    }
    return next;
  }, [cardIds, cards]);
  const ticketThreadEntries = selected ? [
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
  ].sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? '')) : [];

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
          decisionMode: newDecisionMode === 'collaboration' ? 'delegate' : null,
          requiresApproval,
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
      setNewDecisionMode('agent_decides');
      setNewScheduleAt('');
      setNewRecurMinutes('');
      setRequiresApproval(false);
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
    setSelected(updated);
    setDraft({
      title: updated.title,
      body: updated.body,
      columnStatus: updated.columnStatus,
      assigneeId: updated.assigneeId ?? null,
      reviewerId: updated.reviewerId ?? null,
      departmentId: updated.departmentId ?? null,
      projectId: updated.projectId ?? null,
      goalId: updated.goalId ?? null,
      priority: updated.priority,
      tags: updated.tags ?? [],
      dependencyCardIds: updated.dependencyCardIds ?? [],
      decisionMode: updated.decisionMode ?? null,
      requiresApproval: updated.requiresApproval ?? false,
      maxRetries: updated.maxRetries ?? 3,
    });
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
      });
      setToast({ message: t('kanban.cardSaved'), type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('kanban.saveFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    if (!selected) return;
    setDraft({
      title: selected.title,
      body: selected.body,
      columnStatus: selected.columnStatus,
      assigneeId: selected.assigneeId ?? null,
      reviewerId: selected.reviewerId ?? null,
      departmentId: selected.departmentId ?? null,
      projectId: selected.projectId ?? null,
      goalId: selected.goalId ?? null,
      priority: selected.priority,
      tags: selected.tags ?? [],
      dependencyCardIds: selected.dependencyCardIds ?? [],
      decisionMode: selected.decisionMode ?? null,
      requiresApproval: selected.requiresApproval ?? false,
      maxRetries: selected.maxRetries ?? 3,
    });
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

  function toggleSubtasks(cardId: string) {
    setExpandedParentIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  async function action(path: string, message: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api<Card | Card[] | TaskRun>(path, { method: 'POST' });
      if (Array.isArray(result)) {
        setCards([...result, ...cards]);
        setTab('subtasks');
        if (selected) void loadCardChildTree(selected, true);
        setToast({ message, type: 'success' });
      } else if ('kind' in result && 'cardId' in result) {
        setToast({ message: `${result.kind} ${t('kanban.queued')} (${result.status})`, type: 'success' });
        await refresh();
      } else {
        setCards(cards.map((card) => (card.id === result.id ? result : card)));
        setSelected(result);
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
      setSelected(null);
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
    setBusy(true);
    try {
      const effectiveAction = commentAgentId ? 'agent_note' : commentAction;
      const comment = await api<CardComment>(`/api/cards/${selected.id}/comments`, { method: 'POST', body: JSON.stringify({ body: commentBody.trim(), action: effectiveAction, agentId: commentAgentId || null }) });
      const nextComments = [comment, ...comments];
      setComments(nextComments);
      saveCardTabCache(selected.id, { comments: { rows: nextComments, cachedAt: Date.now() } });
      void queryClient.invalidateQueries({ queryKey: ['cardComments', selected.id] });
      void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
      void loadCardActions(selected, true);
      setCommentBody('');
      setToast({ message: effectiveAction === 'pause_agent' ? t('kanban.agentPausedBlocked') : effectiveAction === 'continue_run' ? t('kanban.taskQueuedContinue') : effectiveAction === 'escalate_to_reviewer' ? t('kanban.taskEscalated') : t('kanban.messageAdded'), type: 'success' });
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
          type: workProductType,
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
      <button className="btn" onClick={() => void refresh()}><RefreshCw size={15} /></button>
      <button className="btn btn-primary" onClick={() => setModalOpen(true)}><Plus size={15} /> {t('newCard')}</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.55 }}>{t('common.loading')}</p> : (
      <DndContext onDragEnd={onDragEnd}>
        <div className="kanban-columns">
          {statusGroups.map((group) => <Column
            key={group.id}
            group={group}
            companies={companies}
            cards={cardsForStatusGroup(boardCards, group)}
            childCardsByParent={childCardsByParent}
            expandedParentIds={expandedParentIds}
            onSelect={(card) => { setSelected(card); setTab('details'); }}
            onToggleSubtasks={toggleSubtasks}
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
              <input className="input" placeholder={t('common.title')} autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
              <textarea className="input" placeholder={t('common.description')} value={newBody} onChange={(e) => setNewBody(e.target.value)} rows={5} />
              <div className="form-grid">
                <select className="input" value={newCompany} onChange={(e) => { setNewCompany(e.target.value); setNewDepartment(''); setNewProject(''); setNewGoal(''); setNewAssignee(''); setNewReviewer(''); setNewDependencies([]); }}><option value="">{t('common.company')}</option>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select>
                <select className="input" value={newDepartment} onChange={(e) => { setNewDepartment(e.target.value); setNewGoal(''); }}><option value="">{t('common.department')}</option>{departments.filter((department) => !newCompany || department.companyId === newCompany).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select>
                <select className="input" value={newProject} onChange={(e) => { setNewProject(e.target.value); setNewGoal(''); setNewDependencies([]); }}><option value="">{t('common.project')}</option>{projects.filter((project) => !newCompany || project.companyId === newCompany).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
                <select className="input" value={newGoal} onChange={(e) => setNewGoal(e.target.value)}><option value="">{t('kanban.goal')}</option>{scopedGoalOptions(goals, { companyId: newCompany, departmentId: newDepartment, projectId: newProject }).map((goal) => <option value={goal.id} key={goal.id}>{goalScope(goal)} / {goal.title}</option>)}</select>
                <select className="input" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}><option value="">{t('kanban.assignee')}</option>{agents.filter((agent) => !newCompany || agent.companyId === newCompany).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                <select className="input" value={newReviewer} onChange={(e) => setNewReviewer(e.target.value)}><option value="">{t('kanban.reviewer')}</option>{agents.filter((agent) => !newCompany || agent.companyId === newCompany).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                <select className="input" value={newPriority} onChange={(e) => setNewPriority(e.target.value as (typeof priorities)[number])}>{priorities.map((priority) => <option key={priority} value={priority}>{t(`kanban.priority.${priority}`)}</option>)}</select>
              </div>
              <label className="field-label">{t('kanban.tags')}<input className="input" value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="bug, release, research" /></label>
              <label className="field-label">{t('kanban.collaboration')}
                <select className="input" value={newDecisionMode} onChange={(e) => setNewDecisionMode(e.target.value as typeof newDecisionMode)}>
                  <option value="agent_decides">{t('kanban.agentDecides')}</option>
                  <option value="collaboration">{t('kanban.collaborationMode')}</option>
                </select>
              </label>
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
              <label className="check-row"><input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} /> {t('kanban.requiresApproval')}</label>
            </div>
            <div className="kanban-create-modal-footer">
              <button className="btn btn-primary" disabled={busy} onClick={create}><Plus size={15} /> {t('common.create')}</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <AnimatePresence>
      {selected && (
        <motion.div className="overlay kanban-detail-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelected(null)}>
        <motion.aside initial={{ scale: 0.97, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 16 }} transition={{ duration: 0.16 }}
          className="card detail-panel" onClick={(event) => event.stopPropagation()}>
          <div className="panel-title">
            <div><h2>{selected.title}</h2><span className="status-pill" style={{ borderColor: statusColor(selected.columnStatus) }}>{selected.columnStatus}</span></div>
            <button className="btn" onClick={() => setSelected(null)}><X size={16} /></button>
          </div>
          <div className="tab-row">
            {(['details', 'comments', 'thread', 'logs', 'workProducts', 'subtasks'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => selectTab(next)}>{next === 'comments' ? t('kanban.tabMessageBoard') : next === 'thread' ? t('kanban.tabThread') : next === 'workProducts' ? t('kanban.tabWorkProducts') : next === 'details' ? t('kanban.tabDetails') : next === 'logs' ? t('kanban.tabLogs') : t('kanban.childTree')}</button>)}
          </div>
          {tab === 'details' && <div style={{ display: 'grid', gap: 12 }}>
            <label className="field-label">{t('common.title')}<input className="input" value={String(draft?.title ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), title: e.target.value })} /></label>
            <label className="field-label">{t('kanban.stage')}
              <select className="input" value={String(draft?.columnStatus ?? selected.columnStatus)} onChange={(e) => setDraft({ ...(draft ?? {}), columnStatus: e.target.value })}>
                {statuses.map((status) => <option value={status} key={status}>{statusLabels[status]?.[locale] ?? status}</option>)}
              </select>
            </label>
            <label className="field-label">{t('kanban.fullDetail')}<textarea className="input" rows={8} value={String(draft?.body ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), body: e.target.value })} /></label>
            <div className="form-grid">
              <label className="field-label">{t('kanban.assignee')}<select className="input" value={draft?.assigneeId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), assigneeId: e.target.value || null })}><option value="">{t('kanban.assignee')}</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">{t('kanban.reviewer')}<select className="input" value={draft?.reviewerId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), reviewerId: e.target.value || null, requiresApproval: Boolean(e.target.value) })}><option value="">{t('kanban.reviewer')}</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">{t('common.department')}<select className="input" value={draft?.departmentId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), departmentId: e.target.value || null, goalId: null })}><option value="">{t('common.department')}</option>{departments.filter((department) => !selected.companyId || department.companyId === selected.companyId).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="field-label">{t('common.project')}<select className="input" value={draft?.projectId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), projectId: e.target.value || null, goalId: null, dependencyCardIds: [] })}><option value="">{t('common.project')}</option>{projects.filter((project) => !selected.companyId || project.companyId === selected.companyId).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
              <label className="field-label">{t('kanban.goal')}<select className="input" value={draft?.goalId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), goalId: e.target.value || null })}><option value="">{t('kanban.goal')}</option>{scopedGoalOptions(goals, { companyId: selected.companyId, departmentId: draft?.departmentId ?? selected.departmentId, projectId: draft?.projectId ?? selected.projectId }).map((goal) => <option value={goal.id} key={goal.id}>{goalScope(goal)} / {goal.title}</option>)}</select></label>
              <label className="field-label">{t('kanban.priority')}<select className="input" value={priorityValue(priorityNumber(draft?.priority ?? selected.priority))} onChange={(e) => setDraft({ ...(draft ?? {}), priority: priorityNumber(e.target.value) })}>{priorities.map((priority) => <option key={priority} value={priority}>{t(`kanban.priority.${priority}`)}</option>)}</select></label>
            </div>
            <label className="field-label">{t('kanban.tags')}<input className="input" value={(draft?.tags ?? []).join(', ')} onChange={(e) => setDraft({ ...(draft ?? {}), tags: parseCsv(e.target.value) })} /></label>
            <label className="field-label">{t('kanban.collaboration')}
              <select className="input" value={draft?.decisionMode === 'delegate' ? 'collaboration' : 'agent_decides'} onChange={(e) => setDraft({ ...(draft ?? {}), decisionMode: e.target.value === 'collaboration' ? 'delegate' : null })}>
                <option value="agent_decides">{t('kanban.agentDecides')}</option>
                <option value="collaboration">{t('kanban.collaborationMode')}</option>
              </select>
            </label>
            <div className="field-label"><span>{t('kanban.dependencies')}</span><DependencyPicker cards={cards} companyId={selected.companyId} projectId={(draft?.projectId ?? selected.projectId) || null} excludeCardId={selected.id} value={draft?.dependencyCardIds ?? []} onChange={(next) => setDraft({ ...(draft ?? {}), dependencyCardIds: next })} /></div>
            <div className="form-grid">
              <label className="field-label">{t('kanban.maxRetries')}<input className="input" type="number" min={1} max={10} value={Number(draft?.maxRetries ?? 3)} onChange={(e) => setDraft({ ...(draft ?? {}), maxRetries: Number(e.target.value) })} /></label>
              <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={Boolean(draft?.requiresApproval)} onChange={(e) => setDraft({ ...(draft ?? {}), requiresApproval: e.target.checked })} /> {t('kanban.requiresApproval')}</label>
            </div>
            <div className="meta-grid">
              <span>UUID <b>{selected.id}</b></span>
              <span>{t('kanban.stage')} <b>{selected.columnStatus}</b></span>
              <span>{t('kanban.priority')} <b>{t(`kanban.priority.${priorityValue(selected.priority)}`)}</b></span>
              <span>{t('kanban.cost')} <b>{selected.costUsd ?? '0.0000'}</b></span>
              <span>{t('kanban.session')} <b>{selected.sessionId ?? 'none'}</b></span>
              <span>{t('kanban.retries')} <b>{selected.retryCount ?? 0}/{selected.maxRetries ?? 3}</b></span>
              <span>{t('kanban.activeRun')} <b>{selected.activeHeartbeatRunId ?? 'none'}</b></span>
              <span>{t('kanban.lock')} <b>{selected.executionLockId ?? 'none'}</b></span>
            </div>
            {selected.reviewFeedback && <pre className="log-block">{selected.reviewFeedback}</pre>}
            <div className="action-row">
              <button className="btn btn-primary" disabled={busy} onClick={saveSelected}><Save size={15} /> {t('common.save')}</button>
              <button className="btn" disabled={busy} onClick={resetDraft}><RotateCcw size={15} /> {t('kanban.revert')}</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/run`, t('kanban.taskDispatched'))}><Play size={15} /> {t('common.runNow')}</button>
              <button className="btn" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/review`, t('kanban.reviewCompleted'))}><ShieldCheck size={15} /> {t('kanban.review')}</button>
              <button className="btn" title={t('kanban.splitSubtasksHint')} disabled={busy} onClick={() => action(`/api/cards/${selected.id}/decompose`, t('kanban.subtasksCreated'))}><GitBranch size={15} /> {t('kanban.splitSubtasks')}</button>
              <button className="btn" disabled={busy} onClick={() => { selectTab('comments'); setCommentAction('pause_agent'); }}><StopCircle size={15} /> {t('kanban.pauseWithComment')}</button>
              <button className="btn" disabled={busy || selected.columnStatus === 'cancelled'} onClick={() => action(`/api/cards/${selected.id}/cancel`, t('kanban.taskCancelled'))}><Ban size={15} /> {t('kanban.cancelTask')}</button>
              <button className="btn" disabled={busy} onClick={deleteSelected} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> {t('kanban.deleteTask')}</button>
            </div>
          </div>}
          {tab === 'comments' && <div style={{ display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{t('kanban.tabMessageBoard')}</h2><span className="status-pill">{comments.length} {t('kanban.messagesCount')}{tabLoading.comments ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
            </div>
            <div className="message-board-list">
              {comments.length === 0 && !tabLoading.comments ? <p style={{ opacity: 0.6 }}>{t('kanban.noMessages')}</p> : comments.map((comment) => {
                const authorAgent = comment.agentId ? agents.find((agent) => agent.id === comment.agentId) : undefined;
                const author = authorAgent?.name ?? (comment.authorType === 'system' ? t('common.system') : comment.authorType === 'agent' ? t('common.agent') : t('common.you'));
                return <article className="message-board-entry" key={comment.id}>
                  <div className="message-board-entry-head"><b>{author}</b><span>{comment.action} / {comment.createdAt ? new Date(comment.createdAt).toLocaleString() : ''}</span></div>
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
                <select className="input" value={commentAgentId ? 'agent_note' : commentAction} disabled={Boolean(commentAgentId)} onChange={(event) => setCommentAction(event.target.value as typeof commentAction)}>
                  <option value="comment">{t('kanban.commentOnly')}</option>
                  <option value="agent_note">{t('kanban.agentNote')}</option>
                  <option value="pause_agent">{t('kanban.stopAgentBlock')}</option>
                  <option value="escalate_to_reviewer">{t('kanban.escalateReviewer')}</option>
                  <option value="send_to_agent">{t('kanban.sendToAgent')}</option>
                  <option value="continue_run">{t('kanban.continueWithComment')}</option>
                </select>
              </label>
            </div>
            <label className="field-label">{t('kanban.message')}
              <textarea className="input" rows={5} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder={t('kanban.messageHint')} />
            </label>
            <button className="btn btn-primary" disabled={busy || !commentBody.trim()} onClick={addComment}><MessageSquare size={15} /> {t('kanban.addMessage')}</button>
          </div>}
          {tab === 'thread' && <div style={{ display: 'grid', gap: 12 }}>
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
          </div>}
          {tab === 'logs' && <div style={{ display: 'grid', gap: 10 }}>
            {(tabLoading.logs || tabLoading.actions || tabLoading.apiLogs) && <p style={{ opacity: 0.6 }}>{t('kanban.refreshingLogs')}</p>}
            {selected.executionLog && <article className="log-item">
              <b>{t('kanban.latestExecution')}</b>
              <span>{selected.completedAt ? new Date(selected.completedAt).toLocaleString() : selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : ''}</span>
              <pre className="log-block">{selected.executionLog}</pre>
            </article>}
            <article className="log-item">
              <b>{t('kanban.actionTimeline')}</b>
              <span>{actions.length} {t('kanban.normalizedActions')}{tabLoading.actions ? ` / ${t('kanban.refreshing')}` : ''}</span>
              {tabLoading.actions && actions.length === 0 ? <p>{t('kanban.loadingActions')}</p> : actions.length === 0 ? <p>{t('kanban.noActions')}</p> : actions.map((action) => <div className="log-item" key={action.id} style={{ marginTop: 8 }}>
                <b>{action.action}</b>
                <span>{action.createdAt ? new Date(action.createdAt).toLocaleString() : ''} / {action.actorType}:{action.actorId} / {action.fromStatus ?? 'none'} {'->'} {action.toStatus ?? 'none'}</span>
                {action.detail && <p>{action.detail}</p>}
                {action.metadata != null && <pre className="log-block">{JSON.stringify(action.metadata, null, 2)}</pre>}
              </div>)}
            </article>
            {tabLoading.logs && logs.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingLogs')}</p> : logs.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noLogs')}</p> : logs.map((log) => <article className="log-item" key={log.id}>
              <b>{log.type} / {log.status}</b>
              <span>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</span>
              <p>{log.message}</p>
              <div className="log-meta">
                {log.costUsd && <span>cost ${log.costUsd}</span>}
                {log.durationSeconds !== undefined && <span>{log.durationSeconds}s</span>}
              </div>
              {log.output && <pre className="log-block">{log.output}</pre>}
            </article>)}
            {logsHasMore && <button className="btn" disabled={tabLoading.logs} onClick={() => selected && loadMoreCardLogs(selected)}><RefreshCw size={14} /> {t('kanban.loadOlderLogs')}</button>}
            <article className="log-item">
              <b>{t('logs.apiLifecycle')}</b>
              <span>{apiLogs.length} {t('kanban.relatedOperations')}{tabLoading.apiLogs ? ` / ${t('kanban.refreshing')}` : ''}</span>
              {tabLoading.apiLogs && apiLogs.length === 0 ? <p>{t('kanban.loadingApiEvents')}</p> : apiLogs.length === 0 ? <p>{t('kanban.noApiEvents')}</p> : apiLogs.map((event) => <div className="log-item" key={event.id} style={{ marginTop: 8 }}>
                <b>{event.method} {event.path}</b>
                <span>{event.createdAt ? new Date(event.createdAt).toLocaleString() : ''} / {event.statusCode ?? '-'} / {event.durationMs ?? 0}ms</span>
                {event.error && <p className="form-error">{event.error}</p>}
                <pre className="log-block">{JSON.stringify({ request: event.requestBody, response: event.responseBody }, null, 2)}</pre>
              </div>)}
            </article>
          </div>}
          {tab === 'workProducts' && <div style={{ display: 'grid', gap: 10 }}>
            <div className="panel-title">
              <div><h2>{t('kanban.tabWorkProducts')}</h2><span className="status-pill">{workProducts.length} {t('kanban.productsCount')}{tabLoading.workProducts ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
            </div>
            <section className="section-card" style={{ padding: 0 }}>
              <div className="form-grid">
                <label className="field-label">{t('kanban.type')}<select className="input" value={workProductType} onChange={(event) => setWorkProductType(event.target.value as (typeof workProductTypes)[number])}>{workProductTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
                <label className="field-label">{t('common.title')}<input className="input" value={workProductTitle} onChange={(event) => setWorkProductTitle(event.target.value)} /></label>
                <label className="field-label">URL<input className="input" value={workProductUrl} onChange={(event) => setWorkProductUrl(event.target.value)} placeholder="https://..." /></label>
                <label className="field-label">{t('kanban.pullRequestUrl')}<input className="input" value={workProductPullRequestUrl} onChange={(event) => setWorkProductPullRequestUrl(event.target.value)} placeholder="https://github.com/org/repo/pull/1" /></label>
                <label className="field-label">{t('kanban.repoProvider')}<input className="input" value={workProductRepoProvider} onChange={(event) => setWorkProductRepoProvider(event.target.value)} placeholder="github" /></label>
                <label className="field-label">{t('kanban.repoUrl')}<input className="input" value={workProductRepoUrl} onChange={(event) => setWorkProductRepoUrl(event.target.value)} /></label>
                <label className="field-label">{t('kanban.branch')}<input className="input" value={workProductBranch} onChange={(event) => setWorkProductBranch(event.target.value)} /></label>
                <label className="field-label">Commit SHA<input className="input" value={workProductCommitSha} onChange={(event) => setWorkProductCommitSha(event.target.value)} /></label>
              </div>
              <label className="field-label">{t('kanban.summary')}<textarea className="input" rows={3} value={workProductSummary} onChange={(event) => setWorkProductSummary(event.target.value)} /></label>
              <button className="btn btn-primary" disabled={busy || !workProductTitle.trim()} onClick={addWorkProduct}><Plus size={15} /> {t('kanban.addWorkProduct')}</button>
            </section>
            {tabLoading.workProducts && workProducts.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingWorkProducts')}</p> : workProducts.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noWorkProducts')}</p> : workProducts.map((product) => {
              const primaryUrl = product.pullRequestUrl || product.url || (product.repoUrl && product.commitSha ? `${product.repoUrl.replace(/\/$/, '')}/commit/${product.commitSha}` : '');
              return <article className="log-item" key={product.id}>
                <b>{product.type} / {product.title}</b>
                <span>{product.createdAt ? new Date(product.createdAt).toLocaleString() : ''}</span>
                {product.summary && <p>{product.summary}</p>}
                <div className="log-meta">
                  {product.repoProvider && <span>{product.repoProvider}</span>}
                  {product.branch && <span>branch {product.branch}</span>}
                  {product.commitSha && <span>commit {product.commitSha.slice(0, 12)}</span>}
                </div>
                {primaryUrl && <a className="btn" href={primaryUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t('kanban.openProduct')}</a>}
              </article>;
            })}
          </div>}
          {tab === 'subtasks' && <div style={{ display: 'grid', gap: 10 }}>
            <div className="panel-title">
              <div><h2>{t('kanban.childTree')}</h2><span className="status-pill">{childTree.length} {t('kanban.childTreeCount')}{tabLoading.childTree ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
              <button className="btn" disabled={tabLoading.childTree} onClick={() => loadCardChildTree(selected, true)}><RefreshCw size={14} /> {t('common.refresh')}</button>
            </div>
            {childTree.length >= CARD_TREE_LIMIT && <p className="field-hint danger">{t('kanban.childTreeCapped')}</p>}
            {tabLoading.childTree && childTree.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingChildTree')}</p> : childTree.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noChildTree')}</p> : <div className="child-tree-list">
              {childTree.map((card) => {
                const assignee = card.assigneeId ? agents.find((agent) => agent.id === card.assigneeId)?.name ?? card.assigneeId.slice(0, 8) : '-';
                const reviewer = card.reviewerId ? agents.find((agent) => agent.id === card.reviewerId)?.name ?? card.reviewerId.slice(0, 8) : '-';
                return <button
                  className="child-tree-row"
                  key={card.id}
                  style={{ ['--tree-indent' as string]: `${Math.max(0, card.depth - 1) * 18}px` }}
                  onClick={() => { setSelected(card); setTab('details'); }}
                  aria-label={`${t('kanban.openTask')} ${card.title}`}
                >
                  <span className="child-tree-rail" aria-hidden="true" />
                  <span className="child-tree-main">
                    <b>{card.title}</b>
                    <small>{card.id.slice(0, 8)} / {t('kanban.assignee')}: {assignee} / {t('kanban.reviewer')}: {reviewer}</small>
                  </span>
                  <span className="child-tree-meta">
                    <span className="status-pill" style={{ borderColor: statusColor(card.columnStatus) }}>{statusLabels[card.columnStatus as CardStatus]?.[locale] ?? card.columnStatus}</span>
                    <small>{card.childCount > 0 ? `${card.childCount} ${t('kanban.childTreeCount')}` : card.updatedAt ? new Date(card.updatedAt).toLocaleString() : ''}</small>
                  </span>
                </button>;
              })}
            </div>}
          </div>}
        </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}
