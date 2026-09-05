'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Activity as ActivityIcon, Clock, Copy, FileText, Loader2, Play, Server } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type LogTab = 'prompts' | 'runs' | 'activity' | 'api';
type DatasetKey = 'prompts' | 'activity' | 'api' | 'heartbeats' | 'tasks' | 'cron';
type SummaryPage<T = any> = { items: T[]; nextCursor: string | null };
type Dataset = SummaryPage & { loading: boolean; error: string | null; requested: boolean };
type AgentRef = { id: string; name: string; companyId: string };
type CronStatus = { enabled: boolean; intervalMs: number; running: boolean; lastStatus: string; lastStartedAt?: string | null; lastCompletedAt?: string | null; lastError?: string | null };

const DATASET_KEYS: DatasetKey[] = ['prompts', 'activity', 'api', 'heartbeats', 'tasks', 'cron'];
const EMPTY_DATASET: Dataset = { items: [], nextCursor: null, loading: false, error: null, requested: false };
const TAB_DATASETS: Record<LogTab, DatasetKey[]> = { prompts: ['prompts'], runs: ['cron', 'tasks', 'heartbeats'], activity: ['activity'], api: ['api'] };
const DATASET_PATH: Record<DatasetKey, string> = {
  prompts: '/api/prompt-logs',
  activity: '/api/activity',
  api: '/api/system-logs',
  heartbeats: '/api/heartbeat-runs',
  tasks: '/api/task-runs',
  cron: '/api/cron/runs',
};
const DETAIL_PATH: Record<DatasetKey, string> = {
  prompts: '/api/prompt-logs',
  activity: '/api/activity',
  api: '/api/system-logs',
  heartbeats: '/api/heartbeat-runs',
  tasks: '/api/task-runs',
  cron: '/api/cron/runs',
};

function initialParam(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : 'request_failed';
}

