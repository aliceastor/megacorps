'use client';
import { Ban, Play, RotateCcw, Save, ShieldCheck, StopCircle, Trash2 } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { goalScope, parseCsv, priorityNumber, priorityValue, scopedGoalOptions } from './card-helpers';
import { CardRuntimeDetails } from './card-runtime-details';
import { type Agent, type Card, type CardDelegationSummary, type CardDetailTab, type CommentActionMode, type Department, type Goal, type Project, priorities, statusLabels, statuses } from './card-types';
import { DependencyPicker } from './dependency-picker';

// The details tab exactly as it rendered inside kanban-board.tsx: the edit
// form, runtime details, review feedback and the action row. The v2 overview
// asks for `fieldsOnly` and renders the form fields alone; runtime details,
// review feedback and the action row live in the overview zone there.
// Every field carries data-field="<draft key>" so a chip in the overview can
// open the editor focused on that field.

export type CardDetailsFormProps = {
  selected: Card;
  draft: Partial<Card> | null;
  setDraft: (draft: Partial<Card> | null) => void;
  cards: Card[];
  agents: Agent[];
  departments: Department[];
  projects: Project[];
  goals: Goal[];
  delegationSummary: CardDelegationSummary | null;
  busy: boolean;
  saveSelected: () => void | Promise<void>;
  resetDraft: () => void;
  deleteSelected: () => void | Promise<void>;
  action: (path: string, message: string) => void | Promise<void>;
  selectTab: (tab: CardDetailTab) => void;
  setCommentAction: (mode: CommentActionMode) => void;
  /** Render only the editable fields (v2 edit state); defaults to the full legacy tab. */
  fieldsOnly?: boolean;
};

