'use client';
import { useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

// One answer form for a client checkpoint, shared by the inbox on the kanban
// page and the needs-you strip inside the card panel. Both go through
// answerCheckpoint() so the PUT payload is identical wherever you answer.

export type CheckpointPayload = {
  kind?: 'direction' | 'interim';
  question?: string;
  options?: string[];
  recommendation?: string | null;
  artifactRefs?: string[];
  askedByName?: string;
  cardTitle?: string;
};
export type CheckpointApproval = { id: string; companyId?: string; cardId?: string | null; type: string; status: string; payload?: CheckpointPayload | Record<string, unknown> | null; createdAt?: string };
export type CheckpointDraft = { option: string; text: string };

const EMPTY_DRAFT: CheckpointDraft = { option: '', text: '' };

/** Reads the checkpoint fields out of an approval payload without trusting its shape. */
export function readCheckpointPayload(payload: CheckpointApproval['payload']): CheckpointPayload {
  if (!payload || typeof payload !== 'object') return {};
  const raw = payload as Record<string, unknown>;
  const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined);
  return {
    kind: raw.kind === 'interim' ? 'interim' : raw.kind === 'direction' ? 'direction' : undefined,
    question: typeof raw.question === 'string' ? raw.question : undefined,
    options: strings(raw.options),
    recommendation: typeof raw.recommendation === 'string' ? raw.recommendation : null,
    artifactRefs: strings(raw.artifactRefs),
    askedByName: typeof raw.askedByName === 'string' ? raw.askedByName : undefined,
    cardTitle: typeof raw.cardTitle === 'string' ? raw.cardTitle : undefined,
  };
}

/** PUT /api/approvals/:id { status: 'answered', selectedOption?, answer? } — the only way a checkpoint gets answered from the web. */
export async function answerCheckpoint(approvalId: string, draft: CheckpointDraft): Promise<void> {
  await api(`/api/approvals/${approvalId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'answered', selectedOption: draft.option || undefined, answer: draft.text.trim() || undefined }),
  });
}

export type CheckpointAnswerFormProps = {
  approval: CheckpointApproval;
  disabled?: boolean;
  onAnswered?: (approval: CheckpointApproval) => void | Promise<void>;
};

export function CheckpointAnswerForm({ approval, disabled = false, onAnswered }: CheckpointAnswerFormProps) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<CheckpointDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payload = readCheckpointPayload(approval.payload);
  const options = payload.options ?? [];

  async function submit() {
    if (!draft.option && !draft.text.trim()) { setError(t('checkpoints.answerRequired')); return; }
    setBusy(true);
    setError('');
    try {
      await answerCheckpoint(approval.id, draft);
      setDraft(EMPTY_DRAFT);
      await onAnswered?.(approval);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to answer');
    } finally {
      setBusy(false);
    }
  }

  return <div className="checkpoint-answer-form" style={{ display: 'grid', gap: 8 }}>
    {options.length > 0 && <div className="action-row" style={{ flexWrap: 'wrap' }}>
      {options.map((option) => <button
        key={option}
        type="button"
        className={`btn ${draft.option === option ? 'btn-primary' : ''}`}
        disabled={busy || disabled}
        onClick={() => setDraft((current) => ({ ...current, option: current.option === option ? '' : option }))}
        title={payload.recommendation === option ? t('checkpoints.recommended') : undefined}
      >{option}{payload.recommendation === option ? ' ★' : ''}</button>)}
    </div>}
    <label className="field-label">{t('checkpoints.answer')}
      <textarea className="input" rows={2} value={draft.text} disabled={busy || disabled} onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))} placeholder={t('checkpoints.answerPlaceholder')} />
    </label>
    {error && <p className="form-error">{error}</p>}
    <div className="action-row" style={{ justifyContent: 'flex-end' }}>
      <button type="button" className="btn btn-primary" disabled={busy || disabled} onClick={() => void submit()}><Send size={14} /> {busy ? t('checkpoints.sending') : t('kanban.answerCheckpoint')}</button>
    </div>
  </div>;
}
