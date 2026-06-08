'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Loader2, Pause, Plus, RotateCcw, Save, Trash2, Wifi } from 'lucide-react';
import { api } from '@/lib/api';

type Agent = {
  id: string;
  companyId: string;
  departmentId?: string | null;
  name: string;
  slug: string;
  role: string;
  title?: string;
  hermesProfile?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeId?: string | null;
  bossId?: string | null;
  isBusy?: boolean;
  isActive?: boolean;
  budgetMonthly?: string;
  spentThisMonth?: string;
  currentSessionId?: string | null;
};
type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };
type Department = { id: string; companyId: string; name: string; slug: string };
type Runtime = { id: string; companyId?: string | null; name: string; adapterType: string; config?: Record<string, unknown>; isActive?: boolean };
type Card = { id: string; companyId?: string; title: string; columnStatus?: string; assigneeId?: string | null; reviewerId?: string | null; parentCardId?: string | null };
type Approval = { id: string; companyId: string; cardId?: string | null; status: string; type: string };

type ConfigField = { key: string; label: string; description?: string; type?: 'text' | 'number' | 'password' };

const megacorpsApiDescription = 'MegaCorps API base URL that agents use for task-complete callbacks.';

function adapterFields(adapterType?: string): ConfigField[] {
  if (adapterType === 'hermes') return [
    { key: 'portainerUrl', label: 'Portainer URL' },
    { key: 'portainerUser', label: 'Portainer user' },
    { key: 'portainerPass', label: 'Portainer password', type: 'password' },
    { key: 'portainerEndpointId', label: 'Endpoint ID' },
    { key: 'hermesContainer', label: 'Hermes container' },
    { key: 'megacorpsApiUrl', label: 'MegaCorps callback URL', description: megacorpsApiDescription },
  ];
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
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
  const [profile, setProfile] = useState('local-debug');
  const [role, setRole] = useState('member');
  const [bossId, setBossId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [runtimeId, setRuntimeId] = useState('');
  const [adapterType, setAdapterType] = useState('mock');
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const [rows, companyRows, departmentRows, runtimeRows, cardRows, approvalRows] = await Promise.all([api<Agent[]>('/api/agents'), api<Company[]>('/api/companies'), api<Department[]>('/api/departments'), api<Runtime[]>('/api/agent-runtimes'), api<Card[]>('/api/cards'), api<Approval[]>('/api/approvals?status=pending&limit=200')]);
      setAgents(rows);
      setCompanies(companyRows);
      setDepartments(departmentRows);
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
      role: selected.role,
      title: selected.title ?? '',
      hermesProfile: selected.hermesProfile ?? '',
      adapterType: selected.adapterType ?? 'mock',
      adapterConfig: selected.adapterConfig ?? {},
      runtimeId: selected.runtimeId ?? '',
      bossId: selected.bossId ?? '',
      departmentId: selected.departmentId ?? '',
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
        body: JSON.stringify({ companyId: companyId || undefined, departmentId: departmentId || null, runtimeId: runtimeId || null, name: name.trim(), slug: slug.trim(), role: role.trim() || 'member', title: '', adapterType, hermesProfile: profile, bossId: bossId || null }),
      });
      setAgents([...agents, agent]);
      setName('');
      setSlug('');
      setBossId('');
      setDepartmentId('');
      setRuntimeId('');
      setRole('member');
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
        role: String(agentDraft.role ?? selected.role).trim() || 'member',
        title: String(agentDraft.title ?? ''),
        adapterType: String(agentDraft.adapterType ?? selected.adapterType ?? 'mock'),
        adapterConfig: agentDraft.adapterConfig ?? {},
        runtimeId: agentDraft.runtimeId || null,
        hermesProfile: agentDraft.hermesProfile ? String(agentDraft.hermesProfile) : undefined,
        bossId: agentDraft.bossId || null,
        departmentId: agentDraft.departmentId || null,
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
  const visibleAgents = companyId ? agents.filter((agent) => agent.companyId === companyId) : [];
  const roots = visibleAgents.filter((agent) => !agent.bossId);
  const companyCards = companyId ? cards.filter((card) => card.companyId === companyId) : [];
  const middleAgents = visibleAgents.filter((agent) => visibleAgents.some((item) => item.bossId === agent.id) && Boolean(agent.bossId));
  const leafAgents = visibleAgents.filter((agent) => !visibleAgents.some((item) => item.bossId === agent.id));
  const reviewCards = companyCards.filter((card) => card.columnStatus === 'in_review');
  const openCards = companyCards.filter((card) => !['done', 'blocked', 'cancelled'].includes(card.columnStatus ?? 'todo'));
  const selectedManager = selected?.bossId ? visibleAgents.find((agent) => agent.id === selected.bossId) : null;
  const selectedReports = selected ? visibleAgents.filter((agent) => agent.bossId === selected.id) : [];
  const selectedAssignedCards = selected ? companyCards.filter((card) => card.assigneeId === selected.id) : [];
  const selectedReviewCards = selected ? companyCards.filter((card) => card.reviewerId === selected.id || selectedReports.some((report) => report.id === card.assigneeId && card.columnStatus === 'in_review')) : [];
  const selectedAdapterType = String(agentDraft?.adapterType ?? selected?.adapterType ?? 'mock');
  const selectedRuntimeId = String(agentDraft?.runtimeId ?? selected?.runtimeId ?? '');
  const selectedRuntime = selectedRuntimeId ? runtimes.find((runtime) => runtime.id === selectedRuntimeId) : undefined;
  const inheritedAdapterConfig = (selectedRuntime?.config as Record<string, unknown> | undefined) ?? {};
  const overrideAdapterConfig = (agentDraft?.adapterConfig as Record<string, unknown> | undefined) ?? {};
  const configuredOverrideAdapterConfig = Object.fromEntries(Object.entries(overrideAdapterConfig).filter(([, value]) => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')));
  const effectiveAdapterConfig = { ...inheritedAdapterConfig, ...configuredOverrideAdapterConfig };
  const selectedAdapterFields = visibleAdapterFields(selectedAdapterType, inheritedAdapterConfig, overrideAdapterConfig);

  return <>
    <div className="page-head">
      <div><h1>{isCompanySurface ? 'Companies' : 'Agents'}</h1><p>{isCompanySurface ? 'Company registry, departments, reporting structure, and delegation closure.' : 'Agent members, reporting lines, runtime configuration, and direct reports.'}</p></div>
      {isCompanySurface && <button className="btn" onClick={startNewCompany}><Plus size={14} /> New Company</button>}
    </div>

    {isCompanySurface && <section className="card section-card" style={{ marginBottom: 16 }}>
      <div className="panel-title"><h2>Company Registry</h2><span className="status-pill">{companies.length} companies</span></div>
      <div className="table-list">
        {companies.map((company) => <button className="list-row" key={company.id} style={{ textAlign: 'left', cursor: 'pointer', borderColor: company.id === companyId ? 'var(--primary)' : 'var(--border)' }} onClick={() => selectCompany(company)}>
          <b>{company.name}</b><p>{company.slug} / {company.autoDispatchEnabled === false ? 'dispatch off' : `dispatch ${company.dispatchIntervalSeconds ?? 10}s`}</p>
        </button>)}
      </div>
    </section>}

    <section className="card" style={{ padding: 16, display: 'grid', gap: 12, marginBottom: 16 }}>
      <div className="panel-title">
        <div><h2>{isCompanySurface ? 'Company Settings' : 'Company Context'}</h2><span className="status-pill">{companyId ? `auto-dispatch every ${companyInterval}s` : 'new company'}</span></div>
        {isCompanySurface && <button className="btn btn-primary" onClick={saveCompany}>Save Company</button>}
      </div>
      <div className="form-grid">
        <label className="field-label">Company
          <select className="input" value={companyId} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            if (next) selectCompany(next);
            else startNewCompany();
          }}>
            <option value="">New company</option>
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
      {isCompanySurface && <button className="btn" onClick={createDepartment}><Plus size={14} /> Add Department</button>}
      {isCompanySurface && <div className="table-list">{companyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>}
    </section>

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

    <div className="card agent-create-grid">
      <input className="input" placeholder="Agent Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input" placeholder="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input className="input" placeholder="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
      <input className="input" placeholder="Identity label" value={role} onChange={(e) => setRole(e.target.value)} />
      <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">Department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select>
      <select className="input" value={bossId} onChange={(e) => setBossId(e.target.value)}><option value="">Reports to</option>{visibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
      <select className="input" value={adapterType} onChange={(e) => setAdapterType(e.target.value)}>
        <option value="mock">Mock</option>
        <option value="hermes">Hermes Portainer</option>
        <option value="hermes-ssh">Hermes SSH</option>
        <option value="hermes-gateway">Hermes HTTP API</option>
        <option value="webhook">Webhook</option>
        <option value="openclaw">OpenClaw</option>
      </select>
      <select className="input" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}><option value="">Runtime required for external adapters</option>{runtimes.filter((runtime) => runtime.adapterType === adapterType && (!companyId || runtime.companyId === companyId)).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select>
      <button className="btn btn-primary" onClick={create} disabled={creating}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} New</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'grid', gap: 14 }}>
          {companyDepartments.map((department) => <section key={department.id} className="card org-chart-lane">
            <div className="panel-title"><h3>{department.name}</h3><span className="status-pill">{visibleAgents.filter((agent) => agent.departmentId === department.id).length} members</span></div>
            <div className="org-chart-scroll" aria-label={`${department.name} organization chart`}>
              <AnimatePresence>
                {(roots.filter((agent) => agent.departmentId === department.id).length ? roots.filter((agent) => agent.departmentId === department.id) : visibleAgents.filter((agent) => agent.departmentId === department.id)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} selectedId={selected?.id} onSelect={setSelected} />)}
              </AnimatePresence>
            </div>
          </section>)}
        </div>
        <section className="card org-chart-lane">
          <div className="panel-title"><h3>Unassigned department</h3><span className="status-pill">{visibleAgents.filter((agent) => !agent.departmentId).length} members</span></div>
          <div className="org-chart-scroll" aria-label="Unassigned department organization chart">
          <AnimatePresence>
            {(roots.filter((agent) => !agent.departmentId).length ? roots.filter((agent) => !agent.departmentId) : visibleAgents.filter((agent) => !agent.departmentId)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} selectedId={selected?.id} onSelect={setSelected} />)}
          </AnimatePresence>
          </div>
        </section>
        {selected && (
          <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{selected.name}</h2><span className="status-pill">{selected.isBusy ? 'busy' : selected.isActive ? 'idle' : 'offline'}</span></div>
              <button className="btn" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="meta-grid">
              <span>Identity <b>{selected.role}</b></span>
              <span>Reports to <b>{selectedManager?.name ?? 'top-level'}</b></span>
              <span>Direct reports <b>{selectedReports.length}</b></span>
              <span>Adapter <b>{selected.adapterType ?? 'hermes'}</b></span>
              <span>Profile <b>{selected.hermesProfile ?? 'none'}</b></span>
              <span>Session <b>{selected.currentSessionId ?? 'none'}</b></span>
              <span>Budget <b>${selected.spentThisMonth ?? '0'} / ${selected.budgetMonthly ?? 'none'}</b></span>
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
              <label className="field-label">Identity label<input className="input" value={String(agentDraft?.role ?? 'member')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), role: e.target.value })} /></label>
              <label className="field-label">Title<input className="input" value={String(agentDraft?.title ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), title: e.target.value })} /></label>
              <label className="field-label">Profile<input className="input" value={String(agentDraft?.hermesProfile ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), hermesProfile: e.target.value })} /></label>
              <label className="field-label">Adapter<select className="input" value={String(agentDraft?.adapterType ?? 'mock')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), adapterType: e.target.value })}>
                <option value="mock">Mock</option>
                <option value="hermes">Hermes Portainer</option>
                <option value="hermes-ssh">Hermes SSH</option>
                <option value="hermes-gateway">Hermes HTTP API</option>
                <option value="webhook">Webhook</option>
                <option value="openclaw">OpenClaw</option>
              </select></label>
               <label className="field-label">Runtime preset<select className="input" value={String(agentDraft?.runtimeId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), runtimeId: e.target.value || null })}><option value="">No runtime (mock/dev only)</option>{runtimes.filter((runtime) => runtime.adapterType === String(agentDraft?.adapterType ?? selected.adapterType ?? 'mock') && runtime.companyId === selected.companyId).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
              <label className="field-label">Department<select className="input" value={String(agentDraft?.departmentId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), departmentId: e.target.value || null })}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="field-label">Reports to<select className="input" value={String(agentDraft?.bossId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), bossId: e.target.value || null })}><option value="">Top-level member</option>{visibleAgents.filter((agent) => agent.id !== selected.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
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
                <div className="table-list">{selectedReports.length ? selectedReports.map((agent) => <button className="list-row" key={agent.id} style={{ textAlign: 'left' }} onClick={() => setSelected(agent)}><b>{agent.name}</b><p>{agent.role} / {agent.isActive === false ? 'offline' : agent.isBusy ? 'busy' : 'idle'}</p></button>) : <p style={{ color: 'var(--muted)' }}>No direct reports.</p>}</div>
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
              <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/reset-session`, 'Session reset')}><RotateCcw size={14} /> Reset Session</button>
              <button className="btn" onClick={() => deleteAgent(selected.id, selected.name)} style={{ color: '#dc2626' }}><Trash2 size={14} /> Fire</button>
            </div>
          </motion.section>
        )}
      </div>
    )}

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}

function AgentNode({ agent, agents, selectedId, onSelect }: { agent: Agent; agents: Agent[]; selectedId?: string; onSelect: (agent: Agent) => void }) {
  const children = agents.filter((item) => item.bossId === agent.id);
  return <motion.div className={`org-tree-node${children.length ? ' has-children' : ''}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
    <button className="agent-node-card org-agent-node" onClick={() => onSelect(agent)} style={{ borderColor: selectedId === agent.id ? 'var(--primary)' : 'var(--border)' }}>
      <div className="org-agent-head">
        <span className={`org-agent-dot ${agent.isBusy ? 'busy' : agent.isActive ? 'active' : 'offline'}`} />
        <b>{agent.name}</b>
        {!agent.isActive && <Ban size={14} style={{ marginLeft: 'auto', color: 'var(--danger)' }} />}
      </div>
      <div className="org-agent-meta">
        <span>{agent.role} / {agent.adapterType ?? 'hermes'}</span>
        <span>{agent.hermesProfile ?? 'no-profile'}</span>
      </div>
    </button>
    {children.length > 0 && <div className="agent-children org-children">
      {children.map((child) => <AgentNode key={child.id} agent={child} agents={agents} selectedId={selectedId} onSelect={onSelect} />)}
    </div>}
  </motion.div>;
}