export function LogsPage() {
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<LogTab>('prompts');
  const [filter, setFilter] = useState(() => initialParam('q', ''));
  const [debouncedFilter, setDebouncedFilter] = useState(() => initialParam('q', ''));
  const [agentFilter, setAgentFilter] = useState(() => initialParam('agentId', 'all'));
  const [surfaceFilter, setSurfaceFilter] = useState<'all' | 'kanban' | 'chat'>(() => {
    const value = initialParam('surface', 'all');
    return value === 'kanban' || value === 'chat' ? value : 'all';
  });
  const [companyId, setCompanyId] = useState(() => initialParam('companyId', ''));
  const [agentRefs, setAgentRefs] = useState<AgentRef[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Record<DatasetKey, Dataset>>(() => Object.fromEntries(DATASET_KEYS.map(key => [key, { ...EMPTY_DATASET }])) as Record<DatasetKey, Dataset>);
  const [cronStatus, setCronStatus] = useState<CronStatus | null>(null);
  const [cronRunning, setCronRunning] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ key: DatasetKey; id: string } | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const versions = useRef<Record<DatasetKey, number>>(Object.fromEntries(DATASET_KEYS.map(key => [key, 0])) as Record<DatasetKey, number>);
  const controllers = useRef<Partial<Record<DatasetKey, AbortController>>>({});
  const agentVersion = useRef(0);
  const agentController = useRef<AbortController | null>(null);
  const detailVersion = useRef(0);
  const detailController = useRef<AbortController | null>(null);

  function invalidateDetail() {
    detailVersion.current += 1;
    detailController.current?.abort();
    detailController.current = null;
    setExpanded(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  useEffect(() => {
    setFilter(searchParams.get('q') ?? '');
    setAgentFilter(searchParams.get('agentId') ?? 'all');
    const nextSurface = searchParams.get('surface');
    setSurfaceFilter(nextSurface === 'kanban' || nextSurface === 'chat' ? nextSurface : 'all');
    setCompanyId(searchParams.get('companyId') ?? '');
  }, [searchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedFilter(filter.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filter]);

  async function loadAgents() {
    const version = ++agentVersion.current;
    agentController.current?.abort();
    const controller = new AbortController();
    agentController.current = controller;
    setAgentRefs([]);
    setAgentError(null);
    try {
      const query = new URLSearchParams({ view: 'labels' });
      if (companyId) query.set('companyId', companyId);
      const rows = await api<AgentRef[]>(`/api/agents?${query}`, { signal: controller.signal });
      if (agentVersion.current !== version) return;
      setAgentRefs(rows);
      setAgentError(null);
    } catch (error) {
      if (agentVersion.current !== version) return;
      setAgentError(displayError(error));
    }
  }

  useEffect(() => { void loadAgents(); }, [companyId]);

  function queryFor(key: DatasetKey, cursor?: string | null): string {
    const query = new URLSearchParams({ view: 'summary', limit: '50' });
    if (cursor) query.set('cursor', cursor);
    if (debouncedFilter) query.set('q', debouncedFilter);
    if (companyId && key !== 'api' && key !== 'cron') query.set('companyId', companyId);
    if (key === 'prompts') {
      if (agentFilter !== 'all') query.set('agentId', agentFilter);
      if (surfaceFilter !== 'all') query.set('surface', surfaceFilter);
    }
    return query.toString();
  }

  async function loadDataset(key: DatasetKey, cursor: string | null = null) {
    invalidateDetail();
    const version = ++versions.current[key];
    controllers.current[key]?.abort();
    const controller = new AbortController();
    controllers.current[key] = controller;
    setDatasets(current => ({ ...current, [key]: { ...current[key], items: cursor ? current[key].items : [], nextCursor: null, loading: true, error: null, requested: true } }));
    try {
      const page = await api<SummaryPage>(`${DATASET_PATH[key]}?${queryFor(key, cursor)}`, { signal: controller.signal });
      if (versions.current[key] !== version) return;
      setDatasets(current => ({ ...current, [key]: { items: page.items, nextCursor: page.nextCursor, loading: false, error: null, requested: true } }));
    } catch (error) {
      if (versions.current[key] !== version) return;
      setDatasets(current => ({ ...current, [key]: { items: [], nextCursor: null, loading: false, error: displayError(error), requested: true } }));
    }
  }

  async function loadCronStatus() {
    try {
      setCronStatus(await api<CronStatus>('/api/cron/status'));
      setCronError(null);
    } catch (error) {
      setCronStatus(null);
      setCronError(displayError(error));
    }
  }

  useEffect(() => {
    for (const key of DATASET_KEYS) {
      versions.current[key] += 1;
      controllers.current[key]?.abort();
    }
    for (const key of TAB_DATASETS[tab]) void loadDataset(key);
    if (tab === 'runs') void loadCronStatus();
  }, [tab, debouncedFilter, agentFilter, surfaceFilter, companyId]);

  useEffect(() => () => {
    for (const key of DATASET_KEYS) controllers.current[key]?.abort();
    agentVersion.current += 1;
    agentController.current?.abort();
    detailVersion.current += 1;
    detailController.current?.abort();
  }, []);

  async function toggleDetail(key: DatasetKey, id: string, retry = false) {
    if (!retry && expanded?.key === key && expanded.id === id) {
      invalidateDetail(); return;
    }
    const version = ++detailVersion.current;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setExpanded({ key, id }); setDetail(null); setDetailError(null); setDetailLoading(true);
    try {
      const row = await api<any>(`${DETAIL_PATH[key]}/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (detailVersion.current === version) setDetail(row);
    } catch (error) {
      if (detailVersion.current === version) setDetailError(displayError(error));
    } finally {
      if (detailVersion.current === version) setDetailLoading(false);
    }
  }

  async function runCronNow() {
    setCronRunning(true); setCronError(null);
    try {
      await api('/api/cron/run', { method: 'POST' });
      await Promise.all([loadCronStatus(), loadDataset('cron')]);
    } catch (error) {
      setCronError(displayError(error));
    } finally {
      setCronRunning(false);
    }
  }

  const agentNameById = useMemo(() => new Map(agentRefs.map(agent => [agent.id, agent.name])), [agentRefs]);
  const tabCount = (id: LogTab) => TAB_DATASETS[id].reduce((total, key) => total + datasets[key].items.length, 0);
  const tabLoaded = (id: LogTab) => TAB_DATASETS[id].some(key => datasets[key].requested);
  const tabHasMore = (id: LogTab) => TAB_DATASETS[id].some(key => datasets[key].nextCursor);
  const tabs: Array<{ id: LogTab; label: string; icon: typeof FileText }> = [
    { id: 'prompts', label: t('logs.prompts'), icon: FileText },
    { id: 'runs', label: t('logs.runs'), icon: Clock },
    { id: 'activity', label: t('logs.activity'), icon: ActivityIcon },
    { id: 'api', label: 'API', icon: Server },
  ];
  const detailPanel = (key: DatasetKey, id: string) => expanded?.key === key && expanded.id === id ? <div className="log-detail">
    {detailLoading && <p className="field-hint"><Loader2 size={14} className="spin" /> Loading details…</p>}
    {detailError && <div role="alert" className="form-error">{detailError} <button className="btn" onClick={() => void toggleDetail(key, id, true)}>Retry</button></div>}
    {detail && <><button className="btn" onClick={() => void navigator.clipboard.writeText(JSON.stringify(detail, null, 2))}><Copy size={13} /> Copy</button><pre aria-label={`${key} detail`} className={key === 'prompts' ? 'log-block prompt-log-body' : 'log-block'}>{JSON.stringify(detail, null, 2)}</pre></>}
  </div> : null;
  const stateMessage = (key: DatasetKey, empty: string) => {
    const state = datasets[key];
    if (state.loading) return <p className="field-hint"><Loader2 size={14} className="spin" /> Loading…</p>;
    if (state.error) return <div role="alert" className="form-error">{state.error} <button className="btn" onClick={() => void loadDataset(key)}>Retry</button></div>;
    if (state.requested && state.items.length === 0) return <p className="field-hint">{empty}</p>;
    return null;
  };
  const pager = (key: DatasetKey) => datasets[key].nextCursor ? <div className="logs-pager"><span>{datasets[key].items.length} loaded; more available</span><button className="btn" onClick={() => void loadDataset(key, datasets[key].nextCursor)}>Next page</button></div> : null;

  return <div className="page-stack logs-page">
    <div className="page-head"><div><h1>{t('title.logs')}</h1><p>{t('logs.subtitle')}</p></div></div>
    <div className="input-wrap"><input placeholder={t('logs.filterPlaceholder')} value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <div className="tab-row page-tabs" role="tablist">
      {tabs.map(item => {
        const Icon = item.icon;
        const count = tabLoaded(item.id) ? `${tabCount(item.id)}${tabHasMore(item.id) ? '+' : ''}` : 'not loaded';
        return <button key={item.id} role="tab" aria-selected={tab === item.id} className={`tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}><Icon size={15} /> {item.label} <span className="status-pill">{count}</span></button>;
      })}
    </div>

    {tab === 'prompts' && <section className="card section-card">
      <h2>{t('logs.outboundPrompts')}</h2>
      <p className="field-hint">Prompt metadata loads in bounded pages. Open one row to fetch its full redacted prompt and metadata.</p>
      <div className="form-grid">
        <label className="field-label">Agent<select className="input" value={agentFilter} onChange={event => setAgentFilter(event.target.value)}><option value="all">All agents</option>{agentRefs.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field-label">Surface<select className="input" value={surfaceFilter} onChange={event => setSurfaceFilter(event.target.value as 'all' | 'kanban' | 'chat')}><option value="all">Kanban and Direct Chat</option><option value="kanban">Kanban only</option><option value="chat">Direct Chat only</option></select></label>
      </div>
      {agentError && <div role="alert" className="form-error">Agent labels: {agentError} <button className="btn" onClick={() => void loadAgents()}>Retry</button></div>}
      {stateMessage('prompts', t('logs.noPrompts'))}
      <div className="table-list">{datasets.prompts.items.map(row => <article className="list-row prompt-log-row" key={row.id}>
        <div className="prompt-log-head"><b><FileText size={14} /> {row.source === 'chat' ? 'Direct Chat' : 'Kanban'} · {row.source} / {row.adapterType}</b><span>{row.createdAt ? new Date(row.createdAt).toLocaleString() : ''}</span></div>
        <p>{row.title}</p><p className="field-hint">{row.preview}</p>
        <div className="log-meta"><span>injection {row.contextMode ?? 'unknown'}</span><span>agent {agentNameById.get(row.agentId) ?? row.agentId ?? 'none'}</span><span>card {row.cardId ?? 'none'}</span><span>hash {String(row.promptHash ?? '').slice(0, 12)}</span></div>
        <button className="btn" disabled={datasets.prompts.loading} onClick={() => void toggleDetail('prompts', row.id)}>{expanded?.key === 'prompts' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>
        {detailPanel('prompts', row.id)}
      </article>)}</div>{pager('prompts')}
    </section>}

    {tab === 'runs' && <div className="logs-grid">
      <section className="card section-card"><div className="panel-title"><div><h2>{t('logs.cronHeartbeat')}</h2><span className="status-pill">{cronStatus?.enabled === false ? 'disabled' : cronStatus?.running ? 'running' : cronStatus?.lastStatus ?? 'unknown'}</span></div><button className="btn" onClick={() => void runCronNow()} disabled={cronRunning}>{cronRunning ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {t('common.runNow')}</button></div>
        {cronError && <div role="alert" className="form-error">{cronError} <button className="btn" onClick={() => void loadCronStatus()}>Retry</button></div>}
        <div className="meta-grid"><span>{t('logs.interval')} <b>{cronStatus ? `${Math.round(cronStatus.intervalMs / 1000)}s` : '-'}</b></span><span>{t('logs.lastStarted')} <b>{cronStatus?.lastStartedAt ? new Date(cronStatus.lastStartedAt).toLocaleString() : '-'}</b></span><span>{t('logs.lastCompleted')} <b>{cronStatus?.lastCompletedAt ? new Date(cronStatus.lastCompletedAt).toLocaleString() : '-'}</b></span><span>{t('common.errorLabel')} <b>{cronStatus?.lastError ?? 'none'}</b></span></div>
        {stateMessage('cron', 'No scheduler runs on this page.')}<div className="table-list">{datasets.cron.items.map(row => <article className="list-row" key={row.id}><b>{row.name} / {row.status}</b><p>{row.source} / {row.durationSeconds ?? 0}s / {row.createdAt ? new Date(row.createdAt).toLocaleString() : 'time unavailable'}</p>{row.error && <p className="form-error">{row.error}</p>}<button className="btn" disabled={datasets.cron.loading} onClick={() => void toggleDetail('cron', row.id)}>{expanded?.key === 'cron' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>{detailPanel('cron', row.id)}</article>)}</div>{pager('cron')}
      </section>
      <section className="card section-card"><h2>{t('logs.taskRuns')}</h2>{stateMessage('tasks', 'No task runs on this page.')}<div className="table-list">{datasets.tasks.items.map(row => <article className="list-row" key={row.id}><b>{row.kind} / {row.status}</b><p>{row.cardId} / {row.agentId ?? 'no agent'} / attempt {row.attemptNumber ?? 1}</p><p className="field-hint">{row.createdAt ? new Date(row.createdAt).toLocaleString() : 'time unavailable'} / {row.durationSeconds ?? 0}s / ${row.costUsd ?? '0'} / session {row.adapterSessionId ?? 'none'}</p>{row.error && <p className="form-error">{row.error}</p>}<button className="btn" disabled={datasets.tasks.loading} onClick={() => void toggleDetail('tasks', row.id)}>{expanded?.key === 'tasks' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>{detailPanel('tasks', row.id)}</article>)}</div>{pager('tasks')}</section>
      <section className="card section-card"><h2>{t('logs.heartbeatRuns')}</h2>{stateMessage('heartbeats', 'No heartbeat runs on this page.')}<div className="table-list">{datasets.heartbeats.items.map(row => <article className="list-row" key={row.id}><b>{row.source} / {row.status}</b><p>{row.cardId ?? 'no card'} / {row.agentId ?? 'no agent'} / {row.durationSeconds ?? 0}s / ${row.costUsd ?? '0'}</p><p className="field-hint">{row.createdAt ? new Date(row.createdAt).toLocaleString() : 'time unavailable'}</p>{row.error && <p className="form-error">{row.error}</p>}<button className="btn" disabled={datasets.heartbeats.loading} onClick={() => void toggleDetail('heartbeats', row.id)}>{expanded?.key === 'heartbeats' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>{detailPanel('heartbeats', row.id)}</article>)}</div>{pager('heartbeats')}</section>
    </div>}

    {tab === 'activity' && <section className="card section-card"><h2>{t('logs.activity')}</h2>{stateMessage('activity', 'No activity logs on this page.')}<div className="table-list">{datasets.activity.items.map(row => <article className="list-row" key={row.id}><b>{row.action}</b><p>{row.actorType}:{row.actorId} / {row.entityType}:{row.entityId}</p><p className="field-hint">{row.createdAt ? new Date(row.createdAt).toLocaleString() : 'time unavailable'}</p><button className="btn" disabled={datasets.activity.loading} onClick={() => void toggleDetail('activity', row.id)}>{expanded?.key === 'activity' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>{detailPanel('activity', row.id)}</article>)}</div>{pager('activity')}</section>}
    {tab === 'api' && <section className="card section-card"><h2>{t('logs.apiLifecycle')}</h2>{stateMessage('api', 'No API logs on this page.')}<div className="table-list">{datasets.api.items.map(row => <article className="list-row" key={row.id}><b>{row.method} {row.path}</b><p>{row.statusCode ?? '-'} / {row.durationMs ?? 0}ms / {row.createdAt ? new Date(row.createdAt).toLocaleString() : 'time unavailable'}</p>{row.error && <p className="form-error">{row.error}</p>}<button className="btn" disabled={datasets.api.loading} onClick={() => void toggleDetail('api', row.id)}>{expanded?.key === 'api' && expanded.id === row.id ? 'Hide details' : 'Show details'}</button>{detailPanel('api', row.id)}</article>)}</div>{pager('api')}</section>}
  </div>;
}
