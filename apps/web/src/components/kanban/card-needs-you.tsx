'use client';
import { MessageSquarePlus, Play, ShieldCheck } from 'lucide-react';
import { findingLocation } from '@/lib/card-review';
import { useLocale } from '@/lib/locale-context';
import { ApprovalDecisionForm, type DecisionStatus } from '../approval-decision-form';
import { CheckpointAnswerForm, readCheckpointPayload } from '../checkpoint-answer-form';
import { needsYouVariant } from './card-overview-chips';
import type { Card, CardApproval, CardComment } from './card-types';

// The needs-you strip: rendered only when a human must act on the card.
// 1. waiting_on_client + pending client_checkpoint  -> inline answer form (same PUT as the inbox)
//    waiting_on_client, approval withdrawn          -> last question read-only + "continue with a comment"
// 2. a human gate (§17.6) or requiresApproval + pending task_review
//                                                   -> approve / reject with a decision note
//    fix_exhausted gate (§17.5)                     -> the open findings + 核准現況 / 退回主管 / 取消
//    in_review / needs_review without one           -> the 審核 button, labelled as queuing an agent review
// 3. blocked                                        -> continue with a comment
// 4. todo                                           -> run now

export type CardNeedsYouProps = {
  card: Card;
  /** null while GET /api/approvals?cardId= has not answered yet. */
  approvals: CardApproval[] | null;
  comments: CardComment[];
  busy: boolean;
  onRunNow: () => void;
  onReview: () => void;
  onContinueWithComment: () => void;
  onCheckpointAnswered: () => void | Promise<void>;
  onApprovalDecided: (status: DecisionStatus) => void | Promise<void>;
};

export function CardNeedsYou({ card, approvals, comments, busy, onRunNow, onReview, onContinueWithComment, onCheckpointAnswered, onApprovalDecided }: CardNeedsYouProps) {
  const { t, tf } = useLocale();
  const variant = needsYouVariant(card, approvals, comments);
  if (!variant) return null;

  if (variant.kind === 'fixExhausted') {
    const triggerKey = variant.trigger ? `kanban.fixTrigger.${variant.trigger}` : '';
    const trigger = triggerKey ? t(triggerKey) : '';
    const title = [
      t('kanban.situation.fixExhausted'),
      trigger && trigger !== triggerKey ? trigger : '',
      variant.level !== null && variant.level > 0 ? tf('kanban.fixLevelN', { n: variant.level }) : '',
    ].filter(Boolean).join(' · ');
    return <section className="overview-cta" aria-label={t('kanban.fixExhausted')}>
      <p className="overview-cta-title">{title}</p>
      {variant.reason && <p className="overview-cta-question">{variant.reason}</p>}
      {variant.findings.length > 0 && <div className="overview-findings">
        <span className="overview-children-label">{t('kanban.openFindings')} · {variant.findings.length}</span>
        <ul>
          {variant.findings.map((finding) => {
            const location = findingLocation(finding);
            return <li key={finding.key}>
              <span className={`conv-chip severity ${finding.severity}`}>{finding.severity}</span>
              <code>{finding.key}</code>
              <span>{finding.title}</span>
              {location && <code>{location}</code>}
            </li>;
          })}
        </ul>
      </div>}
      <ApprovalDecisionForm key={variant.approval.id} approval={variant.approval} disabled={busy} onDecided={onApprovalDecided} approveLabel={t('kanban.approveAsIs')} rejectLabel={t('kanban.returnToHead')} allowCancel hideReason />
    </section>;
  }

  if (variant.kind === 'checkpoint') {
    const payload = readCheckpointPayload(variant.approval.payload);
    const kindLabel = payload.kind === 'interim' ? t('checkpoints.kindInterim') : payload.kind === 'direction' ? t('checkpoints.kindDirection') : '';
    const title = [t('checkpoints.title'), kindLabel, payload.askedByName ?? ''].filter(Boolean).join(' · ');
    return <section className="overview-cta" aria-label={t('checkpoints.title')}>
      <p className="overview-cta-title">{title}</p>
      {payload.question && <p className="overview-cta-question">{payload.question}</p>}
      {payload.artifactRefs && payload.artifactRefs.length > 0 && <div className="meta-grid">
        {payload.artifactRefs.map((ref) => <span key={ref}>{/^https?:\/\//.test(ref) ? <a href={ref} target="_blank" rel="noreferrer">{ref}</a> : <code>{ref}</code>}</span>)}
      </div>}
      <CheckpointAnswerForm key={variant.approval.id} approval={variant.approval} disabled={busy} onAnswered={() => onCheckpointAnswered()} />
    </section>;
  }

  if (variant.kind === 'checkpointMissing') {
    return <section className="overview-cta" aria-label={t('checkpoints.title')}>
      <p className="overview-cta-title">{t('checkpoints.title')}</p>
      {variant.question && <p className="overview-cta-question">{variant.question}</p>}
      <p className="field-hint">{t('kanban.noPendingCheckpoint')}</p>
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onContinueWithComment}><MessageSquarePlus size={14} /> {t('kanban.continueWithCommentCta')}</button>
      </div>
    </section>;
  }

  if (variant.kind === 'approval') {
    return <section className="overview-cta" aria-label={t('kanban.filterMyReviews')}>
      <p className="overview-cta-title">{t('kanban.filterMyReviews')}</p>
      <ApprovalDecisionForm key={variant.approval.id} approval={variant.approval} disabled={busy} onDecided={onApprovalDecided} />
    </section>;
  }

  if (variant.kind === 'reviewHint') {
    return <section className="overview-cta" aria-label={t('kanban.review')}>
      <div className="action-row" style={{ alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onReview}><ShieldCheck size={14} /> {t('kanban.review')}</button>
        <span className="field-hint">{t('kanban.reviewEnqueuesAgent')}</span>
      </div>
    </section>;
  }

  if (variant.kind === 'blocked') {
    return <section className="overview-cta" aria-label={t('kanban.continueWithCommentCta')}>
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onContinueWithComment}><MessageSquarePlus size={14} /> {t('kanban.continueWithCommentCta')}</button>
      </div>
    </section>;
  }

  return <section className="overview-cta" aria-label={t('common.runNow')}>
    <div className="action-row">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onRunNow}><Play size={14} /> {t('common.runNow')}</button>
    </div>
  </section>;
}
