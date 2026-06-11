'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, Ban, CheckCircle2, Loader2, Pause, Pencil, Plus, Save, Search, Trash2, Wifi, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Agent = {
  id: string;
  companyId: string;
  departmentId?: string | null;
  positionId?: string | null;
  name: string;
  slug: string;
  role: string;
  soul?: string | null;
  hermesProfile?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeId?: string | null;
  bossId?: string | null;
  capabilities?: string[] | null;
  isBusy?: boolean;
  isActive?: boolean;
  budgetPerTask?: string;
  budgetMonthly?: string;
  spentThisMonth?: string;
  currentSessionId?: string | null;
};
type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };
type Department = { id: string; companyId: string; name: string; slug: string };
type Position = { id: string; companyId: string; name: string; slug: string; prompt?: string | null };
type Runtime = { id: string; companyId?: string | null; name: string; adapterType: string; config?: Record<string, unknown>; isActive?: boolean };
type Card = { id: string; companyId?: string; title: string; columnStatus?: string; assigneeId?: string | null; reviewerId?: string | null; parentCardId?: string | null };
type Approval = { id: string; companyId: string; cardId?: string | null; status: string; type: string };
type AgentSortKey = 'name' | 'department' | 'position' | 'adapter' | 'manager' | 'status' | 'spend';

type ConfigField = { key: string; label: string; description?: string; type?: 'text' | 'number' | 'password' };

const megacorpsApiDescription = 'MegaCorps API base URL that agents use for task-complete callbacks.';

function adapterFields(adapterType?: string): ConfigField[] {
  if (adapterType === 'hermes-ssh') return [
    { key: 'sshHost', label: 'SSH host' },
    { key: 'sshUser', label: 'SSH user' },
    { key: 'sshPort', label: 'SSH port', type: 'number' },
    { key: 'sshKeyPath', label: 'SSH key path' },
    { key: 'sshOptions', label: 'SSH extra options' },
    { key: 'hermesCommand', label: 'Hermes command' },
    { key: 'megacorpsApiUrl', label: 'MegaCorps callback URL', description: megacorpsApiDescription },
  ];
  if (adapterType === 'hermes-gateway') return [
    { key: 'hermesGatewayUrl', label: 'Hermes HTTP API URL' },
    { key: 'hermesDashboardToken', label: 'Hermes token', type: 'password' },
    { key: 'megacorpsApiUrl', label: 'MegaCorps callback URL', description: megacorpsApiDescription },
  ];
  if (adapterType === 'codex-app') return [
    { key: 'codexTransport', label: 'Codex transport', description: 'stdio or websocket. Prefer stdio for local/container runtimes; use websocket only with bearer token auth.' },
    { key: 'codexCommand', label: 'Codex command' },
    { key: 'codexArgs', label: 'Codex app-server args' },
    { key: 'codexAppServerUrl', label: 'Codex app-server WS URL' },
    { key: 'codexWsToken', label: 'Codex WS bearer token', type: 'password' },
    { key: 'codexModel', label: 'Codex model' },
    { key: 'codexCwd', label: 'Codex cwd override' },
    { key: 'codexSandbox', label: 'Codex sandbox policy' },
    { key: 'codexExperimentalApi', label: 'Experimental API flag' },
  ];
  if (adapterType === 'webhook') return [{ key: 'webhookUrl', label: 'Webhook URL' }];
  if (adapterType === 'openclaw') return [{ key: 'openclawUrl', label: 'OpenClaw URL' }];
  return [];
}

function isSensitiveConfigKey(key: string): boolean {
  return /(password|pass|token|secret|jwt|apiKey|privateKey)/i.test(key);
}

function fieldForStoredKey(key: string): ConfigField {
  if (key === 'publicApiUrl') return { key, label: 'Legacy publicApiUrl', description: megacorpsApiDescription };
  return { key, label: `Stored config: ${key}`, type: isSensitiveConfigKey(key) ? 'password' : key === 'maxTurns' || key === 'sshPort' ? 'number' : 'text' };
}

function visibleAdapterFields(adapterType: string, runtimeConfig: Record<string, unknown>, agentConfig: Record<string, unknown>): ConfigField[] {
  const fields = adapterFields(adapterType);
  const known = new Set(fields.map((field) => field.key));
  if (known.has('megacorpsApiUrl')) {
    known.add('publicApiUrl');
    known.add('callbackUrl');
    known.add('webhookBaseUrl');
  }
  const extraKeys = new Set([...Object.keys(runtimeConfig), ...Object.keys(agentConfig)].filter((key) => !known.has(key)));
  return [...fields, ...Array.from(extraKeys).map(fieldForStoredKey)];
}

function configValue(config: Record<string, unknown>, key: string): unknown {
  if (key === 'megacorpsApiUrl') return config.megacorpsApiUrl ?? config.callbackUrl ?? config.webhookBaseUrl ?? config.publicApiUrl;
  return config[key];
}

function displayConfigValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'not set';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 8, background: type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontSize: 14, zIndex: 200 }}>
    {message}
  </motion.div>;
}

