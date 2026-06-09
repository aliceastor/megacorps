'use client';
import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, Clock, FileText, Loader2, Play, Server } from 'lucide-react';
import { api } from '@/lib/api';

type ApiEvent = { id: string; method: string; path: string; statusCode?: number; error?: string | null; durationMs?: number; requestBody?: unknown; responseBody?: unknown; createdAt?: string };
type ActivityEvent = { id: string; action: string; entityType: string; entityId: string; actorType: string; actorId: string; details?: unknown; createdAt?: string };
type HeartbeatRun = { id: string; cardId?: string | null; agentId?: string | null; source: string; status: string; error?: string | null; costUsd?: string | null; durationSeconds?: number | null; createdAt?: string };
type TaskRun = { id: string; cardId: string; agentId?: string | null; heartbeatRunId?: string | null; adapterSessionId?: string | null; adapterTurnId?: string | null; kind: string; source: string; status: string; attemptNumber?: number | null; error?: string | null; costUsd?: string | null; durationSeconds?: number | null; createdAt?: string };
type CronRun = { id: string; name: string; source: string; status: string; error?: string | null; durationSeconds?: number | null; details?: unknown; createdAt?: string };
type CronStatus = { enabled: boolean; intervalMs: number; running: boolean; lastStatus: string; lastStartedAt?: string | null; lastCompletedAt?: string | null; lastError?: string | null; recentRuns: CronRun[] };
type PromptLog = { id: string; companyId: string; agentId?: string | null; cardId?: string | null; projectId?: string | null; goalId?: string | null; heartbeatRunId?: string | null; taskRunId?: string | null; chatSessionId?: string | null; source: string; adapterType: string; title: string; prompt: string; promptHash: string; metadata?: unknown; createdAt?: string };
type LogTab = 'prompts' | 'runs' | 'activity' | 'api';

