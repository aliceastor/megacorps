'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp, ExternalLink } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, API_URL } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type DashboardData = {
  stats: Record<string, number>;
  stages: Record<string, number>;
  recentTaskLogs: Array<{ id: string; type: string; status: string; message: string; createdAt?: string }>;
  recentApiEvents: Array<{ id: string; method: string; path: string; statusCode?: number; error?: string | null; durationMs?: number; createdAt?: string }>;
};

type TimeseriesPoint = { day: string; costUsd: number; completed: number; runs: number; failedRuns: number };
type TimeseriesData = { days: number; points: TimeseriesPoint[] };

const chartAxisStyle = { fontSize: 11, fill: 'currentColor', opacity: 0.7 };

export function Dashboard() {
  const { t } = useLocale();
  const { data, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/api/dashboard'),
    refetchInterval: 60_000,
  });
  const { data: series } = useQuery({
    queryKey: ['dashboardTimeseries'],
    queryFn: () => api<TimeseriesData>('/api/dashboard/timeseries?days=30'),
    refetchInterval: 5 * 60_000,
  });

  if (error) return <p className="form-error">{error instanceof Error ? error.message : t('common.error')}</p>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>{t('common.loading')}</p>;

  const stats = [
    [t('nav.companies'), data.stats.companies ?? 0],
    [t('dashboard.openTasks'), data.stats.openTasks ?? 0],
    [t('dashboard.completed'), data.stats.completedTasks ?? 0],
    [t('dashboard.blocked'), data.stats.blockedTasks ?? 0],
    [t('dashboard.activeAgents'), data.stats.activeAgents ?? 0],
    [t('dashboard.busyAgents'), data.stats.busyAgents ?? 0],
    [t('dashboard.activeRuns'), data.stats.activeRuns ?? 0],
    [t('dashboard.pendingApprovals'), data.stats.pendingApprovals ?? 0],
    [t('dashboard.budgetPolicies'), data.stats.budgetPolicies ?? 0],
    [t('dashboard.monthlyCost'), `$${data.stats.monthlyCost ?? 0}`],
  ];

  const points = series?.points ?? [];
  const shortDay = (day: string) => day.slice(5);

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>{t('title.dashboard')}</h1><p>{t('dashboard.subtitle')}</p></div>
    </div>
    <div className="stat-grid">
      {stats.map(([label, value]) => <section className="card stat-card" key={label}><span>{label}</span><b>{value}</b></section>)}
    </div>
    {points.length > 0 && <div className="dashboard-charts">
      <section className="card section-card dashboard-chart-card">
        <h3>{t('dashboard.costTrend')}</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeOpacity={0.15} vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={chartAxisStyle} minTickGap={24} />
            <YAxis tick={chartAxisStyle} width={48} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            <Line type="monotone" dataKey="costUsd" name="USD" stroke="var(--primary)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </section>
      <section className="card section-card dashboard-chart-card">
        <h3>{t('dashboard.throughput')}</h3>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeOpacity={0.15} vertical={false} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={chartAxisStyle} minTickGap={24} />
            <YAxis tick={chartAxisStyle} width={36} allowDecimals={false} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            <Bar dataKey="completed" name={t('dashboard.completed')} fill="var(--primary)" radius={[3, 3, 0, 0]} />
            <Line type="monotone" dataKey="runs" name={t('dashboard.runs')} stroke="#8884d8" strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="failedRuns" name={t('dashboard.failedRuns')} stroke="var(--danger)" strokeWidth={1.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
    </div>}
    <section className="card section-card">
      <div className="panel-title">
        <div><h2>{t('dashboard.apiHelp')}</h2><p style={{ margin: 0, color: 'var(--muted)' }}>{t('dashboard.apiHelpHint')}</p></div>
        <CircleHelp size={18} />
      </div>
      <div className="action-row">
        <Link className="btn btn-primary" href="/help"><CircleHelp size={15} /> {t('dashboard.openHelp')}</Link>
        <a className="btn" href={`${API_URL}/api/help?format=markdown`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Markdown API</a>
      </div>
    </section>
    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>{t('dashboard.kanbanStages')}</h2></div>
        <div className="table-list">
          {Object.entries(data.stages).map(([stage, count]) => <div className="list-row" key={stage}><b>{stage}</b><p>{count} {t('dashboard.tasksSuffix')}</p></div>)}
        </div>
      </section>
      <section className="card section-card">
        <div className="panel-title"><h2>{t('dashboard.recentTaskActivity')}</h2></div>
        <div className="table-list">
          {data.recentTaskLogs.map((log) => <div className="list-row" key={log.id}><b>{log.type} / {log.status}</b><p>{log.message}</p><p>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p></div>)}
        </div>
      </section>
      <section className="card section-card">
        <div className="panel-title"><h2>{t('dashboard.recentApiEvents')}</h2></div>
        <div className="table-list">
          {data.recentApiEvents.map((event) => <div className="list-row" key={event.id}><b>{event.method} {event.path}</b><p>{event.statusCode ?? '-'} / {event.durationMs ?? 0}ms {event.error ? `/ ${event.error}` : ''}</p></div>)}
        </div>
      </section>
    </div>
  </div>;
}
