'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CircleHelp, ExternalLink } from 'lucide-react';
import { api, API_URL } from '@/lib/api';

type DashboardData = {
  stats: Record<string, number>;
  stages: Record<string, number>;
  recentTaskLogs: Array<{ id: string; type: string; status: string; message: string; createdAt?: string }>;
  recentApiEvents: Array<{ id: string; method: string; path: string; statusCode?: number; error?: string | null; durationMs?: number; createdAt?: string }>;
};

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<DashboardData>('/api/dashboard').then(setData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load dashboard'));
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>Loading dashboard...</p>;

  const stats = [
    ['Companies', data.stats.companies ?? 0],
    ['Open tasks', data.stats.openTasks ?? 0],
    ['Completed', data.stats.completedTasks ?? 0],
    ['Blocked', data.stats.blockedTasks ?? 0],
    ['Active agents', data.stats.activeAgents ?? 0],
    ['Busy agents', data.stats.busyAgents ?? 0],
    ['Active runs', data.stats.activeRuns ?? 0],
    ['Pending approvals', data.stats.pendingApprovals ?? 0],
    ['Budget policies', data.stats.budgetPolicies ?? 0],
    ['Monthly cost', `$${data.stats.monthlyCost ?? 0}`],
  ];

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>Dashboard</h1><p>Live operating view for companies, agents, work, cost, and recent activity.</p></div>
    </div>
    <div className="stat-grid">
      {stats.map(([label, value]) => <section className="card stat-card" key={label}><span>{label}</span><b>{value}</b></section>)}
    </div>
    <section className="card section-card">
      <div className="panel-title">
        <div><h2>API Help</h2><p style={{ margin: 0, color: 'var(--muted)' }}>Agents can discover all MegaCorps routes from the Help page or `GET /api/help`.</p></div>
        <CircleHelp size={18} />
      </div>
      <div className="action-row">
        <Link className="btn btn-primary" href="/help"><CircleHelp size={15} /> Open Help</Link>
        <a className="btn" href={`${API_URL}/api/help?format=markdown`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Markdown API</a>
      </div>
    </section>
    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Kanban stages</h2></div>
        <div className="table-list">
          {Object.entries(data.stages).map(([stage, count]) => <div className="list-row" key={stage}><b>{stage}</b><p>{count} task(s)</p></div>)}
        </div>
      </section>
      <section className="card section-card">
        <div className="panel-title"><h2>Recent task activity</h2></div>
        <div className="table-list">
          {data.recentTaskLogs.map((log) => <div className="list-row" key={log.id}><b>{log.type} / {log.status}</b><p>{log.message}</p><p>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p></div>)}
        </div>
      </section>
      <section className="card section-card">
        <div className="panel-title"><h2>Recent API events</h2></div>
        <div className="table-list">
          {data.recentApiEvents.map((event) => <div className="list-row" key={event.id}><b>{event.method} {event.path}</b><p>{event.statusCode ?? '-'} / {event.durationMs ?? 0}ms {event.error ? `/ ${event.error}` : ''}</p></div>)}
        </div>
      </section>
    </div>
  </div>;
}
