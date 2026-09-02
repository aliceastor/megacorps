'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';
import { formatRelative } from '@/lib/relative-time';
import { CheckpointAnswerForm, readCheckpointPayload, type CheckpointApproval } from './checkpoint-answer-form';

// The client's inbox: questions the company is blocked on. A CEO or department
// head parked a card as waiting_on_client; answering here resumes it with the
// answer injected into the owner's next turn. The answer form itself is shared
// with the card panel's needs-you strip (checkpoint-answer-form.tsx).

const REFRESH_MS = 60_000;
const LIVE_DEBOUNCE_MS = 400;

export function ClientCheckpoints() {
  const { t, locale } = useLocale();
  const [items, setItems] = useState<CheckpointApproval[]>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const liveTimer = useRef<number | null>(null);

  async function refresh() {
    try {
      const rows = await api<CheckpointApproval[]>('/api/approvals?status=pending&type=client_checkpoint&limit=50');
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

  // A checkpoint answered from the card panel (or withdrawn server-side) shows
  // up as card.* live events; refresh once the burst settles.
  useEffect(() => {
    function onLive(event: Event) {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      if (!detail?.type?.startsWith('card.')) return;
      if (liveTimer.current) window.clearTimeout(liveTimer.current);
      liveTimer.current = window.setTimeout(() => { liveTimer.current = null; void refresh(); }, LIVE_DEBOUNCE_MS);
    }
    window.addEventListener('megacorps-live', onLive);
    return () => {
      window.removeEventListener('megacorps-live', onLive);
      if (liveTimer.current) window.clearTimeout(liveTimer.current);
    };
  }, []);

  if (items.length === 0 && !error) return null;

  return <section className="card section-card client-checkpoints">
    <div className="panel-title">
      <h2><MessageCircleQuestion size={18} /> {t('checkpoints.title')} <span className="status-pill">{items.length}</span></h2>
    </div>
    <p className="field-hint">{t('checkpoints.subtitle')}</p>
    {error && <p className="form-error">{error}</p>}
    <div className="table-list">
      {items.map((item) => {
        const payload = readCheckpointPayload(item.payload);
        return <article className="list-row" key={item.id}>
          <div className="prompt-log-head">
            <b>{payload.cardTitle ?? item.cardId ?? 'card'}</b>
            <span>{payload.kind === 'interim' ? t('checkpoints.kindInterim') : t('checkpoints.kindDirection')} · {payload.askedByName ?? 'agent'} · {formatRelative(item.createdAt, now, locale)}</span>
          </div>
          <p>{payload.question}</p>
          {payload.artifactRefs && payload.artifactRefs.length > 0 && <div className="meta-grid">
            {payload.artifactRefs.map((ref) => <span key={ref}>{/^https?:\/\//.test(ref) ? <a href={ref} target="_blank" rel="noreferrer">{ref}</a> : <code>{ref}</code>}</span>)}
          </div>}
          <CheckpointAnswerForm approval={item} onAnswered={() => setItems((current) => current.filter((row) => row.id !== item.id))} />
        </article>;
      })}
    </div>
  </section>;
}
