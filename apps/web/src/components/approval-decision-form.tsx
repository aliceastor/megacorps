'use client';
import { useState } from 'react';
import { Check, Undo2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';
import { useToast } from '@/lib/toast-context';
import { statusLabels } from './kanban/card-types';

// The human reviewer's decision on a pending task_review approval: approve
// moves the card to done, reject sends it back to todo. Same PUT the Budget
// page and the org chart use; a 409 parent_children_incomplete is surfaced as
// a toast that names the children still in flight.

export type DecisionStatus = 'approved' | 'rejected';
export type DecisionApproval = { id: string; payload?: Record<string, unknown> | null };

/** PUT /api/approvals/:id { status, decisionNote? } — approvalDecisionSchema field names. */
export async function decideApproval(approvalId: string, status: DecisionStatus, decisionNote: string): Promise<void> {
  const note = decisionNote.trim();
  await api(`/api/approvals/${approvalId}`, { method: 'PUT', body: JSON.stringify({ status, decisionNote: note || undefined }) });
}

/** The child titles from a 409 parent_children_incomplete response, or null for any other error. */
export function incompleteChildrenTitles(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const data = error.data as { error?: unknown; incompleteTitles?: unknown } | null;
  if (!data || typeof data !== 'object' || data.error !== 'parent_children_incomplete') return null;
  return Array.isArray(data.incompleteTitles) ? data.incompleteTitles.filter((item): item is string => typeof item === 'string') : [];
}

export type ApprovalDecisionFormProps = {
  approval: DecisionApproval;
  disabled?: boolean;
  onDecided?: (status: DecisionStatus) => void | Promise<void>;
};

export function ApprovalDecisionForm({ approval, disabled = false, onDecided }: ApprovalDecisionFormProps) {
  const { t, tf, locale } = useLocale();
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<DecisionStatus | ''>('');
  const [error, setError] = useState('');
  const reason = approval.payload && typeof approval.payload.reason === 'string' ? approval.payload.reason : '';

  async function decide(status: DecisionStatus) {
    setBusy(status);
    setError('');
    try {
      await decideApproval(approval.id, status, note);
      setNote('');
      await onDecided?.(status);
    } catch (err) {
      const titles = incompleteChildrenTitles(err);
      if (titles) {
        toast(tf('kanban.approvalBlockedByChildren', { titles: titles.join(t('kanban.listSeparator')) }), 'error');
        return;
      }
      setError(err instanceof Error ? err.message : t('common.actionFailed'));
    } finally {
      setBusy('');
    }
  }

  return <div className="approval-decision-form" style={{ display: 'grid', gap: 8 }}>
    {reason && <p className="field-hint" style={{ margin: 0 }}>{reason}</p>}
    <label className="field-label">{t('kanban.decisionNote')}
      <textarea className="input" rows={2} value={note} disabled={Boolean(busy) || disabled} onChange={(event) => setNote(event.target.value)} />
    </label>
    {error && <p className="form-error">{error}</p>}
    <div className="action-row">
      <button type="button" className="btn btn-primary" disabled={Boolean(busy) || disabled} onClick={() => void decide('approved')}><Check size={14} /> {t('kanban.approveTask')} → {statusLabels.done[locale] ?? 'done'}</button>
      <button type="button" className="btn" disabled={Boolean(busy) || disabled} onClick={() => void decide('rejected')}><Undo2 size={14} /> {t('kanban.rejectTask')} → {statusLabels.todo[locale] ?? 'todo'}</button>
    </div>
  </div>;
}
