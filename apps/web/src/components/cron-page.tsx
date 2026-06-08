'use client';
import { useEffect, useMemo, useState } from 'react';
import { Clock3, Play, RefreshCw, Save } from 'lucide-react';
import { api } from '@/lib/api';

type CronRun = {
  id: string;
  name: string;
  source: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationSeconds?: number | null;
  error?: string | null;
  details?: Record<string, unknown> | null;
};
type CronStatus = {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  companyTicks: Array<{ companyId: string; lastTickMs: number }>;
  recentRuns: CronRun[];
};
type Company = { id: string; name: string; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };

export function CronPage() {
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [jobName, setJobName] = useState('Kanban Dispatch');
  const [scheduleType, setScheduleType] = useState<'every' | 'cron' | 'at'>('every');
  const [interval, setInterval] = useState('10');
  const [cronExpr, setCronExpr] = useState('*/10 * * * *');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);

  async function refresh() {
    setError('');
    try {
      const [nextStatus, companyRows, runRows] = await Promise.all([
        api<CronStatus>('/api/cron/status'),
        api<Company[]>('/api/companies'),
        api<CronRun[]>('/api/cron/runs?limit=100'),
      ]);
      setStatus(nextStatus);
      setCompanies(companyRows);
      setRuns(runRows);
      setSelectedRunId((current) => runRows.some((run) => run.id === current) ? current : runRows[0]?.id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cron status');
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function runNow() {
    setBusy(true);
    setError('');
    try {
      await api('/api/cron/run', { method: 'POST' });
      setToast('Dispatch heartbeat queued');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cron run failed');
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-stack">
    <div className="page-head">
      <div><h1>Cron</h1><p>Scheduled dispatch heartbeat, company intervals, and cron run history.</p></div>
      <button className="btn" onClick={() => void refresh()}><RefreshCw size={15} /> Refresh</button>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <section className="stat-grid">
      <div className="card stat-card"><span>Loop status</span><b>{status?.enabled ? 'On' : 'Off'}</b></div>
      <div className="card stat-card"><span>Base interval</span><b>{Math.round((status?.intervalMs ?? 0) / 1000)}s</b></div>
      <div className="card stat-card"><span>Running now</span><b>{status?.running ? 'Yes' : 'No'}</b></div>
      <div className="card stat-card"><span>Last status</span><b>{status?.lastStatus ?? 'idle'}</b></div>
    </section>

    <div className="split-layout">
      <section className="card section-card">
        <div className="panel-title"><div><h2>Job List</h2><span className="status-pill">dispatch heartbeat</span></div><Clock3 size={18} /></div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Schedule</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              <tr>
                <td><b>Kanban Dispatch</b><small>Built-in dispatch loop</small></td>
                <td>{Math.round((status?.intervalMs ?? 0) / 1000)} seconds</td>
                <td><span className="badge">{status?.enabled ? 'active' : 'paused'}</span></td>
                <td><button className="btn" disabled={busy} onClick={runNow}><Play size={14} /> Run Now</button></td>
              </tr>
              <tr>
                <td><b>Daily Report</b><small>Scaffold only</small></td>
                <td>0 9 * * 1-5</td>
                <td><span className="badge">not configured</span></td>
                <td><button className="btn" disabled>Run Now</button></td>
              </tr>
              <tr>
                <td><b>Health Check</b><small>Scaffold only</small></td>
                <td>*/5 * * * *</td>
                <td><span className="badge">not configured</span></td>
                <td><button className="btn" disabled>Run Now</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Job Detail</h2><span className="status-pill">UI scaffold</span></div>
        <label className="field-label">Job name<input className="input" value={jobName} onChange={(event) => setJobName(event.target.value)} /></label>
        <div className="form-grid">
          <label className="field-label">Schedule type<select className="input" value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}>
            <option value="every">every</option>
            <option value="cron">cron</option>
            <option value="at">at</option>
          </select></label>
          <label className="field-label">Interval seconds<input className="input" value={interval} onChange={(event) => setInterval(event.target.value)} /></label>
        </div>
        <label className="field-label">Cron expression<input className="input" value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} /></label>
        <label className="check-row"><input type="checkbox" checked readOnly /> Enabled</label>
        <div className="action-row">
          <button className="btn btn-primary" disabled><Save size={15} /> Save</button>
          <button className="btn" disabled={busy} onClick={runNow}><Play size={15} /> Run built-in dispatch</button>
        </div>
      </section>
    </div>

    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Company Heartbeat</h2><span className="status-pill">{companies.length} companies</span></div>
        <div className="table-list">
          {companies.map((company) => {
            const tick = status?.companyTicks.find((item) => item.companyId === company.id);
            return <div className="list-row" key={company.id}>
              <b>{company.name}</b>
              <p>{company.autoDispatchEnabled === false ? 'dispatch paused' : `dispatch ${company.dispatchIntervalSeconds ?? 10}s`} / last tick {tick ? new Date(tick.lastTickMs).toLocaleString() : 'none'}</p>
            </div>;
          })}
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Run History</h2><span className="status-pill">{runs.length} runs</span></div>
        <div className="table-list">
          {runs.map((run) => <button className="list-row selectable-row" key={run.id} style={{ borderColor: run.id === selectedRun?.id ? 'var(--primary)' : 'var(--border)' }} onClick={() => setSelectedRunId(run.id)}>
            <b>{run.name} / {run.status}</b>
            <p>{run.startedAt ? new Date(run.startedAt).toLocaleString() : ''} / {run.durationSeconds ?? 0}s / {run.source}</p>
          </button>)}
        </div>
      </section>
    </div>

    {selectedRun && <section className="card section-card">
      <div className="panel-title"><h2>Selected Run</h2><span className="status-pill">{selectedRun.status}</span></div>
      <div className="meta-grid">
        <span>Name <b>{selectedRun.name}</b></span>
        <span>Source <b>{selectedRun.source}</b></span>
        <span>Started <b>{selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : 'none'}</b></span>
        <span>Completed <b>{selectedRun.completedAt ? new Date(selectedRun.completedAt).toLocaleString() : 'none'}</b></span>
      </div>
      {selectedRun.error && <p className="form-error">{selectedRun.error}</p>}
      <pre className="log-block">{JSON.stringify(selectedRun.details ?? {}, null, 2)}</pre>
    </section>}
  </div>;
}
