'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type ApiEvent = { id: string; method: string; path: string; statusCode?: number; error?: string | null; durationMs?: number; requestBody?: unknown; responseBody?: unknown; createdAt?: string };
type ActivityEvent = { id: string; action: string; entityType: string; entityId: string; actorType: string; actorId: string; details?: unknown; createdAt?: string };
type HeartbeatRun = { id: string; cardId?: string | null; agentId?: string | null; source: string; status: string; error?: string | null; costUsd?: string | null; durationSeconds?: number | null; createdAt?: string };

export function LogsPage() {
  const [logs, setLogs] = useState<ApiEvent[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [runs, setRuns] = useState<HeartbeatRun[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void Promise.all([
      api<ApiEvent[]>('/api/system-logs?limit=300'),
      api<ActivityEvent[]>('/api/activity?limit=300'),
      api<HeartbeatRun[]>('/api/heartbeat-runs?limit=300'),
    ]).then(([apiLogs, activityLogs, heartbeatRows]) => {
      setLogs(apiLogs);
      setActivity(activityLogs);
      setRuns(heartbeatRows);
    }).catch(() => { setLogs([]); setActivity([]); setRuns([]); });
  }, []);
  const visible = logs.filter((log) => !filter || `${log.method} ${log.path} ${log.error ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const visibleActivity = activity.filter((event) => !filter || `${event.action} ${event.entityType} ${event.entityId}`.toLowerCase().includes(filter.toLowerCase()));
  const visibleRuns = runs.filter((run) => !filter || `${run.source} ${run.status} ${run.error ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Logs</h1><p>API lifecycle, product activity, heartbeat runs, locks, costs, and errors.</p></div></div>
    <div className="input-wrap"><input placeholder="Filter logs" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <div className="data-grid">
      <section className="card section-card">
        <h2>Activity</h2>
        <div className="table-list">
          {visibleActivity.map((event) => <article className="list-row" key={event.id}>
            <b>{event.action}</b>
            <p>{event.actorType}:{event.actorId} / {event.entityType}:{event.entityId} / {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}</p>
            <pre className="log-block">{JSON.stringify(event.details ?? {}, null, 2)}</pre>
          </article>)}
        </div>
      </section>
      <section className="card section-card">
        <h2>Heartbeat runs</h2>
        <div className="table-list">
          {visibleRuns.map((run) => <article className="list-row" key={run.id}>
            <b>{run.source} / {run.status}</b>
            <p>{run.cardId ?? 'no card'} / {run.agentId ?? 'no agent'} / {run.durationSeconds ?? 0}s / ${run.costUsd ?? '0'}</p>
            {run.error && <p className="form-error">{run.error}</p>}
          </article>)}
        </div>
      </section>
      <section className="card section-card">
        <h2>API lifecycle</h2>
        <div className="table-list">
          {visible.map((log) => <article className="list-row" key={log.id}>
            <b>{log.method} {log.path}</b>
            <p>{log.statusCode ?? '-'} / {log.durationMs ?? 0}ms / {log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p>
            {log.error && <p className="form-error">{log.error}</p>}
            <pre className="log-block">{JSON.stringify({ request: log.requestBody, response: log.responseBody }, null, 2)}</pre>
          </article>)}
        </div>
      </section>
    </div>
  </div>;
}
