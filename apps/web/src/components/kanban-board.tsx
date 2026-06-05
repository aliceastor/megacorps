'use client';
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GripVertical, ListChecks, Play, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
const statusLabels: Record<string, Record<string, string>> = {
  backlog: { 'zh-TW': '待整理', en: 'Backlog', ja: 'バックログ' },
  todo: { 'zh-TW': '待辦', en: 'Todo', ja: 'ToDo' },
  in_progress: { 'zh-TW': '執行中', en: 'In Progress', ja: '進行中' },
  in_review: { 'zh-TW': '審核中', en: 'In Review', ja: 'レビュー中' },
  done: { 'zh-TW': '完成', en: 'Done', ja: '完了' },
  blocked: { 'zh-TW': '受阻', en: 'Blocked', ja: 'ブロック' },
};

type Card = {
  id: string;
  title: string;
  body: string;
  columnStatus: string;
  tags: string[];
  priority: number;
  assigneeId?: string | null;
  reviewerId?: string | null;
  parentCardId?: string | null;
  dependencyCardIds?: string[];
  requiresApproval?: boolean;
  retryCount?: number;
  maxRetries?: number;
  executionLog?: string | null;
  reviewFeedback?: string | null;
  sessionId?: string | null;
  costUsd?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
};
type Agent = { id: string; name: string; adapterType?: string; isBusy?: boolean };
type TaskLog = { id: string; type: string; status: string; message: string; output?: string; costUsd?: string; durationSeconds?: number; createdAt?: string };

function statusColor(status: string) {
  if (status === 'done') return '#16a34a';
  if (status === 'blocked') return '#dc2626';
  if (status === 'in_progress') return '#2563eb';
  if (status === 'in_review') return '#9333ea';
  return 'var(--border)';
}

function priorityLabel(priority: number) {
  if (priority >= 3) return 'Urgent';
  if (priority >= 2) return 'High';
  if (priority <= -1) return 'Low';
  return 'Normal';
}

function Column({ status, cards, onSelect }: { status: string; cards: Card[]; onSelect: (card: Card) => void }) {
  const { locale } = useLocale();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return <section style={{ minHeight: 520 }}>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, margin: '0 0 8px' }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: statusColor(status) }} />
      {statusLabels[status]?.[locale] ?? status}
      <span style={{ background: 'var(--border)', borderRadius: 99, padding: '2px 8px', fontSize: 12 }}>{cards.length}</span>
    </h3>
    <div ref={setNodeRef} className="card" style={{ padding: 10, minHeight: 470, outline: isOver ? '2px solid var(--primary)' : 'none', transition: 'outline 150ms', borderRadius: 8 }}>
      <AnimatePresence>
        {cards.map((card) => <DraggableCard key={card.id} card={card} onSelect={onSelect} />)}
      </AnimatePresence>
    </div>
  </section>;
}

