'use client';
import { DndContext, DragEndEvent, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const statuses = ['backlog','todo','in_progress','in_review','done','blocked'];
type Card = { id:string; title:string; body:string; columnStatus:string; tags:string[]; priority:number; assigneeId?: string; executionLog?: string; sessionId?: string; updatedAt?: string };

function Column({ status, cards, onSelect }: { status: string; cards: Card[]; onSelect: (card: Card) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return <section style={{ minHeight: 500 }}>
    <h3>{status} <span>{cards.length}</span></h3>
    <div ref={setNodeRef} className="card" style={{ padding: 10, minHeight: 450, outline: isOver ? '2px solid var(--primary)' : 'none', transition: 'outline 150ms' }}>
      {cards.map((card) => <DraggableCard key={card.id} card={card} onSelect={onSelect} />)}
    </div>
  </section>;
}

function DraggableCard({ card, onSelect }: { card: Card; onSelect: (card: Card) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  return <motion.article
    ref={setNodeRef}
    layout
    initial={{ opacity: 0, scale: 0.95 }}
    animate={{ opacity: isDragging ? 0.65 : 1, scale: 1 }}
    transition={{ duration: 0.3 }}
    className="card"
    style={{
      padding: 12,
      marginBottom: 10,
      cursor: 'grab',
      transform: CSS.Translate.toString(transform),
      borderLeft: `5px solid ${card.priority >= 3 ? '#ef4444' : card.priority >= 2 ? '#f97316' : 'var(--border)'}`,
    }}
    onClick={() => onSelect(card)}
    {...listeners}
    {...attributes}
  >
    <b>{card.title}</b>
    <p>{card.body.slice(0,90)}</p>
    <small>{card.tags?.join(', ')}</small>
  </motion.article>;
}

export function KanbanBoard(){
  const [cards,setCards]=useState<Card[]>([]);
  const [selected,setSelected]=useState<Card|null>(null);
  const [newTitle,setNewTitle]=useState('');
  const [newBody,setNewBody]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{api<Card[]>('/api/cards').then(setCards).catch((err)=>setError(err instanceof Error ? err.message : 'Failed to load cards'))},[]);
  async function create(){
    const card=await api<Card>('/api/cards',{method:'POST',body:JSON.stringify({title:newTitle,body:newBody,tags:[],priority:'normal'})});
    setCards([card,...cards]); setNewTitle(''); setNewBody('');
  }
  async function onDragEnd(event: DragEndEvent){
    const id=String(event.active.id);
    const over=event.over?.id ? String(event.over.id) : '';
    const card=cards.find(c=>c.id===id);
    if(!card||!over||card.columnStatus===over)return;
    const updated=await api<Card>(`/api/cards/${id}`,{method:'PUT',body:JSON.stringify({columnStatus:over,updatedAt:card.updatedAt})});
    setCards(cards.map(c=>c.id===id?updated:c));
  }
  return <>
    {error && <div className="card" style={{ padding: 12, marginBottom: 12 }}>{error}</div>}
    <div className="card" style={{ padding:16, marginBottom:16, display:'flex', gap:8 }}>
      <input className="input" placeholder="Title" value={newTitle} onChange={e=>setNewTitle(e.target.value)} />
      <input className="input" placeholder="Body" value={newBody} onChange={e=>setNewBody(e.target.value)} />
      <button className="btn btn-primary" onClick={create}>New Card</button>
    </div>
    <DndContext onDragEnd={onDragEnd}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(220px, 1fr))', gap:12, overflowX:'auto' }}>
        {statuses.map(status => <Column key={status} status={status} cards={cards.filter(c=>c.columnStatus===status)} onSelect={setSelected} />)}
      </div>
    </DndContext>
    {selected&&<motion.aside initial={{x:420}} animate={{x:0}} exit={{x:420}} transition={{duration:.3}} className="card" style={{ position:'fixed', right:20, top:84, width:400, bottom:20, padding:20, overflow:'auto' }}>
      <button className="btn" onClick={()=>setSelected(null)}>Close</button>
      <h2>{selected.title}</h2>
      <p>{selected.body}</p>
      <p>Status: {selected.columnStatus}</p>
      <p>Session: {selected.sessionId ?? 'none'}</p>
      <pre>{selected.executionLog}</pre>
      <button className="btn btn-primary" onClick={async()=>setSelected(await api<Card>(`/api/cards/${selected.id}/run`,{method:'POST'}))}>Run Now</button>
    </motion.aside>}
  </>;
}