export function CardDetailsForm({
  selected,
  draft,
  setDraft,
  cards,
  agents,
  departments,
  projects,
  goals,
  delegationSummary,
  busy,
  saveSelected,
  resetDraft,
  deleteSelected,
  action,
  selectTab,
  setCommentAction,
  fieldsOnly = false,
}: CardDetailsFormProps) {
  const { t, locale } = useLocale();

  return <div style={{ display: 'grid', gap: 12 }}>
    <label className="field-label">{t('common.title')}<input className="input" data-field="title" value={String(draft?.title ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), title: e.target.value })} /></label>
    <label className="field-label">{t('kanban.stage')}
      <select className="input" data-field="columnStatus" value={String(draft?.columnStatus ?? selected.columnStatus)} onChange={(e) => setDraft({ ...(draft ?? {}), columnStatus: e.target.value })}>
        {statuses.map((status) => <option value={status} key={status}>{statusLabels[status]?.[locale] ?? status}</option>)}
      </select>
    </label>
    <label className="field-label">{t('kanban.fullDetail')}<textarea className="input" data-field="body" rows={8} value={String(draft?.body ?? '')} onChange={(e) => setDraft({ ...(draft ?? {}), body: e.target.value })} /></label>
    <div className="form-grid">
      <label className="field-label">{t('kanban.assignee')}<select className="input" data-field="assigneeId" value={draft?.assigneeId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), assigneeId: e.target.value || null })}><option value="">{t('kanban.assignee')}</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
      <label className="field-label">{t('kanban.reviewer')}<select className="input" data-field="reviewerId" value={draft?.reviewerId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), reviewerId: e.target.value || null, requiresApproval: Boolean(e.target.value) })}><option value="">{t('kanban.reviewer')}</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
      <label className="field-label">{t('common.department')}<select className="input" data-field="departmentId" value={draft?.departmentId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), departmentId: e.target.value || null, goalId: null })}><option value="">{t('common.department')}</option>{departments.filter((department) => !selected.companyId || department.companyId === selected.companyId).map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
      <label className="field-label">{t('common.project')}<select className="input" data-field="projectId" value={draft?.projectId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), projectId: e.target.value || null, goalId: null, dependencyCardIds: [] })}><option value="">{t('common.project')}</option>{projects.filter((project) => !selected.companyId || project.companyId === selected.companyId).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      <label className="field-label">{t('kanban.goal')}<select className="input" data-field="goalId" value={draft?.goalId ?? ''} onChange={(e) => setDraft({ ...(draft ?? {}), goalId: e.target.value || null })}><option value="">{t('kanban.goal')}</option>{scopedGoalOptions(goals, { companyId: selected.companyId, departmentId: draft?.departmentId ?? selected.departmentId, projectId: draft?.projectId ?? selected.projectId }).map((goal) => <option value={goal.id} key={goal.id}>{goalScope(goal)} / {goal.title}</option>)}</select></label>
      <label className="field-label">{t('kanban.priority')}<select className="input" data-field="priority" value={priorityValue(priorityNumber(draft?.priority ?? selected.priority))} onChange={(e) => setDraft({ ...(draft ?? {}), priority: priorityNumber(e.target.value) })}>{priorities.map((priority) => <option key={priority} value={priority}>{t(`kanban.priority.${priority}`)}</option>)}</select></label>
    </div>
    <details className="runtime-details">
      <summary>{t('kanban.moreFields')}</summary>
      <label className="field-label">{t('kanban.tags')}<input className="input" data-field="tags" value={(draft?.tags ?? []).join(', ')} onChange={(e) => setDraft({ ...(draft ?? {}), tags: parseCsv(e.target.value) })} /></label>
    </details>
    <label className="field-label">{t('kanban.collaboration')}
      <select className="input" data-field="decisionMode" value={['auto', 'solo', 'pair', 'swarm'].includes(String(draft?.decisionMode ?? '')) ? String(draft?.decisionMode) : draft?.decisionMode === 'execute' ? 'solo' : 'auto'} onChange={(e) => setDraft({ ...(draft ?? {}), decisionMode: e.target.value })}>
        <option value="auto">{t('kanban.modeAuto')}</option>
        <option value="solo">{t('kanban.modeSolo')}</option>
        <option value="pair">{t('kanban.modePair')}</option>
        <option value="swarm">{t('kanban.modeSwarm')}</option>
      </select>
    </label>
    <div className="field-label" data-field="dependencyCardIds"><span>{t('kanban.dependencies')}</span><DependencyPicker cards={cards} companyId={selected.companyId} projectId={(draft?.projectId ?? selected.projectId) || null} excludeCardId={selected.id} value={draft?.dependencyCardIds ?? []} onChange={(next) => setDraft({ ...(draft ?? {}), dependencyCardIds: next })} /></div>
    <div className="form-grid">
      <label className="field-label">{t('kanban.maxRetries')}<input className="input" data-field="maxRetries" type="number" min={1} max={10} value={Number(draft?.maxRetries ?? 3)} onChange={(e) => setDraft({ ...(draft ?? {}), maxRetries: Number(e.target.value) })} /></label>
      <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" data-field="requiresApproval" checked={Boolean(draft?.requiresApproval)} onChange={(e) => setDraft({ ...(draft ?? {}), requiresApproval: e.target.checked })} /> {t('kanban.requiresApproval')}</label>
    </div>
    {!fieldsOnly && <>
      <CardRuntimeDetails selected={selected} agents={agents} delegationSummary={delegationSummary} />
      {selected.reviewFeedback && <pre className="log-block">{selected.reviewFeedback}</pre>}
      <div className="action-row">
        <button className="btn btn-primary" disabled={busy} onClick={saveSelected}><Save size={15} /> {t('common.save')}</button>
        <button className="btn" disabled={busy} onClick={resetDraft}><RotateCcw size={15} /> {t('kanban.revert')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/run`, t('kanban.taskDispatched'))}><Play size={15} /> {t('common.runNow')}</button>
        <button className="btn" disabled={busy} onClick={() => action(`/api/cards/${selected.id}/review`, t('kanban.reviewCompleted'))}><ShieldCheck size={15} /> {t('kanban.review')}</button>
        <button className="btn" disabled={busy} onClick={() => { selectTab('comments'); setCommentAction('pause_agent'); }}><StopCircle size={15} /> {t('kanban.pauseWithComment')}</button>
        <button className="btn" disabled={busy || selected.columnStatus === 'cancelled'} onClick={() => action(`/api/cards/${selected.id}/cancel`, t('kanban.taskCancelled'))}><Ban size={15} /> {t('kanban.cancelTask')}</button>
        <button className="btn" disabled={busy} onClick={deleteSelected} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> {t('kanban.deleteTask')}</button>
      </div>
    </>}
  </div>;
}
