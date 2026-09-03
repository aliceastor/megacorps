'use client';
import { useLocale } from '@/lib/locale-context';
import type { Agent } from './card-types';

// The blind review panel's named seats (§17): toggle buttons over the
// company's agents, at most two, never the assignee (the server drops an
// author from the panel anyway). Empty means the server composes the panel
// from the org chart at review time. Shared by the create modal and the edit
// form, like DependencyPicker.

export const PANEL_MAX_REVIEWERS = 2;

export type PanelReviewerPickerProps = {
  agents: Agent[];
  value: string[];
  onChange: (next: string[]) => void;
  /** The card's assignee: shown disabled, never selectable. */
  excludeId?: string | null;
  disabled?: boolean;
};

export function PanelReviewerPicker({ agents, value, onChange, excludeId, disabled = false }: PanelReviewerPickerProps) {
  const { t, tf } = useLocale();
  const full = value.length >= PANEL_MAX_REVIEWERS;
  return <div className="panel-reviewer-picker">
    <div className="action-row" style={{ flexWrap: 'wrap' }}>
      {agents.map((agent) => {
        const on = value.includes(agent.id);
        const blocked = agent.id === excludeId;
        return <button
          type="button"
          key={agent.id}
          className={`btn ${on ? 'btn-primary' : ''}`}
          disabled={disabled || blocked || (!on && full)}
          title={blocked ? t('kanban.assignee') : undefined}
          onClick={() => onChange(on ? value.filter((id) => id !== agent.id) : [...value, agent.id])}
        >{agent.name}{agent.role ? ` / ${agent.role}` : ''}</button>;
      })}
      {agents.length === 0 && <span className="field-hint">{t('kanban.noneAssigned')}</span>}
    </div>
    <span className="field-hint">{tf('kanban.panelReviewersCount', { count: value.length, max: PANEL_MAX_REVIEWERS })} · {t('kanban.panelReviewersHint')}</span>
  </div>;
}