function DraggableCard({ card, onSelect }: { card: Card; onSelect: (card: Card) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  return <motion.article
    ref={setNodeRef}
    layout
    initial={{ opacity: 0, scale: 0.96, y: 8 }}
    animate={{ opacity: isDragging ? 0.65 : 1, scale: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.94 }}
    transition={{ duration: 0.2 }}
    className="card"
    style={{
      padding: 12,
      marginBottom: 10,
      cursor: 'pointer',
      transform: CSS.Translate.toString(transform),
      borderLeft: `4px solid ${card.priority >= 3 ? '#ef4444' : card.priority >= 2 ? '#f97316' : card.priority <= -1 ? '#60a5fa' : statusColor(card.columnStatus)}`,
      borderRadius: 8,
    }}
    onClick={() => onSelect(card)}
  >
    <div style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
      <b style={{ fontSize: 14, flex: 1 }}>{card.title}</b>
      <button
        className="drag-handle"
        aria-label="Drag task"
        onClick={(event) => event.stopPropagation()}
        {...listeners}
        {...attributes}
      >
        <GripVertical size={14} />
      </button>
      <span style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 99, padding: '1px 6px' }}>{priorityLabel(card.priority)}</span>
    </div>
    <div style={{ marginTop: 4, fontSize: 10, opacity: 0.55, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' }}>{card.id}</div>
    <p style={{ fontSize: 12, opacity: 0.72, margin: '6px 0 0' }}>{card.body.slice(0, 100)}{card.body.length > 100 ? '...' : ''}</p>
    <div style={{ marginTop: 8, display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
      {card.requiresApproval && <span className="badge">Review</span>}
      {card.retryCount ? <span className="badge">Retry {card.retryCount}/{card.maxRetries ?? 3}</span> : null}
      {card.costUsd && <span className="badge">${card.costUsd}</span>}
      {card.tags?.map((tag) => <span className="badge" key={tag}>{tag}</span>)}
    </div>
  </motion.article>;
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3200); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 8, background: type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontSize: 14, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.25)' }}>
    {message}
  </motion.div>;
}

export function KanbanBoard() {
  const { t } = useLocale();
  const [cards, setCards] = useState<Card[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [draft, setDraft] = useState<Partial<Card> | null>(null);
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [tab, setTab] = useState<'details' | 'logs' | 'subtasks'>('details');
  const [modalOpen, setModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newReviewer, setNewReviewer] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const [nextCards, nextAgents] = await Promise.all([api<Card[]>('/api/cards'), api<Agent[]>('/api/agents')]);
      setCards(nextCards);
      setAgents(nextAgents);
      if (selected) setSelected(nextCards.find((card) => card.id === selected.id) ?? null);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to load board', type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!selected) return;
    setDraft({
      title: selected.title,
      body: selected.body,
      columnStatus: selected.columnStatus,
      assigneeId: selected.assigneeId ?? null,
      reviewerId: selected.reviewerId ?? null,
      requiresApproval: selected.requiresApproval ?? false,
      maxRetries: selected.maxRetries ?? 3,
    });
    api<TaskLog[]>(`/api/cards/${selected.id}/logs`).then(setLogs).catch(() => setLogs([]));
  }, [selected?.id]);

  const visibleCards = useMemo(() => cards.filter((card) => {
    if (filterStatus && card.columnStatus !== filterStatus) return false;
    if (filterAssignee && card.assigneeId !== filterAssignee) return false;
    if (query && !`${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [cards, filterAssignee, filterStatus, query]);
  const subtasks = selected ? cards.filter((card) => card.parentCardId === selected.id) : [];

  async function create() {
    if (!newTitle.trim()) { setToast({ message: 'Title is required', type: 'error' }); return; }
    setBusy(true);
    try {
      const card = await api<Card>('/api/cards', {
        method: 'POST',
        body: JSON.stringify({
          title: newTitle.trim(),
          body: newBody.trim() || newTitle.trim(),
          tags: [],
          priority: 'normal',
          assigneeId: newAssignee || null,
          reviewerId: newReviewer || null,
          requiresApproval,
        }),
      });
      setCards([card, ...cards]);
      setNewTitle('');
      setNewBody('');
      setNewAssignee('');
      setNewReviewer('');
      setRequiresApproval(false);
      setModalOpen(false);
      setToast({ message: `Card "${card.title}" created`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create card', type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function updateCard(card: Card, patch: Partial<Card>) {
    const updated = await api<Card>(`/api/cards/${card.id}`, { method: 'PUT', body: JSON.stringify({ ...patch, updatedAt: card.updatedAt }) });
    setCards(cards.map((item) => (item.id === updated.id ? updated : item)));
    setSelected(updated);
    setDraft({
      title: updated.title,
      body: updated.body,
      columnStatus: updated.columnStatus,
      assigneeId: updated.assigneeId ?? null,
      reviewerId: updated.reviewerId ?? null,
      requiresApproval: updated.requiresApproval ?? false,
      maxRetries: updated.maxRetries ?? 3,
    });
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
        requiresApproval: Boolean(draft.requiresApproval),
        maxRetries: Number(draft.maxRetries ?? selected.maxRetries ?? 3),
      });
      setToast({ message: 'Card saved', type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to save card', type: 'error' });
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
      requiresApproval: selected.requiresApproval ?? false,
      maxRetries: selected.maxRetries ?? 3,
    });
  }

  async function onDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const over = event.over?.id ? String(event.over.id) : '';
    const card = cards.find((c) => c.id === id);
    if (!card || !over || card.columnStatus === over) return;
    try { await updateCard(card, { columnStatus: over }); }
    catch (err) { setToast({ message: err instanceof Error ? err.message : 'Failed to move card', type: 'error' }); }
  }

  async function action(path: string, message: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api<Card | Card[]>(path, { method: 'POST' });
      if (Array.isArray(result)) {
        setCards([...result, ...cards]);
        setTab('subtasks');
      } else {
        setCards(cards.map((card) => (card.id === result.id ? result : card)));
        setSelected(result);
      }
      setToast({ message, type: 'success' });
      if (selected) setLogs(await api<TaskLog[]>(`/api/cards/${selected.id}/logs`));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Action failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
      <div className="input-wrap" style={{ flex: '1 1 260px' }}><Search size={15} /><input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <select className="input compact" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
        <option value="">All status</option>
        {statuses.map((status) => <option value={status} key={status}>{status}</option>)}
      </select>
      <select className="input compact" value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
        <option value="">All agents</option>
        {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
      </select>
      <button className="btn" onClick={() => void refresh()}><RefreshCw size={15} /></button>
      <button className="btn btn-primary" onClick={() => setModalOpen(true)}><Plus size={15} /> {t('newCard')}</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.55 }}>Loading...</p> : (
      <DndContext onDragEnd={onDragEnd}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(230px, 1fr))', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {statuses.map((status) => <Column key={status} status={status} cards={visibleCards.filter((card) => card.columnStatus === status)} onSelect={(card) => { setSelected(card); setTab('details'); }} />)}
        </div>
      </DndContext>
    )}

    <AnimatePresence>
      {modalOpen && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="card modal" initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 12 }}>
            <div className="panel-title"><h2>New Card</h2><button className="btn" onClick={() => setModalOpen(false)}><X size={16} /></button></div>
            <input className="input" placeholder="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <textarea className="input" placeholder="Description" value={newBody} onChange={(e) => setNewBody(e.target.value)} rows={5} />
            <div className="form-grid">
              <select className="input" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}><option value="">Assignee</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
              <select className="input" value={newReviewer} onChange={(e) => setNewReviewer(e.target.value)}><option value="">Reviewer</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
            </div>
            <label className="check-row"><input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} /> Requires approval</label>
            <button className="btn btn-primary" disabled={busy} onClick={create}><Plus size={15} /> Create</button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <AnimatePresence>
      {selected && (
        <motion.aside initial={{ x: 440 }} animate={{ x: 0 }} exit={{ x: 440 }} transition={{ type: 'spring', damping: 25 }}
          className="card detail-panel">
          <div className="panel-title">
            <div><h2>{selected.title}</h2><span className="status-pill" style={{ borderColor: statusColor(selected.columnStatus) }}>{selected.columnStatus}</span></div>
            <button className="btn" onClick={() => setSelected(null)}><X size={16} /></button>
          </div>
          <div className="tab-row">
            {(['details', 'logs', 'subtasks'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => setTab(next)}>{next}</button>)}
          </div>
          {tab === 'details' && <div style={{ display: 'grid', gap: 12 }}>
            <label className="field-label">Title<input className="input" value={String(draft?.title ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), title: e.target.value })} /></label>
            <label className="field-label">Stage
              <select className="input" value={String(draft?.columnStatus ?? selected.columnStatus)} onChange={(e) => setDraft({ ...(draft ?? {}), columnStatus: e.target.value })}>
                {statuses.map((status) => <option value={status} key={status}>{statusLabels[status]?.en ?? status}</option>)}
              </select>
            </label>
            <label className="field-label">Full Detail<textarea className="input" rows={8} value={String(draft?.body ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), body: e.target.value })} /></label>
            <div className="form-grid">
              <label className="field-label">Assignee<select className="input" value={draft?.assigneeId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), assigneeId: e.target.value || null })}><option value="">Assignee</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">Reviewer<select className="input" value={draft?.reviewerId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), reviewerId: e.target.value || null, requiresApproval: Boolean(e.target.value) })}><option value="">Reviewer</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
            </div>
            <div className="form-grid">
              <label className="field-label">Max retries<input className="input" type="number" min={1} max={10} value={Number(draft?.maxRetries ?? 3)} onChange={(e) => setDraft({ ...(draft ?? {}), maxRetries: Number(e.target.value) })} /></label>
              <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={Boolean(draft?.requiresApproval)} onChange={(e) => setDraft({ ...(draft ?? {}), requiresApproval: e.target.checked })} /> Requires approval</label>
            </div>
            <div className="meta-grid">
              <span>Priority <b>{priorityLabel(selected.priority)}</b></span>
              <span>Cost <b>{selected.costUsd ?? '0.0000'}</b></span>
              <span>Session <b>{selected.sessionId ?? 'none'}</b></span>
              <span>Retries <b>{selected.retryCount ?? 0}/{selected.maxRetries ?? 3}</b></span>
            </div>
            {selected.reviewFeedback && <pre className="log-block">{selected.reviewFeedback}</pre>}
            <div className="action-row">
              <button className="btn btn-primary" disabled={busy} onClick={saveSelected}><Save size={15} /> Save</button>
              <button className="btn" disabled={busy} onClick={resetDraft}><RotateCcw size={15} /> Revert</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/run`, 'Task dispatched')}><Play size={15} /> Run Now</button>
              <button className="btn" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/review`, 'Review completed')}><ShieldCheck size={15} /> Review</button>
              <button className="btn" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/decompose`, 'Sub-tasks created')}><GitBranch size={15} /> Decompose</button>
            </div>
          </div>}
          {tab === 'logs' && <div style={{ display: 'grid', gap: 10 }}>
            {selected.executionLog && <article className="log-item">
              <b>latest execution / output</b>
              <span>{selected.completedAt ? new Date(selected.completedAt).toLocaleString() : selected.updatedAt ? new Date(selected.updatedAt).toLocaleString() : ''}</span>
              <pre className="log-block">{selected.executionLog}</pre>
            </article>}
            {logs.length === 0 ? <p style={{ opacity: 0.6 }}>No logs yet.</p> : logs.map((log) => <article className="log-item" key={log.id}>
              <b>{log.type} / {log.status}</b>
              <span>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</span>
              <p>{log.message}</p>
              <div className="log-meta">
                {log.costUsd && <span>cost ${log.costUsd}</span>}
                {log.durationSeconds !== undefined && <span>{log.durationSeconds}s</span>}
              </div>
              {log.output && <pre className="log-block">{log.output}</pre>}
            </article>)}
          </div>}
          {tab === 'subtasks' && <div style={{ display: 'grid', gap: 10 }}>
            {subtasks.length === 0 ? <p style={{ opacity: 0.6 }}>No sub-tasks yet.</p> : subtasks.map((card) => <button className="subtask-row" key={card.id} onClick={() => { setSelected(card); setTab('details'); }}>
              <ListChecks size={15} /><span>{card.title}</span><b>{card.columnStatus}</b>
            </button>)}
          </div>}
        </motion.aside>
      )}
    </AnimatePresence>

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}