export function LogsPage() {
  const [promptLogs, setPromptLogs] = useState<PromptLog[]>([]);
  const [logs, setLogs] = useState<ApiEvent[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [runs, setRuns] = useState<HeartbeatRun[]>([]);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [cron, setCron] = useState<CronStatus | null>(null);
  const [tab, setTab] = useState<LogTab>('prompts');
  const [filter, setFilter] = useState('');
  const [cronRunning, setCronRunning] = useState(false);

  async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
    try {
      return await promise;
    } catch {
      return fallback;
    }
  }

  async function refresh() {
    await Promise.all([
      safe(api<PromptLog[]>('/api/prompt-logs?limit=300'), []),
      safe(api<ApiEvent[]>('/api/system-logs?limit=300'), []),
      safe(api<ActivityEvent[]>('/api/activity?limit=300'), []),
      safe(api<HeartbeatRun[]>('/api/heartbeat-runs?limit=300'), []),
      safe(api<TaskRun[]>('/api/task-runs?limit=300'), []),
      safe(api<CronStatus>('/api/cron/status'), null),
    ]).then(([promptRows, apiLogs, activityLogs, heartbeatRows, taskRunRows, cronStatus]) => {
      setPromptLogs(promptRows);
      setLogs(apiLogs);
      setActivity(activityLogs);
      setRuns(heartbeatRows);
      setTaskRuns(taskRunRows);
      setCron(cronStatus);
    });
  }

  useEffect(() => { void refresh(); }, []);

  async function runCronNow() {
    setCronRunning(true);
    try {
      await api('/api/cron/run', { method: 'POST' });
      await refresh();
    } finally {
      setCronRunning(false);
    }
  }

  const needle = filter.toLowerCase();
  const visiblePrompts = promptLogs.filter((log) => !needle || `${log.source} ${log.adapterType} ${log.title} ${log.agentId ?? ''} ${log.cardId ?? ''} ${log.chatSessionId ?? ''} ${log.prompt}`.toLowerCase().includes(needle));
  const visible = logs.filter((log) => !needle || `${log.method} ${log.path} ${log.error ?? ''}`.toLowerCase().includes(needle));
  const visibleActivity = activity.filter((event) => !needle || `${event.action} ${event.entityType} ${event.entityId}`.toLowerCase().includes(needle));
  const visibleRuns = runs.filter((run) => !needle || `${run.source} ${run.status} ${run.error ?? ''}`.toLowerCase().includes(needle));
  const visibleTaskRuns = taskRuns.filter((run) => !needle || `${run.kind} ${run.source} ${run.status} ${run.error ?? ''}`.toLowerCase().includes(needle));
  const visibleCronRuns = (cron?.recentRuns ?? []).filter((run) => !needle || `${run.name} ${run.source} ${run.status} ${run.error ?? ''}`.toLowerCase().includes(needle));
  const tabs: Array<{ id: LogTab; label: string; count: number; icon: typeof FileText }> = [
    { id: 'prompts', label: 'Prompts', count: promptLogs.length, icon: FileText },
    { id: 'runs', label: 'Runs', count: runs.length + taskRuns.length + (cron?.recentRuns.length ?? 0), icon: Clock },
    { id: 'activity', label: 'Activity', count: activity.length, icon: ActivityIcon },
    { id: 'api', label: 'API', count: logs.length, icon: Server },
  ];

  return <div className="page-stack logs-page">
    <div className="page-head"><div><h1>Logs</h1><p>Outbound prompts, API lifecycle, product activity, heartbeat runs, locks, costs, and errors.</p></div></div>
    <div className="input-wrap"><input placeholder="Filter logs" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <div className="tab-row page-tabs">
      {tabs.map((item) => {
        const Icon = item.icon;
        return <button key={item.id} className={`tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}><Icon size={15} /> {item.label} <span className="status-pill">{item.count}</span></button>;
      })}
    </div>
    {tab === 'prompts' && <section className="card section-card">
      <h2>Outbound prompts</h2>
      <div className="table-list">
        {visiblePrompts.length === 0 ? <p className="field-hint">No prompt logs yet.</p> : visiblePrompts.map((log) => <article className="list-row prompt-log-row" key={log.id}>
          <div className="prompt-log-head">
            <b><FileText size={14} /> {log.source} / {log.adapterType}</b>
            <span>{log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</span>
          </div>
          <p>{log.title}</p>
          <div className="log-meta">
            <span>agent {log.agentId ?? 'none'}</span>
            <span>card {log.cardId ?? 'none'}</span>
            <span>project {log.projectId ?? 'none'}</span>
            <span>chat {log.chatSessionId ?? 'none'}</span>
            <span>run {log.heartbeatRunId ?? 'none'}</span>
            <span>hash {log.promptHash.slice(0, 12)}</span>
          </div>
          <pre className="log-block prompt-log-body">{log.prompt}</pre>
          <details>
            <summary>metadata</summary>
            <pre className="log-block">{JSON.stringify(log.metadata ?? {}, null, 2)}</pre>
          </details>
        </article>)}
      </div>
    </section>}
    {tab === 'runs' && <div className="logs-grid">
      <section className="card section-card">
        <div className="panel-title">
          <div><h2>Cron heartbeat</h2><span className="status-pill">{cron?.enabled === false ? 'disabled' : cron?.running ? 'running' : cron?.lastStatus ?? 'unknown'}</span></div>
          <button className="btn" onClick={() => void runCronNow()} disabled={cronRunning}>{cronRunning ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Run now</button>
        </div>
        <div className="meta-grid">
          <span>Interval <b>{cron ? `${Math.round(cron.intervalMs / 1000)}s` : '-'}</b></span>
          <span>Last started <b>{cron?.lastStartedAt ? new Date(cron.lastStartedAt).toLocaleString() : '-'}</b></span>
          <span>Last completed <b>{cron?.lastCompletedAt ? new Date(cron.lastCompletedAt).toLocaleString() : '-'}</b></span>
          <span>Error <b>{cron?.lastError ?? 'none'}</b></span>
        </div>
        <div className="table-list">
          {visibleCronRuns.map((run) => <article className="list-row" key={run.id}>
            <b><Clock size={13} /> {run.name} / {run.status}</b>
            <p>{run.source} / {run.durationSeconds ?? 0}s / {run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}</p>
            {run.error && <p className="form-error">{run.error}</p>}
            <pre className="log-block">{JSON.stringify(run.details ?? {}, null, 2)}</pre>
          </article>)}
        </div>
      </section>
      <section className="card section-card">
        <h2>Task runs</h2>
        <div className="table-list">
          {visibleTaskRuns.map((run) => <article className="list-row" key={run.id}>
            <b>{run.kind} / {run.status}</b>
            <p>{run.cardId} / {run.agentId ?? 'no agent'} / attempt {run.attemptNumber ?? 1} / {run.durationSeconds ?? 0}s / ${run.costUsd ?? '0'}</p>
            <p>heartbeat {run.heartbeatRunId ?? 'pending'} / {run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}</p>
            <p>adapter session {run.adapterSessionId ?? 'none'} / turn {run.adapterTurnId ?? 'none'}</p>
            {run.error && <p className="form-error">{run.error}</p>}
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
    </div>}
    {tab === 'activity' && <section className="card section-card">
      <h2>Activity</h2>
      <div className="table-list">
        {visibleActivity.map((event) => <article className="list-row" key={event.id}>
          <b>{event.action}</b>
          <p>{event.actorType}:{event.actorId} / {event.entityType}:{event.entityId} / {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}</p>
          <pre className="log-block">{JSON.stringify(event.details ?? {}, null, 2)}</pre>
        </article>)}
      </div>
    </section>}
    {tab === 'api' && <section className="card section-card">
      <h2>API lifecycle</h2>
      <div className="table-list">
        {visible.map((log) => <article className="list-row" key={log.id}>
          <b>{log.method} {log.path}</b>
          <p>{log.statusCode ?? '-'} / {log.durationMs ?? 0}ms / {log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</p>
          {log.error && <p className="form-error">{log.error}</p>}
          <pre className="log-block">{JSON.stringify({ request: log.requestBody, response: log.responseBody }, null, 2)}</pre>
        </article>)}
      </div>
    </section>}
  </div>;
}
