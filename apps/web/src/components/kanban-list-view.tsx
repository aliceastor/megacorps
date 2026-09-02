'use client';
import { useMemo, useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { formatRelative } from '@/lib/relative-time';

// The manager's view of the board: a table, sorted by what moved most recently,
// with child cards nested under their parent. Scanning beats dragging when you
// run a company; the card wall stays one toggle away for the times dragging
// is the point.

export type ListCard = {
  id: string;
  title: string;
  columnStatus: string;
  companyId?: string;
  projectId?: string | null;
  departmentId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  parentCardId?: string | null;
  decisionMode?: string | null;
  requiresApproval?: boolean;
  costUsd?: string | null;
  updatedAt?: string;
};

type Named = { id: string; name: string };

type Props = {
  cards: ListCard[];
  agents: Named[];
  departments: Named[];
  projects: Named[];
  statusLabel: (status: string) => string;
  statusColor: (status: string) => string;
  onSelect: (card: ListCard) => void;
};

function modeLabel(mode: string | null | undefined): string {
  if (!mode) return 'auto';
  if (mode === 'delegate' || mode === 'hybrid' || mode === 'review' || mode === 'integrate') return 'auto';
  if (mode === 'execute') return 'solo';
  return mode;
}

export function KanbanListView({ cards, agents, departments, projects, statusLabel, statusColor, onSelect }: Props) {
  const { t, locale } = useLocale();
  const [onlyWaitingOnMe, setOnlyWaitingOnMe] = useState(false);
  const [onlyMyReviews, setOnlyMyReviews] = useState(false);
  const now = Date.now();

  const name = (list: Named[], id: string | null | undefined) => (id ? list.find((item) => item.id === id)?.name ?? '—' : '—');

  const rows = useMemo(() => {
    const filtered = cards.filter((card) => {
      if (onlyWaitingOnMe && card.columnStatus !== 'waiting_on_client') return false;
      if (onlyMyReviews && !(card.requiresApproval && (card.columnStatus === 'in_review' || card.columnStatus === 'needs_review'))) return false;
      return true;
    });
    const byRecent = (a: ListCard, b: ListCard) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '');
    const visible = new Set(filtered.map((card) => card.id));
    const children = new Map<string, ListCard[]>();
    const roots: ListCard[] = [];
    for (const card of filtered) {
      if (card.parentCardId && visible.has(card.parentCardId)) {
        const list = children.get(card.parentCardId) ?? [];
        list.push(card);
        children.set(card.parentCardId, list);
      } else {
        roots.push(card);
      }
    }
    // A parent surfaces when any of its children moved: sort roots by the
    // freshest activity in their subtree.
    const subtreeLatest = (card: ListCard): number => Math.max(Date.parse(card.updatedAt ?? '') || 0, ...(children.get(card.id) ?? []).map(subtreeLatest));
    roots.sort((a, b) => subtreeLatest(b) - subtreeLatest(a));
    const out: Array<{ card: ListCard; depth: number }> = [];
    const walk = (card: ListCard, depth: number) => {
      out.push({ card, depth });
      for (const child of (children.get(card.id) ?? []).sort(byRecent)) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return out;
  }, [cards, onlyMyReviews, onlyWaitingOnMe]);

  const totalCost = rows.reduce((sum, row) => sum + Number(row.card.costUsd ?? 0), 0);

  return <section className="card section-card kanban-list">
    <div className="panel-title">
      <div>
        <h2>{t('kanban.listTitle')}</h2>
        <span className="status-pill">{rows.length} {t('kanban.listCards')} · ${totalCost.toFixed(4)}</span>
      </div>
      <div className="action-row">
        <button className={`btn ${onlyWaitingOnMe ? 'btn-primary' : ''}`} onClick={() => setOnlyWaitingOnMe((value) => !value)}>{t('kanban.filterWaitingOnMe')}</button>
        <button className={`btn ${onlyMyReviews ? 'btn-primary' : ''}`} onClick={() => setOnlyMyReviews((value) => !value)}>{t('kanban.filterMyReviews')}</button>
      </div>
    </div>
    <div className="table-wrap">
      <table className="data-table kanban-list-table">
        <thead>
          <tr>
            <th>{t('common.project')}</th>
            <th>{t('common.title')}</th>
            <th>{t('kanban.stage')}</th>
            <th>{t('kanban.assignee')}</th>
            <th>{t('kanban.reviewer')}</th>
            <th>{t('common.department')}</th>
            <th>{t('kanban.collaboration')}</th>
            <th>{t('kanban.lastActivity')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="field-hint">{t('kanban.listEmpty')}</td></tr>}
          {rows.map(({ card, depth }) => <tr key={card.id} className={depth > 0 ? 'kanban-list-child' : undefined} onClick={() => onSelect(card)} title={card.title}>
            <td>{name(projects, card.projectId)}</td>
            <td style={{ paddingLeft: depth ? 8 + depth * 18 : undefined }}>
              {depth > 0 && <CornerDownRight size={12} style={{ marginRight: 4, opacity: 0.6 }} />}
              <b>{card.title}</b>
            </td>
            <td><span className="badge" style={{ borderColor: statusColor(card.columnStatus), color: statusColor(card.columnStatus) }}>{statusLabel(card.columnStatus)}</span></td>
            <td>{name(agents, card.assigneeId)}</td>
            <td>{card.reviewerId ? name(agents, card.reviewerId) : card.requiresApproval ? t('common.you') : '—'}</td>
            <td>{name(departments, card.departmentId)}</td>
            <td><code>{modeLabel(card.decisionMode)}</code></td>
            <td title={card.updatedAt ? new Date(card.updatedAt).toLocaleString() : ''}>{formatRelative(card.updatedAt, now, locale) || '—'}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}
