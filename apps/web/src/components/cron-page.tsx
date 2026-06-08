'use client';
import { useEffect, useMemo, useState } from 'react';
import { Clock3, Play, RefreshCw, Save } from 'lucide-react';
import { api } from '@/lib/api';

type CronJob = 'dispatch-heartbeat' | 'daily-report' | 'health-check';
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
type Agent = { id: string; companyId: string; name: string; role?: string; isActive?: boolean };

const jobs: Array<{ id: CronJob; name: string; schedule: string; note: string }> = [
  { id: 'dispatch-heartbeat', name: 'Dispatch Heartbeat', schedule: 'company interval', note: 'Dispatch todo cards and review queues.' },
  { id: 'daily-report', name: 'Daily Report', schedule: '0 9 * * 1-5', note: 'Manual report run marker with company and runner scope.' },
  { id: 'health-check', name: 'Health Check', schedule: '*/5 * * * *', note: 'Manual health audit marker with company and runner scope.' },
];

export function CronPage() {
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedJob, setSelectedJob] = useState<CronJob>('dispatch-heartbeat');
  const [companyId, setCompanyId] = useState('');
  const [runnerAgentId, setRunnerAgentId] = useState('');
  const [scheduleType, setScheduleType] = useState<'every' | 'cron' | 'at'>('every');
  const [interval, setInterval] = useState('10');
  const [cronExpr, setCronExpr] = useState('*/10 * * * *');
  const [companyInterval, setCompanyInterval] = useState('10');
  const [companyAutoDispatch, setCompanyAutoDispatch] = useState(true);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);
  const selectedCompany = useMemo(() => companies.find((company) => company.id === companyId) ?? null, [companies, companyId]);
  const scopedAgents = useMemo(() => agents.filter((agent) => !companyId || agent.companyId === companyId), [agents, companyId]);
  const selectedJobMeta = jobs.find((job) => job.id === selectedJob) ?? jobs[0]!;

  async function refresh() {
    setError('');
    try {
      const [nextStatus, companyRows, agentRows, runRows] = await Promise.all([
        api<CronStatus>('/api/cron/status'),
        api<Company[]>('/api/companies'),
        api<Agent[]>('/api/agents'),
        api<CronRun[]>('/api/cron/runs?limit=100'),
      ]);
      setStatus(nextStatus);
      setCompanies(companyRows);
      setAgents(agentRows);
      setRuns(runRows);
      setSelectedRunId((current) => runRows.some((run) => run.id === current) ? current : runRows[0]?.id ?? '');
      const activeCompany = companyRows.find((company) => company.id === companyId) ?? companyRows[0] ?? null;
      if (!companyId && activeCompany) setCompanyId(activeCompany.id);
      if (activeCompany) {
        setCompanyInterval(String(activeCompany.dispatchIntervalSeconds ?? 10));
        setCompanyAutoDispatch(activeCompany.autoDispatchEnabled !== false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cron status');
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyInterval(String(selectedCompany.dispatchIntervalSeconds ?? 10));
    setCompanyAutoDispatch(selectedCompany.autoDispatchEnabled !== false);
    if (runnerAgentId && !agents.some((agent) => agent.id === runnerAgentId && agent.companyId === selectedCompany.id)) setRunnerAgentId('');
  }, [selectedCompany?.id]);

  async function runNow(job: CronJob = selectedJob) {
    setBusy(true);
    setError('');
    try {
      await api('/api/cron/run', {
        method: 'POST',
        body: JSON.stringify({
          job,
          companyId: companyId || null,
          runnerAgentId: runnerAgentId || null,
          schedule: {
            type: scheduleType,
            intervalSeconds: Number(interval) || null,
            expression: cronExpr || null,
          },
        }),
      });
      setToast(`${jobs.find((item) => item.id === job)?.name ?? 'Cron job'} run recorded`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cron run failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveCompanySchedule() {
    if (!selectedCompany) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/companies/${selectedCompany.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          dispatchIntervalSeconds: Number(companyInterval) || 10,
          autoDispatchEnabled: companyAutoDispatch,
        }),
      });
      setToast(`${selectedCompany.name} cron settings saved`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Company cron save failed');
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-stack cron-page">
    <div className="page-head">
      <div><h1>Cron</h1><p>Scheduled dispatch heartbeat, company intervals, job runner scope, and cron run history.</p></div>
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

    <section className="card cron-workbench">
      <aside className="cron-job-list">
        <div className="panel-title"><div><h2><Clock3 size={18} /> Jobs</h2><span className="status-pill">{jobs.length} configured</span></div></div>
        <div className="table-list">
          {jobs.map((job) => <button className={`list-row selectable-row ${selectedJob === job.id ? 'active' : ''}`} key={job.id} onClick={() => setSelectedJob(job.id)}>
            <b>{job.name}</b>
            <p>{job.schedule} / {job.note}</p>
          </button>)}
        </div>
      </aside>

      <main className="cron-job-detail">
        <div className="project-editor-head">
          <div><h2>{selectedJobMeta.name}</h2><span className="status-pill">{selectedCompany?.name ?? 'All visible companies'}</span></div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void runNow()}><Play size={15} /> Run now</button>
        </div>

        <section className="project-section">
          <h3>Run Scope</h3>
          <div className="form-grid">
            <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setRunnerAgentId(''); }}>
              <option value="">All visible companies</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select></label>
            <label className="field-label">Runner<select className="input" value={runnerAgentId} onChange={(event) => setRunnerAgentId(event.target.value)}>
              <option value="">Current operator</option>
              {scopedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` / ${agent.role}` : ''}</option>)}
            </select></label>
          </div>
        </section>

        <section className="project-section">
          <h3>Schedule</h3>
          <div className="form-grid">
            <label className="field-label">Schedule type<select className="input" value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}>
              <option value="every">every</option>
              <option value="cron">cron</option>
              <option value="at">at</option>
            </select></label>
            <label className="field-label">Interval seconds<input className="input" value={interval} onChange={(event) => setInterval(event.target.value)} /></label>
            <label className="field-label">Cron expression<input className="input" value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} /></label>
          </div>
        </section>

        <section className="project-section">
          <h3>Company Dispatch Interval</h3>
          <div className="form-grid">
            <label className="field-label">Company interval seconds<input className="input" value={companyInterval} onChange={(event) => setCompanyInterval(event.target.value)} disabled={!selectedCompany} /></label>
            <label className="check-row"><input type="checkbox" checked={companyAutoDispatch} onChange={(event) => setCompanyAutoDispatch(event.target.checked)} disabled={!selectedCompany} /> Auto-dispatch enabled</label>
          </div>
          <button className="btn" disabled={busy || !selectedCompany} onClick={saveCompanySchedule}><Save size={15} /> Save company interval</button>
        </section>
      </main>
    </section>

    <section className="card section-card">
      <div className="panel-title"><h2>Company Heartbeat</h2><span className="status-pill">{companies.length} companies</span></div>
      <div className="table-list">
        {companies.map((company) => {
          const tick = status?.companyTicks.find((item) => item.companyId === company.id);
          return <div className="list-row heartbeat-row" key={company.id}>
            <div><b>{company.name}</b><p>{company.autoDispatchEnabled === false ? 'dispatch paused' : `dispatch ${company.dispatchIntervalSeconds ?? 10}s`} / last tick {tick ? new Date(tick.lastTickMs).toLocaleString() : 'none'}</p></div>
            <button className="btn" onClick={() => { setCompanyId(company.id); setSelectedJob('dispatch-heartbeat'); }}>Use</button>
          </div>;
        })}
      </div>
    </section>

    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Run History</h2><span className="status-pill">{runs.length} runs</span></div>
        <div className="table-list">
          {runs.map((run) => <button className="list-row selectable-row" key={run.id} style={{ borderColor: run.id === selectedRun?.id ? 'var(--primary)' : 'var(--border)' }} onClick={() => setSelectedRunId(run.id)}>
            <b>{run.name} / {run.status}</b>
            <p>{run.startedAt ? new Date(run.startedAt).toLocaleString() : ''} / {run.durationSeconds ?? 0}s / {run.source}</p>
          </button>)}
        </div>
      </section>

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
    </div>
  </div>;
}
