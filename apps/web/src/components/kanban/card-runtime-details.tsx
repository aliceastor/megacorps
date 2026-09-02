'use client';
import { ACTIVE_DELEGATION_STATUSES } from '@/lib/card-situation';
import { useLocale } from '@/lib/locale-context';
import { agentDisplayName, priorityValue } from './card-helpers';
import type { Agent, Card, CardDelegationSummary } from './card-types';

// The runtime <details> block (UUID / phase assignee / phase reviewer / cost /
// session / lock), verbatim from the details tab. The overview zone asks for
// `annotatePhase` so the phase pair is marked (進行中) or (歷史 · status)
// from the server's delegation-summary; the values themselves are never
// derived on the client.

export type CardRuntimeDetailsProps = {
  selected: Card;
  agents: Agent[];
  delegationSummary: CardDelegationSummary | null;
  annotatePhase?: boolean;
};

export function CardRuntimeDetails({ selected, agents, delegationSummary, annotatePhase = false }: CardRuntimeDetailsProps) {
  const { t, tf } = useLocale();
  const phaseAssigneeAgent = delegationSummary?.phaseAssigneeId ? agents.find((agent) => agent.id === delegationSummary.phaseAssigneeId) : undefined;
  const phaseReviewerAgent = delegationSummary?.phaseReviewerId ? agents.find((agent) => agent.id === delegationSummary.phaseReviewerId) : undefined;
  const phaseAssigneeLabel = agentDisplayName(phaseAssigneeAgent) ?? t('kanban.noneAssigned');
  const phaseReviewerLabel = agentDisplayName(phaseReviewerAgent) ?? t('kanban.noneAssigned');
  const phaseSummaryMeta = [
    delegationSummary?.phaseStatus,
    delegationSummary?.phaseUpdatedAt ? new Date(delegationSummary.phaseUpdatedAt).toLocaleString() : null,
  ].filter(Boolean).join(' / ');
  const phaseStatus = delegationSummary?.phaseStatus ?? '';
  const phaseNote = annotatePhase && delegationSummary?.phaseAssigneeId && phaseStatus
    ? ((ACTIVE_DELEGATION_STATUSES as readonly string[]).includes(phaseStatus) ? t('kanban.phaseActive') : tf('kanban.phaseHistorical', { status: phaseStatus }))
    : '';
  const phaseSuffix = phaseNote ? ` ${phaseNote}` : '';

  return <details className="runtime-details">
    <summary>{t('kanban.runtimeDetails')}</summary>
    <div className="meta-grid">
      <span>UUID <b>{selected.id}</b></span>
      <span>{t('kanban.stage')} <b>{selected.columnStatus}</b></span>
      <span>{t('kanban.phaseAssignee')}{phaseSuffix} <b>{phaseAssigneeLabel}</b>{phaseSummaryMeta && <small>{phaseSummaryMeta}</small>}</span>
      <span>{t('kanban.phaseReviewer')}{phaseSuffix} <b>{phaseReviewerLabel}</b>{phaseSummaryMeta && <small>{phaseSummaryMeta}</small>}</span>
      <span>{t('kanban.priority')} <b>{t(`kanban.priority.${priorityValue(selected.priority)}`)}</b></span>
      <span>{t('kanban.cost')} <b>{selected.costUsd ?? '0.0000'}</b></span>
      <span>{t('kanban.session')} <b>{selected.sessionId ?? 'none'}</b></span>
      <span>{t('kanban.retries')} <b>{selected.retryCount ?? 0}/{selected.maxRetries ?? 3}</b></span>
      <span>{t('kanban.activeRun')} <b>{selected.activeHeartbeatRunId ?? 'none'}</b></span>
      <span>{t('kanban.lock')} <b>{selected.executionLockId ?? 'none'}</b></span>
    </div>
  </details>;
}
