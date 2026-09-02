'use client';
import { useEffect, useState } from 'react';
import { MessageCircleQuestion, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

// The client's inbox: questions the company is blocked on. A CEO or department
// head parked a card as waiting_on_client; answering here resumes it with the
// answer injected into the owner's next turn.

type CheckpointPayload = {
  kind?: 'direction' | 'interim';
  question?: string;
  options?: string[];
  recommendation?: string | null;
  artifactRefs?: string[];
  askedByName?: string;
  cardTitle?: string;
};
type Approval = { id: string; companyId: string; cardId?: string | null; type: string; status: string; payload?: CheckpointPayload | null; createdAt?: string };

const REFRESH_MS = 60_000;

function relativeTime(value: string | undefined, now: number): string {
  if (!value) return '';
  const diff = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function ClientCheckpoints() {
  const { t } = useLocale();
  const [items, setItems] = useState<Approval[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { option: string; text: string }>>({});
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  async function refresh() {
    try {
      const rows = await api<Approval[]>('/api/approvals?status=pending&type=client_checkpoint&limit=50');
      setItems(rows);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load checkpoints');
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  async function answer(item: Approval) {
    const draft = drafts[item.id] ?? { option: '', text: '' };
    if (!draft.option && !draft.text.trim()) { setError(t('checkpoints.answerRequired')); return; }
    setBusyId(item.id);
    setError('');
    try {
      await api(`/api/approvals/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: 'answered', selectedOption: draft.option || undefined, answer: draft.text.trim() || undefined }) });
      setItems((current) => current.filter((row) => row.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to answer');
    } finally {
      setBusyId('');
    }
  }

  if (items.length === 0 && !error) return null;

  return <section className="card section-card client-checkpoints">
    <div className="panel-title">
      <h2><MessageCircleQuestion size={18} /> {t('checkpoints.title')} <span className="status-pill">{items.length}</span></h2>
    </div>
    <p className="field-hint">{t('checkpoints.subtitle')}</p>
    {error && <p className="form-error">{error}</p>}
    <div className="table-list">
      {items.map((item) => {
        const payload = item.payload ?? {};
        const draft = drafts[item.id] ?? { option: '', text: '' };
        const setDraft = (patch: Partial<{ option: string; text: string }>) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, ...patch } }));
        return <article className="list-row" key={item.id}>
          <div className="prompt-log-head">
            <b>{payload.cardTitle ?? item.cardId ?? 'card'}</b>
            <span>{payload.kind === 'interim' ? t('checkpoints.kindInterim') : t('checkpoints.kindDirection')} · {payload.askedByName ?? 'agent'} · {relativeTime(item.createdAt, now)}</span>
          </div>
          <p>{payload.question}</p>
          {payload.artifactRefs && payload.artifactRefs.length > 0 && <div className="meta-grid">
            {payload.artifactRefs.map((ref) => <span key={ref}>{/^https?:\/\//.test(ref) ? <a href={ref} target="_blank" rel="noreferrer">{ref}</a> : <code>{ref}</code>}</span>)}
          </div>}
          {payload.options && payload.options.length > 0 && <div className="action-row" style={{ flexWrap: 'wrap' }}>
            {payload.options.map((option) => <button
              key={option}
              className={`btn ${draft.option === option ? 'btn-primary' : ''}`}
              onClick={() => setDraft({ option: draft.option === option ? '' : option })}
              title={payload.recommendation === option ? t('checkpoints.recommended') : undefined}
            >{option}{payload.recommendation === option ? ' ★' : ''}</button>)}
          </div>}
          <label className="field-label">{t('checkpoints.answer')}
            <textarea className="input" rows={2} value={draft.text} onChange={(event) => setDraft({ text: event.target.value })} placeholder={t('checkpoints.answerPlaceholder')} />
          </label>
          <div className="action-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={busyId === item.id} onClick={() => void answer(item)}><Send size={14} /> {busyId === item.id ? t('checkpoints.sending') : t('checkpoints.send')}</button>
          </div>
        </article>;
      })}
    </div>
  </section>;
}
