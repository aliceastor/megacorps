'use client';
import { useEffect, useRef } from 'react';
import { Check, RotateCcw, Save } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { CardDetailsForm, type CardDetailsFormProps } from './card-details-form';
import type { OverviewChipField } from './card-overview-chips';

// The overview zone's edit state: the PR-0 form fields plus 儲存 / 還原 /
// 完成編輯. `overviewEditing` lives on the board (reset on card change) and a
// successful save flips it back to read-only there; `focusField` is the chip
// the reader clicked to get here.

export type CardOverviewEditProps = CardDetailsFormProps & {
  focusField: OverviewChipField | null;
  onDone: () => void;
};

export function CardOverviewEdit({ focusField, onDone, ...form }: CardOverviewEditProps) {
  const { t } = useLocale();
  const hostRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusField || !hostRef.current) return;
    const field = hostRef.current.querySelector<HTMLElement>(`[data-field="${focusField}"]`);
    if (!field) return;
    const target = field.matches('input, select, textarea') ? field : field.querySelector<HTMLElement>('input, select, textarea');
    target?.focus();
    if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'center' });
  }, [focusField, form.selected.id]);

  return <section className="card-overview card-overview-edit" ref={hostRef} aria-label={t('kanban.overviewEdit')}>
    <CardDetailsForm {...form} fieldsOnly />
    <div className="card-overview-actions">
      <button className="btn btn-primary" disabled={form.busy} onClick={form.saveSelected}><Save size={15} /> {t('common.save')}</button>
      <button className="btn" disabled={form.busy} onClick={form.resetDraft}><RotateCcw size={15} /> {t('kanban.revert')}</button>
      <span className="card-overview-actions-spacer" />
      <button className="btn" disabled={form.busy} onClick={onDone}><Check size={15} /> {t('kanban.overviewDone')}</button>
    </div>
  </section>;
}
