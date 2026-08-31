'use client';
import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, Kanban, Network, RotateCcw, Server, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Company = { id: string; name: string };
type TrashType = 'card' | 'project' | 'agent' | 'machineRunner';
type TrashItem = { type: TrashType; id: string; companyId: string; label: string; detail: string | null; deletedAt: string | null };

const TYPE_META: Record<TrashType, { icon: typeof Kanban; label: string }> = {
  card: { icon: Kanban, label: 'Task' },
  project: { icon: FolderGit2, label: 'Project' },
  agent: { icon: Network, label: 'Agent' },
  machineRunner: { icon: Server, label: 'Machine runner' },
};

function shortTime(value: string | null): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

export function TrashPage() {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [items, setItems] = useState<TrashItem[]>([]);
  const [companyId, setCompanyId] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | TrashType>('all');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh(nextCompanyId = companyId, nextType: 'all' | TrashType = typeFilter) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (nextCompanyId !== 'all') params.set('companyId', nextCompanyId);
      if (nextType !== 'all') params.set('type', nextType);
      const query = params.toString();
      const [companyRows, trashRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<TrashItem[]>(`/api/trash${query ? `?${query}` : ''}`),
      ]);
      setCompanies(companyRows);
      setItems(trashRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trash');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void refresh(companyId, typeFilter); }, [companyId, typeFilter]);

  async function restore(item: TrashItem) {
    setBusyId(item.id);
    setError('');
    setToast('');
    try {
      await api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ type: item.type, id: item.id }) });
      setItems((current) => current.filter((row) => row.id !== item.id));
      setToast(`Restored ${TYPE_META[item.type].label.toLowerCase()} "${item.label}"`);
    } catch (err) {
      // The server explains why a restore is blocked (archived parent project,
      // slug already taken); surface that rather than a generic failure.
      const data = (err as { data?: { detail?: string; error?: string } }).data;
      setError(data?.detail ?? data?.error ?? (err instanceof Error ? err.message : 'Restore failed'));
    } finally {
      setBusyId('');
    }
  }

  const companyName = useMemo(() => new Map(companies.map((company) => [company.id, company.name])), [companies]);

  return <div className="page-stack">
    <div className="page-head">
      <div>
        <h1>{t('nav.trash') === 'nav.trash' ? 'Trash' : t('nav.trash')}</h1>
        <p>Deleted tasks, projects, agents, and machine runners are archived, not destroyed. Restore anything here.</p>
      </div>
    </div>

    {error && <p className="form-error">{error}</p>}
    {toast && <p className="field-hint">{toast}</p>}

    <section className="card section-card">
      <div className="panel-title"><h2>Archived items</h2><Trash2 size={18} /></div>
      <div className="form-grid">
        <label className="field-label">Company
          <select className="input" value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
            <option value="all">All companies</option>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="field-label">Type
          <select className="input" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | TrashType)}>
            <option value="all">All types</option>
            {(Object.keys(TYPE_META) as TrashType[]).map((type) => <option key={type} value={type}>{TYPE_META[type].label}</option>)}
          </select>
        </label>
      </div>

      <div className="table-list">
        {loading ? <p className="field-hint">Loading…</p>
          : items.length === 0 ? <p className="field-hint">Nothing archived in this scope.</p>
            : items.map((item) => {
              const Icon = TYPE_META[item.type].icon;
              return <article className="list-row" key={`${item.type}-${item.id}`}>
                <div className="prompt-log-head">
                  <b><Icon size={14} /> {item.label}</b>
                  <button className="btn" disabled={busyId === item.id} onClick={() => void restore(item)}>
                    <RotateCcw size={15} /> {busyId === item.id ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
                <div className="meta-grid">
                  <span>Type <b>{TYPE_META[item.type].label}</b></span>
                  <span>Company <b>{companyName.get(item.companyId) ?? item.companyId}</b></span>
                  <span>Deleted <b>{shortTime(item.deletedAt)}</b></span>
                  {item.detail && <span>Detail <b>{item.detail}</b></span>}
                </div>
              </article>;
            })}
      </div>
    </section>
  </div>;
}
