'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

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
    ['Companies', data.stats.companies],
    ['Open tasks', data.stats.openTasks],
    ['Completed', data.stats.completedTasks],
    ['Blocked', data.stats.blockedTasks],
    ['Active agents', data.stats.activeAgents],
    ['Busy agents', data.stats.busyAgents],
    ['Monthly cost', `$${data.stats.monthlyCost ?? 0}`],
  ];

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>Dashboard</h1><p>Live operating view for companies, agents, work, cost, and recent activity.</p></div>
    </div>
    <div className="stat-grid">
      {stats.map(([label, value]) => <section className="card stat-card" key={label}><span>{label}</span><b>{value}</b></section>)}
    </div>
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
