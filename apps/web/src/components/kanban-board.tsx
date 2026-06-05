'use client';
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Plus, X, Play, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'];
const statusLabels: Record<string, Record<string, string>> = {
  backlog: { 'zh-TW': '待辦', en: 'Backlog', ja: 'バックログ' },
  todo: { 'zh-TW': '待做', en: 'Todo', ja: 'ToDo' },
  in_progress: { 'zh-TW': '進行中', en: 'In Progress', ja: '進行中' },
  in_review: { 'zh-TW': '審核中', en: 'In Review', ja: 'レビュー中' },
  done: { 'zh-TW': '完成', en: 'Done', ja: '完了' },
  blocked: { 'zh-TW': '阻塞', en: 'Blocked', ja: 'ブロック' },
};
type Card = { id: string; title: string; body: string; columnStatus: string; tags: string[]; priority: number; assigneeId?: string; executionLog?: string; sessionId?: string; updatedAt?: string };

function Column({ status, cards, onSelect }: { status: string; cards: Card[]; onSelect: (card: Card) => void }) {
  const { locale } = useLocale();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return <section style={{ minHeight: 500 }}>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {statusLabels[status]?.[locale] ?? status}
      <span style={{ background: 'var(--border)', borderRadius: 99, padding: '2px 8px', fontSize: 12 }}>{cards.length}</span>
    </h3>
    <div ref={setNodeRef} className="card" style={{ padding: 10, minHeight: 450, outline: isOver ? '2px solid var(--primary)' : 'none', transition: 'outline 150ms', borderRadius: 12 }}>
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
    initial={{ opacity: 0, scale: 0.95, y: 10 }}
    animate={{ opacity: isDragging ? 0.65 : 1, scale: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.9 }}
    transition={{ duration: 0.25 }}
    className="card"
    style={{
      padding: 12,
      marginBottom: 10,
      cursor: 'grab',
      transform: CSS.Translate.toString(transform),
      borderLeft: `4px solid ${card.priority >= 3 ? '#ef4444' : card.priority >= 2 ? '#f97316' : card.priority <= -1 ? '#60a5fa' : 'var(--border)'}`,
      borderRadius: 10,
    }}
    onClick={() => onSelect(card)}
    {...listeners}
    {...attributes}
  >
    <b style={{ fontSize: 14 }}>{card.title}</b>
    <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{card.body.slice(0, 90)}{card.body.length > 90 ? '...' : ''}</p>
    {card.tags?.length > 0 && <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {card.tags.map((tag) => <span key={tag} style={{ fontSize: 10, background: 'var(--border)', borderRadius: 4, padding: '1px 6px' }}>{tag}</span>)}
    </div>}
  </motion.article>;
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 12, background: type === 'error' ? '#ef4444' : '#22c55e', color: '#fff', fontSize: 14, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
    {message}
  </motion.div>;
}

export function KanbanBoard() {
  const { t } = useLocale();
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Card[]>('/api/cards').then(setCards).catch((err) => setToast({ message: err instanceof Error ? err.message : 'Failed to load', type: 'error' })).finally(() => setLoading(false));
  }, []);

  async function create() {
    if (!newTitle.trim()) { setToast({ message: 'Title is required', type: 'error' }); return; }
    setCreating(true);
    try {
      const card = await api<Card>('/api/cards', { method: 'POST', body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim(), tags: [], priority: 'normal' }) });
      setCards([card, ...cards]);
      setNewTitle('');
      setNewBody('');
      setToast({ message: `Card "${card.title}" created!`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create card', type: 'error' });
    } finally {
      setCreating(false);
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const over = event.over?.id ? String(event.over.id) : '';
    const card = cards.find((c) => c.id === id);
    if (!card || !over || card.columnStatus === over) return;
    try {
      const updated = await api<Card>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify({ columnStatus: over, updatedAt: card.updatedAt }) });
      setCards(cards.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to move card', type: 'error' });
    }
  }

  async function runCard() {
    if (!selected) return;
    try {
      const updated = await api<Card>(`/api/cards/${selected.id}/run`, { method: 'POST' });
      setSelected(updated);
      setCards(cards.map((c) => (c.id === updated.id ? updated : c)));
      setToast({ message: 'Task dispatched!', type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to run', type: 'error' });
    }
  }

  return <>
    {/* New Card Form */}
    <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
      <input className="input" placeholder="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} style={{ flex: 1 }} />
      <input className="input" placeholder="Description" value={newBody} onChange={(e) => setNewBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} style={{ flex: 2 }} />
      <button className="btn btn-primary" onClick={create} disabled={creating} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Plus size={14} /> {creating ? '...' : t('newCard')}
      </button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <DndContext onDragEnd={onDragEnd}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(220px, 1fr))', gap: 12, overflowX: 'auto' }}>
          {statuses.map((status) => <Column key={status} status={status} cards={cards.filter((c) => c.columnStatus === status)} onSelect={setSelected} />)}
        </div>
      </DndContext>
    )}

    {/* Detail Panel */}
    <AnimatePresence>
      {selected && (
        <motion.aside initial={{ x: 420 }} animate={{ x: 0 }} exit={{ x: 420 }} transition={{ type: 'spring', damping: 25 }}
          className="card" style={{ position: 'fixed', right: 20, top: 84, width: 400, bottom: 20, padding: 20, overflow: 'auto', borderRadius: 16, zIndex: 50 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{selected.title}</h2>
            <button className="btn" onClick={() => setSelected(null)}><X size={16} /></button>
          </div>
          <p style={{ opacity: 0.8, whiteSpace: 'pre-wrap' }}>{selected.body}</p>
          <div style={{ marginTop: 16, display: 'grid', gap: 8, fontSize: 13 }}>
            <p><b>Status:</b> {selected.columnStatus}</p>
            <p><b>Priority:</b> {selected.priority}</p>
            <p><b>Session:</b> {selected.sessionId ?? 'none'}</p>
          </div>
          {selected.executionLog && <pre style={{ marginTop: 16, fontSize: 11, background: 'var(--border)', padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: 200 }}>{selected.executionLog}</pre>}
          <button className="btn btn-primary" onClick={runCard} style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}>
            <Play size={14} /> Run Now
          </button>
        </motion.aside>
      )}
    </AnimatePresence>

    {/* Toast */}
    <AnimatePresence>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </AnimatePresence>
  </>;
}
