'use client';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import type { Card } from './card-types';

function projectScopedDependencyCandidates(cards: Card[], input: { companyId?: string | null; projectId?: string | null; excludeCardId?: string | null; query?: string }) {
  const needle = input.query?.trim().toLowerCase() ?? '';
  return cards.filter((card) => {
    if (input.excludeCardId && card.id === input.excludeCardId) return false;
    if (input.companyId && card.companyId !== input.companyId) return false;
    if ((input.projectId ?? null) !== (card.projectId ?? null)) return false;
    if (!needle) return true;
    return `${card.title} ${card.body} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(needle);
  });
}

export function DependencyPicker({
  cards,
  companyId,
  projectId,
  excludeCardId,
  value,
  onChange,
}: {
  cards: Card[];
  companyId?: string | null;
  projectId?: string | null;
  excludeCardId?: string | null;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => projectScopedDependencyCandidates(cards, { companyId, projectId, excludeCardId, query }), [cards, companyId, projectId, excludeCardId, query]);
  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedCount = value.length;

  function toggle(cardId: string, checked: boolean) {
    if (checked) {
      if (!selectedSet.has(cardId)) onChange([...value, cardId]);
      return;
    }
    onChange(value.filter((id) => id !== cardId));
  }

  return <div className="dependency-picker">
    <div className="input-wrap dependency-search"><Search size={14} /><input placeholder={t('kanban.searchDeps')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="dependency-list">
      {candidates.length === 0 ? <p className="field-hint">{projectId ? t('kanban.depNoProjectMatches') : t('kanban.depNoNoProjectMatches')}</p> : candidates.map((card) => (
        <label className="dependency-option" key={card.id}>
          <input type="checkbox" checked={selectedSet.has(card.id)} onChange={(event) => toggle(card.id, event.target.checked)} />
          <span>
            <b>{card.title}</b>
            <small>{card.columnStatus} / {card.id.slice(0, 8)}</small>
          </span>
        </label>
      ))}
    </div>
    <p className="field-hint">{selectedCount === 0 ? t('kanban.depNoneSelected') : `${selectedCount} ${t('kanban.depSelected')}`}</p>
  </div>;
}
