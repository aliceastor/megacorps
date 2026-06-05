'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type ApiEvent = { id: string; method: string; path: string; statusCode?: number; error?: string | null; durationMs?: number; requestBody?: unknown; responseBody?: unknown; createdAt?: string };

export function LogsPage() {
  const [logs, setLogs] = useState<ApiEvent[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => { api<ApiEvent[]>('/api/system-logs?limit=300').then(setLogs).catch(() => setLogs([])); }, []);
  const visible = logs.filter((log) => !filter || `${log.method} ${log.path} ${log.error ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Logs</h1><p>Full API lifecycle: request, response, status, duration, and errors.</p></div></div>
    <div className="input-wrap"><input placeholder="Filter logs" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <section className="card section-card">
      <div className="table-list">
        {visible.map((log) => <article className="list-row" key={log.id}>
          <b>{log.method} {log.path}</b>
          <p>{log.statusCode ?? '-'} / {log.durationMs ?? 0}ms / {log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p>
          {log.error && <p className="form-error">{log.error}</p>}
          <pre className="log-block">{JSON.stringify({ request: log.requestBody, response: log.responseBody }, null, 2)}</pre>
        </article>)}
      </div>
    </section>
  </div>;
}