export function OrgChart({ surface = 'companies' }: { surface?: 'companies' | 'agents' }) {
  const { t } = useLocale();
  const isCompanySurface = surface === 'companies';
  const isAgentSurface = surface === 'agents';
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') });
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/api/companies') });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/api/departments') });
  const positionsQuery = useQuery({ queryKey: ['positions'], queryFn: () => api<Position[]>('/api/positions') });
  const runtimesQuery = useQuery({ queryKey: ['agentRuntimes'], queryFn: () => api<Runtime[]>('/api/agent-runtimes') });
  const cardsQuery = useQuery({ queryKey: ['cards'], queryFn: () => api<Card[]>('/api/cards') });
  const approvalsQuery = useQuery({ queryKey: ['approvals', 'pending'], queryFn: () => api<Approval[]>('/api/approvals?status=pending&limit=200') });
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyMission, setCompanyMission] = useState('');
  const [companyInterval, setCompanyInterval] = useState(10);
  const [companyAutoDispatch, setCompanyAutoDispatch] = useState(true);
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [selected, setSelected] = useState<Agent | null>(null);
  const [agentDraft, setAgentDraft] = useState<Partial<Agent> | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [profile, setProfile] = useState('');
  const [agentBudgetPerTask, setAgentBudgetPerTask] = useState('');
  const [agentBudgetMonthly, setAgentBudgetMonthly] = useState('');
  const [bossId, setBossId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [runtimeId, setRuntimeId] = useState('');
  const [adapterType, setAdapterType] = useState('hermes-ssh');
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  const [agentCreateStep, setAgentCreateStep] = useState(1);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentSort, setAgentSort] = useState<AgentSortKey>('name');
  const [agentSortDir, setAgentSortDir] = useState<'asc' | 'desc'>('asc');

  const agents = agentsQuery.data ?? [];
  const companies = companiesQuery.data ?? [];
  const departments = departmentsQuery.data ?? [];
  const positions = positionsQuery.data ?? [];
  const runtimes = runtimesQuery.data ?? [];
  const cards = cardsQuery.data ?? [];
  const approvals = approvalsQuery.data ?? [];
  const loading = agentsQuery.isPending || companiesQuery.isPending || departmentsQuery.isPending || positionsQuery.isPending || runtimesQuery.isPending || cardsQuery.isPending || approvalsQuery.isPending;
  const loadError = agentsQuery.error ?? companiesQuery.error ?? departmentsQuery.error ?? positionsQuery.error ?? runtimesQuery.error ?? cardsQuery.error ?? approvalsQuery.error;

  async function refreshQueries() {
    await Promise.all([['agents'], ['companies'], ['departments'], ['positions'], ['agentRuntimes'], ['cards'], ['approvals', 'pending']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  useEffect(() => {
    if (!companiesQuery.data) return;
    const activeCompany = companiesQuery.data.find((company) => company.id === companyId) ?? companiesQuery.data[0];
    if (activeCompany) {
      setCompanyId(activeCompany.id);
      setCompanyName(activeCompany.name);
      setCompanyMission(activeCompany.mission ?? '');
      setCompanyInterval(activeCompany.dispatchIntervalSeconds ?? 10);
      setCompanyAutoDispatch(activeCompany.autoDispatchEnabled !== false);
    }
  }, [companiesQuery.data]);
  useEffect(() => {
    if (!agentsQuery.data) return;
    const rows = agentsQuery.data;
    setSelected((current) => (current ? rows.find((agent) => agent.id === current.id) ?? null : current));
  }, [agentsQuery.data]);
  useEffect(() => {
    if (loadError) setToast({ message: t('agents.loadFailed'), type: 'error' });
  }, [loadError]);
  useEffect(() => {
    if (!selected) return;
    setAgentDraft({
      name: selected.name,
      slug: selected.slug,
      hermesProfile: selected.hermesProfile ?? '',
      adapterType: selected.adapterType ?? 'hermes-ssh',
      adapterConfig: selected.adapterConfig ?? {},
      runtimeId: selected.runtimeId ?? '',
      bossId: selected.bossId ?? '',
      budgetPerTask: selected.budgetPerTask ?? '',
      departmentId: selected.departmentId ?? '',
      positionId: selected.positionId ?? '',
      budgetMonthly: selected.budgetMonthly ?? '',
    });
  }, [selected?.id]);
  useEffect(() => {
    setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }, [name]);
  useEffect(() => {
    setDeptSlug(deptName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }, [deptName]);

  async function create() {
    if (!name.trim() || !slug.trim()) { setToast({ message: t('agents.nameSlugRequired'), type: 'error' }); return; }
    setCreating(true);
    try {
      const agent = await api<Agent>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          companyId: companyId || undefined,
          departmentId: departmentId || null,
          positionId: positionId || null,
          runtimeId: runtimeId || null,
          name: name.trim(),
          slug: slug.trim(),
          role: 'worker',
          soul: null,
          capabilities: [],
          adapterType,
          hermesProfile: profile.trim() || undefined,
          bossId: bossId || null,
          budgetPerTask: agentBudgetPerTask ? Number(agentBudgetPerTask) : undefined,
          budgetMonthly: agentBudgetMonthly ? Number(agentBudgetMonthly) : undefined,
        }),
      });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => [...(current ?? []), agent]);
      setName('');
      setSlug('');
      setBossId('');
      setDepartmentId('');
      setPositionId('');
      setRuntimeId('');
      setAgentBudgetPerTask('');
      setAgentBudgetMonthly('');
      setAgentCreateOpen(false);
      setAgentCreateStep(1);
      setToast({ message: `${t('agents.created')}: ${agent.name}`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('agents.createFailed'), type: 'error' });
    } finally {
      setCreating(false);
    }
  }

  async function saveCompany() {
    if (!companyName.trim()) { setToast({ message: t('companies.nameRequired'), type: 'error' }); return; }
    try {
      const selectedCompany = companies.find((company) => company.id === companyId);
      const body = JSON.stringify({
        name: companyName.trim(),
        slug: selectedCompany?.slug ?? companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        mission: companyMission,
        dispatchIntervalSeconds: companyInterval,
        autoDispatchEnabled: companyAutoDispatch,
      });
      if (selectedCompany) await api<Company>(`/api/companies/${selectedCompany.id}`, { method: 'PUT', body });
      else await api<Company>('/api/companies', { method: 'POST', body });
      setToast({ message: t('companies.settingsSaved'), type: 'success' });
      await refreshQueries();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('companies.saveFailed'), type: 'error' });
    }
  }

  function startNewCompany() {
    setCompanyId('');
    setCompanyName('');
    setCompanyMission('');
    setCompanyInterval(10);
    setCompanyAutoDispatch(true);
    setSelected(null);
  }

  function selectCompany(company: Company) {
    setCompanyId(company.id);
    setCompanyName(company.name);
    setCompanyMission(company.mission ?? '');
    setCompanyInterval(company.dispatchIntervalSeconds ?? 10);
    setCompanyAutoDispatch(company.autoDispatchEnabled !== false);
    setSelected(null);
  }

  async function createDepartment() {
    if (!companyId || !deptName.trim() || !deptSlug.trim()) { setToast({ message: t('departments.fieldsRequired'), type: 'error' }); return; }
    try {
      const department = await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName.trim(), slug: deptSlug.trim() }) });
      queryClient.setQueryData<Department[]>(['departments'], (current) => [department, ...(current ?? [])]);
      setDeptName('');
      setDeptSlug('');
      setToast({ message: `${t('departments.created')}: ${department.name}`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('departments.createFailed'), type: 'error' });
    }
  }

  function updateAgentConfigField(field: ConfigField, rawValue: string) {
    const nextConfig = { ...((agentDraft?.adapterConfig as Record<string, unknown> | undefined) ?? {}) };
    if (rawValue.trim() === '') {
      delete nextConfig[field.key];
      if (field.key === 'megacorpsApiUrl') {
        delete nextConfig.publicApiUrl;
        delete nextConfig.callbackUrl;
        delete nextConfig.webhookBaseUrl;
      }
      setAgentDraft({ ...(agentDraft ?? {}), adapterConfig: nextConfig });
      return;
    }
    if (field.key === 'megacorpsApiUrl') {
      delete nextConfig.publicApiUrl;
      delete nextConfig.callbackUrl;
      delete nextConfig.webhookBaseUrl;
    }
    nextConfig[field.key] = field.type === 'number' ? Number(rawValue) : rawValue;
    setAgentDraft({ ...(agentDraft ?? {}), adapterConfig: nextConfig });
  }

  async function agentAction(agentId: string, path: string, message: string) {
    setTesting(agentId);
    try {
      const result = await api<Agent | { ok: true }>(path, { method: 'POST' });
      if ('id' in result) queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((agent) => (agent.id === result.id ? result : agent)));
      setToast({ message, type: 'success' });
      await refreshQueries();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('common.actionFailed'), type: 'error' });
    } finally {
      setTesting(null);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    try {
      await api(`/api/agents/${agentId}`, { method: 'DELETE' });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.filter((agent) => agent.id !== agentId));
      setSelected(null);
      setToast({ message: `${t('agents.deleted')}: ${agentName}`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('agents.deleteFailed'), type: 'error' });
    }
  }

  async function saveAgent() {
    if (!selected || !agentDraft) return;
    setTesting(selected.id);
    try {
      const payload = {
        name: String(agentDraft.name ?? selected.name),
        slug: String(agentDraft.slug ?? selected.slug),
        role: selected.role || 'worker',
        soul: selected.soul ?? null,
        adapterType: String(agentDraft.adapterType ?? selected.adapterType ?? 'hermes-ssh'),
        adapterConfig: agentDraft.adapterConfig ?? {},
        runtimeId: agentDraft.runtimeId || null,
        hermesProfile: agentDraft.hermesProfile ? String(agentDraft.hermesProfile) : undefined,
        bossId: agentDraft.bossId || null,
        departmentId: agentDraft.departmentId || null,
        positionId: agentDraft.positionId || null,
        capabilities: [],
        budgetPerTask: agentDraft.budgetPerTask ? Number(agentDraft.budgetPerTask) : undefined,
        budgetMonthly: agentDraft.budgetMonthly ? Number(agentDraft.budgetMonthly) : undefined,
      };
      const updated = await api<Agent>(`/api/agents/${selected.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((agent) => (agent.id === updated.id ? updated : agent)));
      setSelected(updated);
      setToast({ message: t('agents.saved'), type: 'success' });
      await refreshQueries();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : t('agents.saveFailed'), type: 'error' });
    } finally {
      setTesting(null);
    }
  }

  const companyDepartments = companyId ? departments.filter((department) => department.companyId === companyId) : [];
  const companyPositions = companyId ? positions.filter((position) => position.companyId === companyId) : [];
  const visibleAgents = companyId ? agents.filter((agent) => agent.companyId === companyId) : [];
  const roots = visibleAgents.filter((agent) => !agent.bossId);
  const companyCards = companyId ? cards.filter((card) => card.companyId === companyId) : [];
  const middleAgents = visibleAgents.filter((agent) => visibleAgents.some((item) => item.bossId === agent.id) && Boolean(agent.bossId));
  const leafAgents = visibleAgents.filter((agent) => !visibleAgents.some((item) => item.bossId === agent.id));
  const reviewCards = companyCards.filter((card) => card.columnStatus === 'in_review' || card.columnStatus === 'needs_review');
  const openCards = companyCards.filter((card) => !['done', 'blocked', 'cancelled'].includes(card.columnStatus ?? 'todo'));
  const selectedManager = selected?.bossId ? visibleAgents.find((agent) => agent.id === selected.bossId) : null;
  const selectedPosition = selected?.positionId ? positions.find((position) => position.id === selected.positionId) : null;
  const selectedDepartment = selected?.departmentId ? companyDepartments.find((department) => department.id === selected.departmentId) : null;
  const selectedReports = selected ? visibleAgents.filter((agent) => agent.bossId === selected.id) : [];
  const selectedAssignedCards = selected ? companyCards.filter((card) => card.assigneeId === selected.id) : [];
  const selectedReviewCards = selected ? companyCards.filter((card) => card.reviewerId === selected.id || selectedReports.some((report) => report.id === card.assigneeId && ['in_review', 'needs_review'].includes(card.columnStatus ?? 'todo'))) : [];
  const selectedAdapterType = String(agentDraft?.adapterType ?? selected?.adapterType ?? 'hermes-ssh');
  const selectedRuntimeId = String(agentDraft?.runtimeId ?? selected?.runtimeId ?? '');
  const selectedRuntime = selectedRuntimeId ? runtimes.find((runtime) => runtime.id === selectedRuntimeId) : undefined;
  const inheritedAdapterConfig = (selectedRuntime?.config as Record<string, unknown> | undefined) ?? {};
  const overrideAdapterConfig = (agentDraft?.adapterConfig as Record<string, unknown> | undefined) ?? {};
  const configuredOverrideAdapterConfig = Object.fromEntries(Object.entries(overrideAdapterConfig).filter(([, value]) => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')));
  const effectiveAdapterConfig = { ...inheritedAdapterConfig, ...configuredOverrideAdapterConfig };
  const selectedAdapterFields = visibleAdapterFields(selectedAdapterType, inheritedAdapterConfig, overrideAdapterConfig);
  function agentStatus(agent: Agent): string { return agent.isBusy ? 'busy' : agent.isActive === false ? 'offline' : 'idle'; }
  function agentDepartment(agent: Agent): string { return companyDepartments.find((department) => department.id === agent.departmentId)?.name ?? 'Unassigned'; }
  function agentPosition(agent: Agent): string { return positions.find((position) => position.id === agent.positionId)?.name ?? 'No position'; }
  function agentManager(agent: Agent): string { return visibleAgents.find((item) => item.id === agent.bossId)?.name ?? 'Top-level'; }
  function sortValue(agent: Agent, key: AgentSortKey): string | number {
    if (key === 'department') return agentDepartment(agent);
    if (key === 'position') return agentPosition(agent);
    if (key === 'adapter') return agent.adapterType ?? 'hermes-ssh';
    if (key === 'manager') return agentManager(agent);
    if (key === 'status') return agentStatus(agent);
    if (key === 'spend') return Number(agent.spentThisMonth ?? 0);
    return agent.name;
  }
  function chooseAgentSort(key: AgentSortKey) {
    if (agentSort === key) setAgentSortDir(agentSortDir === 'asc' ? 'desc' : 'asc');
    else { setAgentSort(key); setAgentSortDir('asc'); }
  }
  const searchedAgents = visibleAgents.filter((agent) => {
    const haystack = [agent.name, agent.slug, agentDepartment(agent), agentPosition(agent), agentManager(agent), agent.adapterType, agent.hermesProfile, agentStatus(agent)].join(' ').toLowerCase();
    return !agentSearch.trim() || haystack.includes(agentSearch.trim().toLowerCase());
  });
  const sortedAgents = [...searchedAgents].sort((a, b) => {
    const av = sortValue(a, agentSort);
    const bv = sortValue(b, agentSort);
    const result = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return agentSortDir === 'asc' ? result : -result;
  });
  function SortButton({ keyName, label }: { keyName: AgentSortKey; label: string }) {
    return <button type="button" className="text-button table-sort-button" onClick={() => chooseAgentSort(keyName)}>{label}<ArrowUpDown size={13} /></button>;
  }

  return <>
    <div className="page-head">
      <div><h1>{isCompanySurface ? t('title.companies') : t('title.agents')}</h1><p>{isCompanySurface ? t('companies.registrySubtitle') : t('agents.subtitle')}</p></div>
      {isCompanySurface && <button className="btn" onClick={startNewCompany}><Plus size={14} /> {t('companies.newCompany')}</button>}
      {isAgentSurface && <button className="btn btn-primary" onClick={() => setAgentCreateOpen(true)}><Plus size={14} /> {t('agents.newAgent')}</button>}
    </div>

    {isCompanySurface && <section className="card section-card" style={{ marginBottom: 16 }}>
      <div className="panel-title"><h2>{t('companies.registry')}</h2><span className="status-pill">{companies.length} {t('cron.companiesCount')}</span></div>
      <div className="table-list">
        {companies.map((company) => <button className="list-row" key={company.id} style={{ textAlign: 'left', cursor: 'pointer', borderColor: company.id === companyId ? 'var(--primary)' : 'var(--border)' }} onClick={() => selectCompany(company)}>
          <b>{company.name}</b><p>{company.slug} / {company.autoDispatchEnabled === false ? 'dispatch off' : `dispatch ${company.dispatchIntervalSeconds ?? 10}s`}</p>
        </button>)}
      </div>
    </section>}

    {isCompanySurface && <section className="card" style={{ padding: 16, display: 'grid', gap: 12, marginBottom: 16 }}>
      <div className="panel-title">
        <div><h2>{isCompanySurface ? t('settings.companySettings') : t('agents.companyContext')}</h2><span className="status-pill">{companyId ? `${t('agents.autoDispatchEvery')} ${companyInterval}s` : isCompanySurface ? t('companies.newCompany') : t('agents.selectCompany')}</span></div>
        {isCompanySurface && <button className="btn btn-primary" onClick={saveCompany}>{t('companies.saveCompany')}</button>}
      </div>
      <div className="form-grid">
        <label className="field-label">{t('common.company')}
          <select className="input" value={companyId} disabled={isAgentSurface && companies.length === 0} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            if (next) selectCompany(next);
            else if (isCompanySurface) startNewCompany();
          }}>
            {isCompanySurface && <option value="">{t('companies.newCompany')}</option>}
            {isAgentSurface && companies.length === 0 && <option value="">{t('companies.empty')}</option>}
            {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
          </select>
        </label>
        {isCompanySurface && <label className="field-label">{t('companies.companyName')}<input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>}
        {isCompanySurface && <label className="field-label">{t('companies.dispatchIntervalSeconds')}<input className="input" type="number" min={5} max={3600} value={companyInterval} onChange={(event) => setCompanyInterval(Number(event.target.value))} /></label>}
        {isCompanySurface && <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={companyAutoDispatch} onChange={(event) => setCompanyAutoDispatch(event.target.checked)} /> {t('companies.autoDispatchTodo')}</label>}
      </div>
      {isCompanySurface && <label className="field-label">{t('companies.mission')}<textarea className="input" rows={3} value={companyMission} onChange={(event) => setCompanyMission(event.target.value)} /></label>}
      {isCompanySurface && <div className="panel-title"><h2>{t('companies.departmentSettings')}</h2><span className="status-pill">{companyDepartments.length} {t('companies.departmentsCount')}</span></div>}
      {isCompanySurface && <div className="form-grid">
        <label className="field-label">{t('departments.newDepartment')}<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} /></label>
        <label className="field-label">{t('common.slug')}<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(event.target.value)} /></label>
      </div>}
      {isCompanySurface && <button className="btn" disabled={!companyId || !deptName.trim() || !deptSlug.trim()} title={companyId ? t('departments.addDepartment') : t('departments.createCompanyFirstHint')} onClick={createDepartment}><Plus size={14} /> {t('departments.addDepartment')}</button>}
      {isCompanySurface && <div className="table-list">{companyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>}
    </section>}

    {isAgentSurface && <section className="card section-card agent-table-toolbar">
      <div className="panel-title">
        <div><h2>{t('title.agents')}</h2><span className="status-pill">{sortedAgents.length} {t('agents.shown')} / {visibleAgents.length} {t('agents.total')}</span></div>
      </div>
      <div className="agent-table-controls">
        <label className="field-label">{t('common.company')}
          <select className="input compact" value={companyId} disabled={companies.length === 0} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            if (next) selectCompany(next);
          }}>
            {companies.length === 0 && <option value="">{t('companies.empty')}</option>}
            {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="field-label agent-search-field"><span>{t('common.search')}</span>
          <span className="input-wrap"><Search size={14} /><input placeholder={t('agents.searchPlaceholder')} value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} /></span>
        </label>
      </div>
    </section>}

    {isCompanySurface && <section className="card section-card" style={{ marginBottom: 16 }}>
      <div className="panel-title"><h2>{t('companies.lifecycleClosure')}</h2><span className="status-pill">{openCards.length} {t('companies.open')} / {reviewCards.length} {t('companies.review')}</span></div>
      <div className="stat-grid">
        <section className="card stat-card"><span>{t('companies.topMembers')}</span><b>{roots.length}</b></section>
        <section className="card stat-card"><span>{t('companies.middleLayer')}</span><b>{middleAgents.length}</b></section>
        <section className="card stat-card"><span>{t('companies.leafExecutors')}</span><b>{leafAgents.length}</b></section>
        <section className="card stat-card"><span>{t('dashboard.pendingApprovals')}</span><b>{approvals.filter((approval) => !companyId || approval.companyId === companyId).length}</b></section>
      </div>
      <div className="data-grid">
        <section className="section-card" style={{ padding: 0 }}>
          <h2>{t('companies.topDownQueue')}</h2>
          <div className="table-list">{openCards.slice(0, 8).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus} / assigned {visibleAgents.find((agent) => agent.id === card.assigneeId)?.name ?? 'unassigned'}</p></div>)}</div>
        </section>
        <section className="section-card" style={{ padding: 0 }}>
          <h2>{t('companies.bottomUpReview')}</h2>
          <div className="table-list">{reviewCards.slice(0, 8).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>reviewer {visibleAgents.find((agent) => agent.id === card.reviewerId)?.name ?? 'manager / board'}</p></div>)}</div>
        </section>
      </div>
    </section>}

    <AnimatePresence>
      {agentCreateOpen && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="card modal agent-wizard-modal" initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 12 }}>
            <div className="panel-title">
              <div><h2>{t('agents.createNew')}</h2><span className="status-pill">{t('agents.step')} {agentCreateStep} / 3</span></div>
              <button className="btn icon-btn" aria-label={t('common.close')} onClick={() => setAgentCreateOpen(false)}><X size={16} /></button>
            </div>
            <div className="wizard-steps" aria-label="Agent wizard progress">
              {[1, 2, 3].map((step) => <span key={step} className={agentCreateStep === step ? 'active' : ''}>{step}</span>)}
            </div>

            {agentCreateStep === 1 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">{t('common.name')}<input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label className="field-label">{t('common.slug')}<input className="input" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
              </div>
            </div>}

            {agentCreateStep === 2 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">{t('common.company')}<select className="input" value={companyId} onChange={(event) => {
                  const next = companies.find((company) => company.id === event.target.value);
                  if (next) { selectCompany(next); setDepartmentId(''); setPositionId(''); setBossId(''); }
                }}>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select></label>
                <label className="field-label">{t('common.department')}<select className="input" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">{t('common.noDepartment')}</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
                <label className="field-label">{t('agents.position')}<select className="input" value={positionId} onChange={(event) => setPositionId(event.target.value)}><option value="">{t('agents.noPositionPrompt')}</option>{companyPositions.map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
                <label className="field-label">{t('common.reportsTo')}<select className="input" value={bossId} onChange={(event) => setBossId(event.target.value)}><option value="">{t('agents.topLevelMember')}</option>{visibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
                <label className="field-label">{t('agents.profile')}<input className="input" value={profile} onChange={(event) => setProfile(event.target.value)} /></label>
              </div>
            </div>}

            {agentCreateStep === 3 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">{t('settings.adapter')}<select className="input" value={adapterType} onChange={(event) => setAdapterType(event.target.value)}>
                  <option value="hermes-ssh">Hermes SSH</option>
                  <option value="hermes-gateway">Hermes HTTP API</option>
                  <option value="codex-app">Codex App Server</option>
                  <option value="webhook">Webhook</option>
                  <option value="openclaw">OpenClaw</option>
                </select></label>
                <label className="field-label">{t('agents.runtime')}<select className="input" value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}><option value="">{t('agents.runtimeRequiredHint')}</option>{runtimes.filter((runtime) => runtime.adapterType === adapterType && (!companyId || runtime.companyId === companyId)).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
                <label className="field-label">{t('agents.perTaskBudgetUsd')}<input className="input" type="number" min={0} step="0.01" value={agentBudgetPerTask} onChange={(event) => setAgentBudgetPerTask(event.target.value)} /></label>
                <label className="field-label">{t('agents.monthlyBudgetUsd')}<input className="input" type="number" min={0} step="0.01" value={agentBudgetMonthly} onChange={(event) => setAgentBudgetMonthly(event.target.value)} /></label>
              </div>
            </div>}

            <div className="action-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => agentCreateStep === 1 ? setAgentCreateOpen(false) : setAgentCreateStep(agentCreateStep - 1)}>{agentCreateStep === 1 ? t('common.cancel') : t('common.back')}</button>
              {agentCreateStep < 3
                ? <button className="btn btn-primary" disabled={agentCreateStep === 1 && (!name.trim() || !slug.trim())} onClick={() => setAgentCreateStep(agentCreateStep + 1)}>{t('common.next')}</button>
                : <button className="btn btn-primary" onClick={create} disabled={creating || !name.trim() || !slug.trim()}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} {t('common.create')}</button>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>{t('common.loading')}</p> : (
      <div style={{ display: 'grid', gap: 16 }}>
        {isAgentSurface && <section className="card section-card agent-table-card">
          <div className="table-wrap">
            <table className="data-table agent-management-table">
              <thead>
                <tr>
                  <th><SortButton keyName="name" label={t('common.agent')} /></th>
                  <th><SortButton keyName="position" label={t('agents.position')} /></th>
                  <th><SortButton keyName="department" label={t('common.department')} /></th>
                  <th><SortButton keyName="manager" label={t('common.reportsTo')} /></th>
                  <th><SortButton keyName="adapter" label={t('settings.adapter')} /></th>
                  <th><SortButton keyName="status" label={t('common.status')} /></th>
                  <th><SortButton keyName="spend" label={t('agents.spend')} /></th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedAgents.length === 0 ? <tr><td colSpan={8}><p className="field-hint">{t('agents.noMatches')}</p></td></tr> : sortedAgents.map((agent) => (
                  <tr key={agent.id} className={selected?.id === agent.id ? 'expanded-row' : undefined}>
                    <td><button type="button" className="text-button agent-name-button" onClick={() => setSelected(agent)}><b>{agent.name}</b><small>{agent.slug}</small></button></td>
                    <td>{agentPosition(agent)}</td>
                    <td>{agentDepartment(agent)}</td>
                    <td>{agentManager(agent)}</td>
                    <td>{agent.adapterType ?? 'hermes-ssh'}<small>{agent.hermesProfile ?? 'no profile'}</small></td>
                    <td><span className="status-pill">{agentStatus(agent)}</span></td>
                    <td>${agent.spentThisMonth ?? '0'}<small>task {agent.budgetPerTask ?? 'none'} / monthly {agent.budgetMonthly ?? 'none'}</small></td>
                    <td>
                      <div className="action-row compact">
                        <button className="btn icon-btn" aria-label={`${t('common.edit')} ${agent.name}`} title={t('common.edit')} onClick={() => setSelected(agent)}><Pencil size={14} /></button>
                        <button className="btn icon-btn" aria-label={`${t('agents.test')} ${agent.name}`} title={t('agents.testConnection')} disabled={testing === agent.id} onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/test-connection`, t('agents.connectionSuccessful'))}><Wifi size={14} /></button>
                        {agent.isActive ? <button className="btn icon-btn" aria-label={`${t('agents.pause')} ${agent.name}`} title={t('agents.pause')} onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/pause`, t('agents.agentPaused'))}><Pause size={14} /></button> : <button className="btn icon-btn" aria-label={`${t('agents.resume')} ${agent.name}`} title={t('agents.resume')} onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/resume`, t('agents.agentResumed'))}><CheckCircle2 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>}
        {isCompanySurface && <div style={{ display: 'grid', gap: 14 }}>
          {companyDepartments.map((department) => <section key={department.id} className="card org-chart-lane">
            <div className="panel-title"><h3>{department.name}</h3><span className="status-pill">{visibleAgents.filter((agent) => agent.departmentId === department.id).length} {t('companies.membersCount')}</span></div>
            <div className="org-chart-scroll" aria-label={`${department.name} organization chart`}>
              <AnimatePresence>
                {(roots.filter((agent) => agent.departmentId === department.id).length ? roots.filter((agent) => agent.departmentId === department.id) : visibleAgents.filter((agent) => agent.departmentId === department.id)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} departments={companyDepartments} positions={companyPositions} selectedId={selected?.id} onSelect={setSelected} />)}
              </AnimatePresence>
            </div>
          </section>)}
        </div>}
        {isCompanySurface && <section className="card org-chart-lane">
          <div className="panel-title"><h3>{t('companies.unassignedDepartment')}</h3><span className="status-pill">{visibleAgents.filter((agent) => !agent.departmentId).length} {t('companies.membersCount')}</span></div>
          <div className="org-chart-scroll" aria-label="Unassigned department organization chart">
          <AnimatePresence>
            {(roots.filter((agent) => !agent.departmentId).length ? roots.filter((agent) => !agent.departmentId) : visibleAgents.filter((agent) => !agent.departmentId)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} departments={companyDepartments} positions={companyPositions} selectedId={selected?.id} onSelect={setSelected} />)}
          </AnimatePresence>
          </div>
        </section>}
        {selected && (
          <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{selected.name}</h2><span className="status-pill">{selected.isBusy ? t('common.busy') : selected.isActive ? 'idle' : t('common.offline')}</span></div>
              <button className="btn" onClick={() => setSelected(null)}>{t('common.close')}</button>
            </div>
            <div className="meta-grid">
              <span>{t('agents.position')} <b>{selectedPosition?.name ?? 'none'}</b></span>
              <span>{t('common.department')} <b>{selectedDepartment?.name ?? t('common.noDepartment')}</b></span>
              <span>{t('common.reportsTo')} <b>{selectedManager?.name ?? t('agents.topLevelMember')}</b></span>
              <span>{t('agents.directReports')} <b>{selectedReports.length}</b></span>
              <span>{t('settings.adapter')} <b>{selected.adapterType ?? 'hermes-ssh'}</b></span>
              <span>{t('agents.profile')} <b>{selected.hermesProfile ?? 'none'}</b></span>
              <span>{t('agents.budget')} <b>${selected.spentThisMonth ?? '0'} / monthly ${selected.budgetMonthly ?? 'none'} / task ${selected.budgetPerTask ?? 'none'}</b></span>
            </div>
            {selectedAdapterFields.length > 0 && <section className="config-summary">
              <div className="panel-title"><h3>{t('agents.effectiveConfig')}</h3><span className="status-pill">{selectedRuntime ? `runtime: ${selectedRuntime.name}` : 'no runtime preset'}</span></div>
              <div className="meta-grid">
                {selectedAdapterFields.map((field) => <span key={field.key}>{field.label}<b>{displayConfigValue(configValue(effectiveAdapterConfig, field.key))}</b></span>)}
              </div>
            </section>}
            <div className="form-grid">
              <label className="field-label">{t('common.name')}<input className="input" value={String(agentDraft?.name ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), name: e.target.value })} /></label>
              <label className="field-label">{t('common.slug')}<input className="input" value={String(agentDraft?.slug ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), slug: e.target.value })} /></label>
              <label className="field-label">{t('agents.profile')}<input className="input" value={String(agentDraft?.hermesProfile ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), hermesProfile: e.target.value })} /></label>
              <label className="field-label">{t('settings.adapter')}<select className="input" value={String(agentDraft?.adapterType ?? 'hermes-ssh')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), adapterType: e.target.value })}>
                <option value="hermes-ssh">Hermes SSH</option>
                <option value="hermes-gateway">Hermes HTTP API</option>
                <option value="codex-app">Codex App Server</option>
                <option value="webhook">Webhook</option>
                <option value="openclaw">OpenClaw</option>
              </select></label>
               <label className="field-label">{t('agents.runtimePreset')}<select className="input" value={String(agentDraft?.runtimeId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), runtimeId: e.target.value || null })}><option value="">{t('agents.runtimeRequired')}</option>{runtimes.filter((runtime) => runtime.adapterType === String(agentDraft?.adapterType ?? selected.adapterType ?? 'hermes-ssh') && runtime.companyId === selected.companyId).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
              <label className="field-label">{t('common.department')}<select className="input" value={String(agentDraft?.departmentId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), departmentId: e.target.value || null })}><option value="">{t('common.noDepartment')}</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="field-label">{t('agents.position')}<select className="input" value={String(agentDraft?.positionId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), positionId: e.target.value || null })}><option value="">{t('agents.noPositionPrompt')}</option>{positions.filter((position) => position.companyId === selected.companyId).map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
              <label className="field-label">{t('common.reportsTo')}<select className="input" value={String(agentDraft?.bossId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), bossId: e.target.value || null })}><option value="">{t('agents.topLevelMember')}</option>{visibleAgents.filter((agent) => agent.id !== selected.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">{t('agents.perTaskBudget')}<input className="input" type="number" min={0} step="0.01" value={String(agentDraft?.budgetPerTask ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), budgetPerTask: e.target.value })} /></label>
              <label className="field-label">{t('agents.monthlyBudget')}<input className="input" type="number" min={0} step="0.01" value={String(agentDraft?.budgetMonthly ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), budgetMonthly: e.target.value })} /></label>
              {selectedAdapterFields.map((field) => {
                const overrideValue = configValue(overrideAdapterConfig, field.key);
                const inheritedValue = configValue(inheritedAdapterConfig, field.key);
                const inheritedLabel = displayConfigValue(inheritedValue);
                return <label className="field-label" key={field.key}>{t('agents.override')} {field.label}
                  {field.description && <span className="field-hint">{field.description}</span>}
                  <span className="field-hint">{inheritedValue === undefined || inheritedValue === null || inheritedValue === '' ? 'No runtime value; leave blank to keep unset.' : `Inherited from runtime: ${inheritedLabel}`}</span>
                  <input className="input" type={field.type ?? (isSensitiveConfigKey(field.key) ? 'password' : 'text')} placeholder={inheritedValue === undefined || inheritedValue === null || inheritedValue === '' ? 'Optional override' : `Inherited: ${inheritedLabel}`} value={String(overrideValue ?? '')} onChange={(e) => updateAgentConfigField(field, e.target.value)} />
                </label>;
              })}
            </div>
            <div className="data-grid">
              <section className="section-card" style={{ padding: 0 }}>
                <h2>{t('agents.directReports')}</h2>
                <div className="table-list">{selectedReports.length ? selectedReports.map((agent) => <button className="list-row" key={agent.id} style={{ textAlign: 'left' }} onClick={() => setSelected(agent)}><b>{agent.name}</b><p>{agentPosition(agent)} / {agentStatus(agent)}</p></button>) : <p style={{ color: 'var(--muted)' }}>{t('agents.noDirectReports')}</p>}</div>
              </section>
              <section className="section-card" style={{ padding: 0 }}>
                <h2>{t('agents.assignedWork')}</h2>
                <div className="table-list">{selectedAssignedCards.slice(0, 6).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus}</p></div>)}</div>
              </section>
              <section className="section-card" style={{ padding: 0 }}>
                <h2>{t('agents.reviewQueue')}</h2>
                <div className="table-list">{selectedReviewCards.slice(0, 6).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus}</p></div>)}</div>
              </section>
            </div>
            <div className="action-row">
              <button className="btn btn-primary" disabled={testing === selected.id} onClick={saveAgent}><Save size={14} /> {t('common.save')}</button>
              <button className="btn" disabled={testing === selected.id} onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/test-connection`, t('agents.connectionSuccessful'))}><Wifi size={14} /> {t('agents.test')}</button>
              {selected.isActive ? <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/pause`, t('agents.agentPaused'))}><Pause size={14} /> {t('agents.pause')}</button> : <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/resume`, t('agents.agentResumed'))}><CheckCircle2 size={14} /> {t('agents.resume')}</button>}
              <button className="btn" onClick={() => deleteAgent(selected.id, selected.name)} style={{ color: '#dc2626' }}><Trash2 size={14} /> {t('agents.fire')}</button>
            </div>
          </motion.section>
        )}
      </div>
    )}

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}

function AgentNode({ agent, agents, departments, positions, selectedId, onSelect }: { agent: Agent; agents: Agent[]; departments: Department[]; positions: Position[]; selectedId?: string; onSelect: (agent: Agent) => void }) {
  const { t } = useLocale();
  const children = agents.filter((item) => item.bossId === agent.id);
  const departmentName = departments.find((department) => department.id === agent.departmentId)?.name;
  const positionName = positions.find((position) => position.id === agent.positionId)?.name ?? t('agents.noPosition');
  const assignment = departmentName ? `${positionName} / ${departmentName}` : positionName;
  return <motion.div className={`org-tree-node${children.length ? ' has-children' : ''}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
    <button className="agent-node-card org-agent-node" onClick={() => onSelect(agent)} style={{ borderColor: selectedId === agent.id ? 'var(--primary)' : 'var(--border)' }}>
      <div className="org-agent-head">
        <span className={`org-agent-dot ${agent.isBusy ? 'busy' : agent.isActive ? 'active' : 'offline'}`} />
        <b>{agent.name}</b>
        {!agent.isActive && <Ban size={14} style={{ marginLeft: 'auto', color: 'var(--danger)' }} />}
      </div>
      <div className="org-agent-meta">
        <span>{assignment}</span>
        <span>{agent.adapterType ?? 'hermes-ssh'}</span>
      </div>
    </button>
    {children.length > 0 && <div className="agent-children org-children">
      {children.map((child) => <AgentNode key={child.id} agent={child} agents={agents} departments={departments} positions={positions} selectedId={selectedId} onSelect={onSelect} />)}
    </div>}
  </motion.div>;
}
