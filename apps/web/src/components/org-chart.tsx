'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { ArrowUpDown, Ban, CheckCircle2, Loader2, Pause, Pencil, Plus, Save, Search, Trash2, Wifi, X } from 'lucide-react';
import { api } from '@/lib/api';

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
  const isCompanySurface = surface === 'companies';
  const isAgentSurface = surface === 'agents';
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
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
  const [loading, setLoading] = useState(true);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentSort, setAgentSort] = useState<AgentSortKey>('name');
  const [agentSortDir, setAgentSortDir] = useState<'asc' | 'desc'>('asc');

  async function refresh() {
    setLoading(true);
    try {
      const [rows, companyRows, departmentRows, positionRows, runtimeRows, cardRows, approvalRows] = await Promise.all([api<Agent[]>('/api/agents'), api<Company[]>('/api/companies'), api<Department[]>('/api/departments'), api<Position[]>('/api/positions'), api<Runtime[]>('/api/agent-runtimes'), api<Card[]>('/api/cards'), api<Approval[]>('/api/approvals?status=pending&limit=200')]);
      setAgents(rows);
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setPositions(positionRows);
      setRuntimes(runtimeRows);
      setCards(cardRows);
      setApprovals(approvalRows);
      const activeCompany = companyRows.find((company) => company.id === companyId) ?? companyRows[0];
      if (activeCompany) {
        setCompanyId(activeCompany.id);
        setCompanyName(activeCompany.name);
        setCompanyMission(activeCompany.mission ?? '');
        setCompanyInterval(activeCompany.dispatchIntervalSeconds ?? 10);
        setCompanyAutoDispatch(activeCompany.autoDispatchEnabled !== false);
      }
      if (selected) setSelected(rows.find((agent) => agent.id === selected.id) ?? null);
    } catch {
      setToast({ message: 'Failed to load agents', type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
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
    if (!name.trim() || !slug.trim()) { setToast({ message: 'Name and slug are required', type: 'error' }); return; }
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
      setAgents([...agents, agent]);
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
      setToast({ message: `Agent "${agent.name}" created`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create agent', type: 'error' });
    } finally {
      setCreating(false);
    }
  }

  async function saveCompany() {
    if (!companyName.trim()) { setToast({ message: 'Company name is required', type: 'error' }); return; }
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
      setToast({ message: 'Company settings saved', type: 'success' });
      await refresh();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to save company', type: 'error' });
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
    if (!companyId || !deptName.trim() || !deptSlug.trim()) { setToast({ message: 'Company, department name and slug are required', type: 'error' }); return; }
    try {
      const department = await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName.trim(), slug: deptSlug.trim() }) });
      setDepartments([department, ...departments]);
      setDeptName('');
      setDeptSlug('');
      setToast({ message: `Department "${department.name}" created`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create department', type: 'error' });
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
      if ('id' in result) setAgents(agents.map((agent) => (agent.id === result.id ? result : agent)));
      setToast({ message, type: 'success' });
      await refresh();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Action failed', type: 'error' });
    } finally {
      setTesting(null);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    try {
      await api(`/api/agents/${agentId}`, { method: 'DELETE' });
      setAgents(agents.filter((agent) => agent.id !== agentId));
      setSelected(null);
      setToast({ message: `Agent "${agentName}" deleted`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to delete', type: 'error' });
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
      setAgents(agents.map((agent) => (agent.id === updated.id ? updated : agent)));
      setSelected(updated);
      setToast({ message: 'Agent saved', type: 'success' });
      await refresh();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to save agent', type: 'error' });
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
      <div><h1>{isCompanySurface ? 'Companies' : 'Agents'}</h1><p>{isCompanySurface ? 'Company registry, departments, reporting structure, and delegation closure.' : 'Sortable agent management table for assignments, runtimes, budgets, and status.'}</p></div>
      {isCompanySurface && <button className="btn" onClick={startNewCompany}><Plus size={14} /> New Company</button>}
      {isAgentSurface && <button className="btn btn-primary" onClick={() => setAgentCreateOpen(true)}><Plus size={14} /> New Agent</button>}
    </div>

    {isCompanySurface && <section className="card section-card" style={{ marginBottom: 16 }}>
      <div className="panel-title"><h2>Company Registry</h2><span className="status-pill">{companies.length} companies</span></div>
      <div className="table-list">
        {companies.map((company) => <button className="list-row" key={company.id} style={{ textAlign: 'left', cursor: 'pointer', borderColor: company.id === companyId ? 'var(--primary)' : 'var(--border)' }} onClick={() => selectCompany(company)}>
          <b>{company.name}</b><p>{company.slug} / {company.autoDispatchEnabled === false ? 'dispatch off' : `dispatch ${company.dispatchIntervalSeconds ?? 10}s`}</p>
        </button>)}
      </div>
    </section>}

    {isCompanySurface && <section className="card" style={{ padding: 16, display: 'grid', gap: 12, marginBottom: 16 }}>
      <div className="panel-title">
        <div><h2>{isCompanySurface ? 'Company Settings' : 'Company Context'}</h2><span className="status-pill">{companyId ? `auto-dispatch every ${companyInterval}s` : isCompanySurface ? 'new company' : 'select company'}</span></div>
        {isCompanySurface && <button className="btn btn-primary" onClick={saveCompany}>Save Company</button>}
      </div>
      <div className="form-grid">
        <label className="field-label">Company
          <select className="input" value={companyId} disabled={isAgentSurface && companies.length === 0} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            if (next) selectCompany(next);
            else if (isCompanySurface) startNewCompany();
          }}>
            {isCompanySurface && <option value="">New company</option>}
            {isAgentSurface && companies.length === 0 && <option value="">No companies</option>}
            {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
          </select>
        </label>
        {isCompanySurface && <label className="field-label">Company name<input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>}
        {isCompanySurface && <label className="field-label">Dispatch interval seconds<input className="input" type="number" min={5} max={3600} value={companyInterval} onChange={(event) => setCompanyInterval(Number(event.target.value))} /></label>}
        {isCompanySurface && <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={companyAutoDispatch} onChange={(event) => setCompanyAutoDispatch(event.target.checked)} /> Auto-dispatch todo tasks</label>}
      </div>
      {isCompanySurface && <label className="field-label">Mission<textarea className="input" rows={3} value={companyMission} onChange={(event) => setCompanyMission(event.target.value)} /></label>}
      {isCompanySurface && <div className="panel-title"><h2>Department Settings</h2><span className="status-pill">{companyDepartments.length} departments</span></div>}
      {isCompanySurface && <div className="form-grid">
        <label className="field-label">New department<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} /></label>
        <label className="field-label">Department slug<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(event.target.value)} /></label>
      </div>}
      {isCompanySurface && <button className="btn" disabled={!companyId || !deptName.trim() || !deptSlug.trim()} title={companyId ? 'Add department' : 'Save the company before adding departments'} onClick={createDepartment}><Plus size={14} /> Add Department</button>}
      {isCompanySurface && <div className="table-list">{companyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>}
    </section>}

    {isAgentSurface && <section className="card section-card agent-table-toolbar">
      <div className="panel-title">
        <div><h2>Agent management</h2><span className="status-pill">{sortedAgents.length} shown / {visibleAgents.length} total</span></div>
      </div>
      <div className="agent-table-controls">
        <label className="field-label">Company
          <select className="input compact" value={companyId} disabled={companies.length === 0} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            if (next) selectCompany(next);
          }}>
            {companies.length === 0 && <option value="">No companies</option>}
            {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="field-label agent-search-field"><span>Find</span>
          <span className="input-wrap"><Search size={14} /><input placeholder="Name, department, position, adapter..." value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} /></span>
        </label>
      </div>
    </section>}

    {isCompanySurface && <section className="card section-card" style={{ marginBottom: 16 }}>
      <div className="panel-title"><h2>Lifecycle Closure</h2><span className="status-pill">{openCards.length} open / {reviewCards.length} review</span></div>
      <div className="stat-grid">
        <section className="card stat-card"><span>Top members</span><b>{roots.length}</b></section>
        <section className="card stat-card"><span>Middle layer</span><b>{middleAgents.length}</b></section>
        <section className="card stat-card"><span>Leaf executors</span><b>{leafAgents.length}</b></section>
        <section className="card stat-card"><span>Pending approvals</span><b>{approvals.filter((approval) => !companyId || approval.companyId === companyId).length}</b></section>
      </div>
      <div className="data-grid">
        <section className="section-card" style={{ padding: 0 }}>
          <h2>Top-down queue</h2>
          <div className="table-list">{openCards.slice(0, 8).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus} / assigned {visibleAgents.find((agent) => agent.id === card.assigneeId)?.name ?? 'unassigned'}</p></div>)}</div>
        </section>
        <section className="section-card" style={{ padding: 0 }}>
          <h2>Bottom-up review</h2>
          <div className="table-list">{reviewCards.slice(0, 8).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>reviewer {visibleAgents.find((agent) => agent.id === card.reviewerId)?.name ?? 'manager / board'}</p></div>)}</div>
        </section>
      </div>
    </section>}

    <AnimatePresence>
      {agentCreateOpen && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="card modal agent-wizard-modal" initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 12 }}>
            <div className="panel-title">
              <div><h2>Create New Agent</h2><span className="status-pill">Step {agentCreateStep} of 3</span></div>
              <button className="btn icon-btn" aria-label="Close agent wizard" onClick={() => setAgentCreateOpen(false)}><X size={16} /></button>
            </div>
            <div className="wizard-steps" aria-label="Agent wizard progress">
              {[1, 2, 3].map((step) => <span key={step} className={agentCreateStep === step ? 'active' : ''}>{step}</span>)}
            </div>

            {agentCreateStep === 1 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">Name<input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label className="field-label">Slug<input className="input" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
              </div>
            </div>}

            {agentCreateStep === 2 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => {
                  const next = companies.find((company) => company.id === event.target.value);
                  if (next) { selectCompany(next); setDepartmentId(''); setPositionId(''); setBossId(''); }
                }}>{companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}</select></label>
                <label className="field-label">Department<select className="input" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
                <label className="field-label">Position<select className="input" value={positionId} onChange={(event) => setPositionId(event.target.value)}><option value="">No position prompt</option>{companyPositions.map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
                <label className="field-label">Reports to<select className="input" value={bossId} onChange={(event) => setBossId(event.target.value)}><option value="">Top-level member</option>{visibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
                <label className="field-label">Profile<input className="input" value={profile} onChange={(event) => setProfile(event.target.value)} /></label>
              </div>
            </div>}

            {agentCreateStep === 3 && <div className="page-stack">
              <div className="form-grid">
                <label className="field-label">Adapter<select className="input" value={adapterType} onChange={(event) => setAdapterType(event.target.value)}>
                  <option value="hermes-ssh">Hermes SSH</option>
                  <option value="hermes-gateway">Hermes HTTP API</option>
                  <option value="codex-app">Codex App Server</option>
                  <option value="webhook">Webhook</option>
                  <option value="openclaw">OpenClaw</option>
                </select></label>
                <label className="field-label">Runtime<select className="input" value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}><option value="">Runtime required for external adapters</option>{runtimes.filter((runtime) => runtime.adapterType === adapterType && (!companyId || runtime.companyId === companyId)).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
                <label className="field-label">Per-task budget USD<input className="input" type="number" min={0} step="0.01" value={agentBudgetPerTask} onChange={(event) => setAgentBudgetPerTask(event.target.value)} /></label>
                <label className="field-label">Monthly budget USD<input className="input" type="number" min={0} step="0.01" value={agentBudgetMonthly} onChange={(event) => setAgentBudgetMonthly(event.target.value)} /></label>
              </div>
            </div>}

            <div className="action-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => agentCreateStep === 1 ? setAgentCreateOpen(false) : setAgentCreateStep(agentCreateStep - 1)}>{agentCreateStep === 1 ? 'Cancel' : 'Back'}</button>
              {agentCreateStep < 3
                ? <button className="btn btn-primary" disabled={agentCreateStep === 1 && (!name.trim() || !slug.trim())} onClick={() => setAgentCreateStep(agentCreateStep + 1)}>Next</button>
                : <button className="btn btn-primary" onClick={create} disabled={creating || !name.trim() || !slug.trim()}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create</button>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <div style={{ display: 'grid', gap: 16 }}>
        {isAgentSurface && <section className="card section-card agent-table-card">
          <div className="table-wrap">
            <table className="data-table agent-management-table">
              <thead>
                <tr>
                  <th><SortButton keyName="name" label="Agent" /></th>
                  <th><SortButton keyName="position" label="Position" /></th>
                  <th><SortButton keyName="department" label="Department" /></th>
                  <th><SortButton keyName="manager" label="Reports to" /></th>
                  <th><SortButton keyName="adapter" label="Adapter" /></th>
                  <th><SortButton keyName="status" label="Status" /></th>
                  <th><SortButton keyName="spend" label="Spend" /></th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedAgents.length === 0 ? <tr><td colSpan={8}><p className="field-hint">No agents match this filter.</p></td></tr> : sortedAgents.map((agent) => (
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
                        <button className="btn icon-btn" aria-label={`Edit ${agent.name}`} title="Edit" onClick={() => setSelected(agent)}><Pencil size={14} /></button>
                        <button className="btn icon-btn" aria-label={`Test ${agent.name}`} title="Test connection" disabled={testing === agent.id} onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/test-connection`, 'Connection successful')}><Wifi size={14} /></button>
                        {agent.isActive ? <button className="btn icon-btn" aria-label={`Pause ${agent.name}`} title="Pause" onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/pause`, 'Agent paused')}><Pause size={14} /></button> : <button className="btn icon-btn" aria-label={`Resume ${agent.name}`} title="Resume" onClick={() => agentAction(agent.id, `/api/agents/${agent.id}/resume`, 'Agent resumed')}><CheckCircle2 size={14} /></button>}
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
            <div className="panel-title"><h3>{department.name}</h3><span className="status-pill">{visibleAgents.filter((agent) => agent.departmentId === department.id).length} members</span></div>
            <div className="org-chart-scroll" aria-label={`${department.name} organization chart`}>
              <AnimatePresence>
                {(roots.filter((agent) => agent.departmentId === department.id).length ? roots.filter((agent) => agent.departmentId === department.id) : visibleAgents.filter((agent) => agent.departmentId === department.id)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} departments={companyDepartments} positions={companyPositions} selectedId={selected?.id} onSelect={setSelected} />)}
              </AnimatePresence>
            </div>
          </section>)}
        </div>}
        {isCompanySurface && <section className="card org-chart-lane">
          <div className="panel-title"><h3>Unassigned department</h3><span className="status-pill">{visibleAgents.filter((agent) => !agent.departmentId).length} members</span></div>
          <div className="org-chart-scroll" aria-label="Unassigned department organization chart">
          <AnimatePresence>
            {(roots.filter((agent) => !agent.departmentId).length ? roots.filter((agent) => !agent.departmentId) : visibleAgents.filter((agent) => !agent.departmentId)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} departments={companyDepartments} positions={companyPositions} selectedId={selected?.id} onSelect={setSelected} />)}
          </AnimatePresence>
          </div>
        </section>}
        {selected && (
          <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{selected.name}</h2><span className="status-pill">{selected.isBusy ? 'busy' : selected.isActive ? 'idle' : 'offline'}</span></div>
              <button className="btn" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="meta-grid">
              <span>Position <b>{selectedPosition?.name ?? 'none'}</b></span>
              <span>Department <b>{selectedDepartment?.name ?? 'Unassigned'}</b></span>
              <span>Reports to <b>{selectedManager?.name ?? 'top-level'}</b></span>
              <span>Direct reports <b>{selectedReports.length}</b></span>
              <span>Adapter <b>{selected.adapterType ?? 'hermes-ssh'}</b></span>
              <span>Profile <b>{selected.hermesProfile ?? 'none'}</b></span>
              <span>Budget <b>${selected.spentThisMonth ?? '0'} / monthly ${selected.budgetMonthly ?? 'none'} / task ${selected.budgetPerTask ?? 'none'}</b></span>
            </div>
            {selectedAdapterFields.length > 0 && <section className="config-summary">
              <div className="panel-title"><h3>Effective adapter config</h3><span className="status-pill">{selectedRuntime ? `runtime: ${selectedRuntime.name}` : 'no runtime preset'}</span></div>
              <div className="meta-grid">
                {selectedAdapterFields.map((field) => <span key={field.key}>{field.label}<b>{displayConfigValue(configValue(effectiveAdapterConfig, field.key))}</b></span>)}
              </div>
            </section>}
            <div className="form-grid">
              <label className="field-label">Name<input className="input" value={String(agentDraft?.name ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), name: e.target.value })} /></label>
              <label className="field-label">Slug<input className="input" value={String(agentDraft?.slug ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), slug: e.target.value })} /></label>
              <label className="field-label">Profile<input className="input" value={String(agentDraft?.hermesProfile ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), hermesProfile: e.target.value })} /></label>
              <label className="field-label">Adapter<select className="input" value={String(agentDraft?.adapterType ?? 'hermes-ssh')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), adapterType: e.target.value })}>
                <option value="hermes-ssh">Hermes SSH</option>
                <option value="hermes-gateway">Hermes HTTP API</option>
                <option value="codex-app">Codex App Server</option>
                <option value="webhook">Webhook</option>
                <option value="openclaw">OpenClaw</option>
              </select></label>
               <label className="field-label">Runtime preset<select className="input" value={String(agentDraft?.runtimeId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), runtimeId: e.target.value || null })}><option value="">Runtime required</option>{runtimes.filter((runtime) => runtime.adapterType === String(agentDraft?.adapterType ?? selected.adapterType ?? 'hermes-ssh') && runtime.companyId === selected.companyId).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
              <label className="field-label">Department<select className="input" value={String(agentDraft?.departmentId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), departmentId: e.target.value || null })}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="field-label">Position<select className="input" value={String(agentDraft?.positionId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), positionId: e.target.value || null })}><option value="">No position prompt</option>{positions.filter((position) => position.companyId === selected.companyId).map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
              <label className="field-label">Reports to<select className="input" value={String(agentDraft?.bossId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), bossId: e.target.value || null })}><option value="">Top-level member</option>{visibleAgents.filter((agent) => agent.id !== selected.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">Per-task budget<input className="input" type="number" min={0} step="0.01" value={String(agentDraft?.budgetPerTask ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), budgetPerTask: e.target.value })} /></label>
              <label className="field-label">Monthly budget<input className="input" type="number" min={0} step="0.01" value={String(agentDraft?.budgetMonthly ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), budgetMonthly: e.target.value })} /></label>
              {selectedAdapterFields.map((field) => {
                const overrideValue = configValue(overrideAdapterConfig, field.key);
                const inheritedValue = configValue(inheritedAdapterConfig, field.key);
                const inheritedLabel = displayConfigValue(inheritedValue);
                return <label className="field-label" key={field.key}>Override {field.label}
                  {field.description && <span className="field-hint">{field.description}</span>}
                  <span className="field-hint">{inheritedValue === undefined || inheritedValue === null || inheritedValue === '' ? 'No runtime value; leave blank to keep unset.' : `Inherited from runtime: ${inheritedLabel}`}</span>
                  <input className="input" type={field.type ?? (isSensitiveConfigKey(field.key) ? 'password' : 'text')} placeholder={inheritedValue === undefined || inheritedValue === null || inheritedValue === '' ? 'Optional override' : `Inherited: ${inheritedLabel}`} value={String(overrideValue ?? '')} onChange={(e) => updateAgentConfigField(field, e.target.value)} />
                </label>;
              })}
            </div>
            <div className="data-grid">
              <section className="section-card" style={{ padding: 0 }}>
                <h2>Direct reports</h2>
                <div className="table-list">{selectedReports.length ? selectedReports.map((agent) => <button className="list-row" key={agent.id} style={{ textAlign: 'left' }} onClick={() => setSelected(agent)}><b>{agent.name}</b><p>{agentPosition(agent)} / {agentStatus(agent)}</p></button>) : <p style={{ color: 'var(--muted)' }}>No direct reports.</p>}</div>
              </section>
              <section className="section-card" style={{ padding: 0 }}>
                <h2>Assigned work</h2>
                <div className="table-list">{selectedAssignedCards.slice(0, 6).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus}</p></div>)}</div>
              </section>
              <section className="section-card" style={{ padding: 0 }}>
                <h2>Review queue</h2>
                <div className="table-list">{selectedReviewCards.slice(0, 6).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus}</p></div>)}</div>
              </section>
            </div>
            <div className="action-row">
              <button className="btn btn-primary" disabled={testing === selected.id} onClick={saveAgent}><Save size={14} /> Save</button>
              <button className="btn" disabled={testing === selected.id} onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/test-connection`, 'Connection successful')}><Wifi size={14} /> Test</button>
              {selected.isActive ? <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/pause`, 'Agent paused')}><Pause size={14} /> Pause</button> : <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/resume`, 'Agent resumed')}><CheckCircle2 size={14} /> Resume</button>}
              <button className="btn" onClick={() => deleteAgent(selected.id, selected.name)} style={{ color: '#dc2626' }}><Trash2 size={14} /> Fire</button>
            </div>
          </motion.section>
        )}
      </div>
    )}

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}

function AgentNode({ agent, agents, departments, positions, selectedId, onSelect }: { agent: Agent; agents: Agent[]; departments: Department[]; positions: Position[]; selectedId?: string; onSelect: (agent: Agent) => void }) {
  const children = agents.filter((item) => item.bossId === agent.id);
  const departmentName = departments.find((department) => department.id === agent.departmentId)?.name;
  const positionName = positions.find((position) => position.id === agent.positionId)?.name ?? 'No position';
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
