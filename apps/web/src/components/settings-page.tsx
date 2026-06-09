'use client';
import { useEffect, useMemo, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Runtime = { id: string; companyId?: string | null; name: string; adapterType: string; localWorkspaceRoot?: string | null; localScratchRoot?: string | null; config: Record<string, unknown>; isActive?: boolean };
type RuntimeHealth = { runtimeId: string; name: string; adapterType: string; status: string; isActive: boolean; agents: number; activeAgents: number; busyAgents: number; lastRunAt?: string | null; lastRunStatus?: string | null; lastError?: string | null; capabilities?: string[] };
type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };
type Department = { id: string; companyId: string; name: string; slug: string };
type Membership = { id: string; companyId: string; userId: string; role: string; status: string; userEmail?: string; userName?: string };

const adapterTypes = ['mock', 'hermes', 'hermes-ssh', 'hermes-gateway', 'codex-app', 'webhook', 'openclaw'];

type ConfigField = { key: string; label: string; description?: string; type?: 'text' | 'number' | 'password' };

const megacorpsApiDescription = 'MegaCorps API base URL that agents use for task-complete callbacks.';

function configFields(adapterType: string): ConfigField[] {
  if (adapterType === 'hermes') return [
    { key: 'portainerUrl', label: 'Portainer URL' },
    { key: 'portainerUser', label: 'Portainer user' },
    { key: 'portainerPass', label: 'Portainer password', type: 'password' },
    { key: 'portainerEndpointId', label: 'Endpoint ID' },
    { key: 'hermesContainer', label: 'Hermes container' },
    { key: 'megacorpsApiUrl', label: 'MegaCorps callback URL', description: megacorpsApiDescription },
  ];
  if (adapterType === 'hermes-gateway') return [
    { key: 'hermesGatewayUrl', label: 'Hermes HTTP API URL' },
    { key: 'hermesDashboardToken', label: 'Hermes dashboard token', type: 'password' },
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
  if (adapterType === 'codex-app') return [
    { key: 'codexTransport', label: 'Codex transport', description: 'stdio or websocket. Prefer stdio for local/container runtimes; use websocket only with bearer token auth.' },
    { key: 'codexCommand', label: 'Codex command', description: 'Defaults to codex.' },
    { key: 'codexArgs', label: 'Codex app-server args', description: 'Defaults to app-server.' },
    { key: 'codexAppServerUrl', label: 'Codex app-server WS URL', description: 'Required for websocket transport, for example ws://runner.example:4500.' },
    { key: 'codexWsToken', label: 'Codex WS bearer token', type: 'password' },
    { key: 'codexModel', label: 'Codex model' },
    { key: 'codexCwd', label: 'Codex cwd override', description: 'Optional. Defaults to runtime local workspace/scratch root.' },
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

function visibleConfigFields(adapterType: string, config: Record<string, unknown>): ConfigField[] {
  const fields = configFields(adapterType);
  const known = new Set(fields.map((field) => field.key));
  if (known.has('megacorpsApiUrl')) {
    known.add('publicApiUrl');
    known.add('callbackUrl');
    known.add('webhookBaseUrl');
  }
  const extraFields = Object.keys(config).filter((key) => !known.has(key)).map(fieldForStoredKey);
  return [...fields, ...extraFields];
}

function configValue(config: Record<string, unknown>, key: string): unknown {
  if (key === 'megacorpsApiUrl') return config.megacorpsApiUrl ?? config.callbackUrl ?? config.webhookBaseUrl ?? config.publicApiUrl;
  return config[key];
}

function formatConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

export function SettingsPage() {
  const [tab, setTab] = useState<'runtimes' | 'company' | 'members' | 'advanced'>('runtimes');
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [runtimeId, setRuntimeId] = useState('');
  const [runtimeCompanyId, setRuntimeCompanyId] = useState('');
  const [runtimeName, setRuntimeName] = useState('Local Mock Runtime');
  const [runtimeAdapter, setRuntimeAdapter] = useState('mock');
  const [runtimeLocalWorkspaceRoot, setRuntimeLocalWorkspaceRoot] = useState('');
  const [runtimeLocalScratchRoot, setRuntimeLocalScratchRoot] = useState('');
  const [runtimeActive, setRuntimeActive] = useState(true);
  const [runtimeConfig, setRuntimeConfig] = useState<Record<string, unknown>>({});
  const [runtimeConfigJson, setRuntimeConfigJson] = useState(formatConfig({}));
  const [runtimeConfigJsonError, setRuntimeConfigJsonError] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyMission, setCompanyMission] = useState('');
  const [companyInterval, setCompanyInterval] = useState(10);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('viewer');
  const [toast, setToast] = useState('');

  async function refresh() {
    const [nextRuntimes, nextHealth, nextCompanies, nextDepartments, nextMemberships] = await Promise.all([
      api<Runtime[]>('/api/agent-runtimes'),
      api<RuntimeHealth[]>('/api/agent-runtimes/health'),
      api<Company[]>('/api/companies'),
      api<Department[]>('/api/departments'),
      api<Membership[]>('/api/company-memberships'),
    ]);
    setRuntimes(nextRuntimes);
    setRuntimeHealth(nextHealth);
    setCompanies(nextCompanies);
    setDepartments(nextDepartments);
    setMemberships(nextMemberships);
    const company = nextCompanies.find((item) => item.id === companyId) ?? nextCompanies[0];
    if (company) selectCompany(company);
    if (!runtimeCompanyId && nextCompanies[0]) setRuntimeCompanyId(nextCompanies[0].id);
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setDeptSlug(deptName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }, [deptName]);

  const selectedCompanyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [companyId, departments]);
  const selectedCompanyMembers = useMemo(() => memberships.filter((membership) => membership.companyId === companyId && membership.status !== 'disabled'), [companyId, memberships]);

  function setRuntimeConfigState(config: Record<string, unknown>) {
    setRuntimeConfig(config);
    setRuntimeConfigJson(formatConfig(config));
    setRuntimeConfigJsonError('');
  }

  function updateRuntimeConfigField(field: ConfigField, rawValue: string) {
    const next = { ...runtimeConfig };
    if (rawValue.trim() === '') {
      delete next[field.key];
      if (field.key === 'megacorpsApiUrl') {
        delete next.publicApiUrl;
        delete next.callbackUrl;
        delete next.webhookBaseUrl;
      }
      setRuntimeConfigState(next);
      return;
    }
    if (field.key === 'megacorpsApiUrl') {
      delete next.publicApiUrl;
      delete next.callbackUrl;
      delete next.webhookBaseUrl;
    }
    next[field.key] = field.type === 'number' ? Number(rawValue) : rawValue;
    setRuntimeConfigState(next);
  }

  function updateRuntimeConfigJson(value: string) {
    setRuntimeConfigJson(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Runtime config must be a JSON object.');
      setRuntimeConfig(parsed as Record<string, unknown>);
      setRuntimeConfigJsonError('');
    } catch (error) {
      setRuntimeConfigJsonError(error instanceof Error ? error.message : 'Invalid JSON');
    }
  }

  function selectRuntime(runtime: Runtime) {
    setRuntimeId(runtime.id);
    setRuntimeCompanyId(runtime.companyId ?? companies[0]?.id ?? '');
    setRuntimeName(runtime.name);
    setRuntimeAdapter(runtime.adapterType);
    setRuntimeLocalWorkspaceRoot(runtime.localWorkspaceRoot ?? '');
    setRuntimeLocalScratchRoot(runtime.localScratchRoot ?? '');
    setRuntimeActive(runtime.isActive !== false);
    setRuntimeConfigState(runtime.config ?? {});
  }

  function selectCompany(company: Company) {
    setCompanyId(company.id);
    setCompanyName(company.name);
    setCompanyMission(company.mission ?? '');
    setCompanyInterval(company.dispatchIntervalSeconds ?? 10);
    setAutoDispatch(company.autoDispatchEnabled !== false);
  }

  async function saveRuntime() {
    if (runtimeConfigJsonError) {
      setToast(`Runtime config JSON error: ${runtimeConfigJsonError}`);
      return;
    }
    const payload = {
      companyId: runtimeCompanyId || companyId || companies[0]?.id,
      name: runtimeName,
      adapterType: runtimeAdapter,
      localWorkspaceRoot: runtimeLocalWorkspaceRoot.trim() || null,
      localScratchRoot: runtimeLocalScratchRoot.trim() || null,
      isActive: runtimeActive,
      config: runtimeConfig,
    };
    const saved = runtimeId ? await api<Runtime>(`/api/agent-runtimes/${runtimeId}`, { method: 'PUT', body: JSON.stringify(payload) }) : await api<Runtime>('/api/agent-runtimes', { method: 'POST', body: JSON.stringify(payload) });
    setRuntimeId(saved.id);
    setToast('Runtime saved');
    await refresh();
  }

  async function deleteRuntime(runtime: Runtime) {
    if (!window.confirm(`Delete runtime "${runtime.name}"? Agents using it will fall back to their own config/env.`)) return;
    await api(`/api/agent-runtimes/${runtime.id}`, { method: 'DELETE' });
    setRuntimeId('');
    setToast('Runtime deleted');
    await refresh();
  }

  async function saveCompany() {
    const selected = companies.find((company) => company.id === companyId);
    const payload = { name: companyName, slug: selected?.slug ?? companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), mission: companyMission, dispatchIntervalSeconds: companyInterval, autoDispatchEnabled: autoDispatch };
    const saved = selected ? await api<Company>(`/api/companies/${selected.id}`, { method: 'PUT', body: JSON.stringify(payload) }) : await api<Company>('/api/companies', { method: 'POST', body: JSON.stringify(payload) });
    selectCompany(saved);
    setToast('Company saved');
    await refresh();
  }

  async function addDepartment() {
    if (!companyId || !deptName || !deptSlug) return;
    await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName, slug: deptSlug }) });
    setDeptName('');
    setDeptSlug('');
    setToast('Department added');
    await refresh();
  }

  async function addMember() {
    if (!companyId || !memberEmail.trim()) return;
    await api<Membership>('/api/company-memberships', { method: 'POST', body: JSON.stringify({ companyId, email: memberEmail.trim(), role: memberRole, status: 'active' }) });
    setMemberEmail('');
    setMemberRole('viewer');
    setToast('Member saved');
    await refresh();
  }

  async function updateMember(membership: Membership, role: string) {
    await api<Membership>(`/api/company-memberships/${membership.id}`, { method: 'PUT', body: JSON.stringify({ role, status: membership.status }) });
    setToast('Member role updated');
    await refresh();
  }

  async function disableMember(membership: Membership) {
    await api(`/api/company-memberships/${membership.id}`, { method: 'DELETE' });
    setToast('Member disabled');
    await refresh();
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>Settings</h1><p>Configure companies, departments, agent runtimes, and adapter endpoints.</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    <div className="tab-row page-tabs">
      {(['runtimes', 'company', 'members', 'advanced'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => setTab(next)}>{next}</button>)}
    </div>
    {tab === 'runtimes' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Agent runtimes</h2><button className="btn" onClick={() => { setRuntimeId(''); setRuntimeCompanyId(companyId || companies[0]?.id || ''); setRuntimeName(''); setRuntimeAdapter('mock'); setRuntimeLocalWorkspaceRoot(''); setRuntimeLocalScratchRoot(''); setRuntimeConfigState({}); }}>New</button></div>
        <div className="form-grid">
          <label className="field-label">Company<select className="input" value={runtimeCompanyId} onChange={(event) => setRuntimeCompanyId(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
          <label className="field-label">Name<input className="input" value={runtimeName} onChange={(event) => setRuntimeName(event.target.value)} /></label>
          <label className="field-label">Adapter<select className="input" value={runtimeAdapter} onChange={(event) => setRuntimeAdapter(event.target.value)}>{adapterTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label className="field-label">Local workspace root
            <span className="field-hint">Runtime-owned clone/cache root, for example /home/alice/workspaces or C:\Agents\Alice\workspaces.</span>
            <input className="input" value={runtimeLocalWorkspaceRoot} onChange={(event) => setRuntimeLocalWorkspaceRoot(event.target.value)} />
          </label>
          <label className="field-label">Local scratch root
            <span className="field-hint">Runtime-owned temporary task folder root. Final artifacts should still be reported as URLs, commits, PRs, or work products.</span>
            <input className="input" value={runtimeLocalScratchRoot} onChange={(event) => setRuntimeLocalScratchRoot(event.target.value)} />
          </label>
        </div>
        <label className="check-row"><input type="checkbox" checked={runtimeActive} onChange={(event) => setRuntimeActive(event.target.checked)} /> Runtime active</label>
        <div className="form-grid">
          {visibleConfigFields(runtimeAdapter, runtimeConfig).map((field) => <label className="field-label" key={field.key}>{field.label}
            {field.description && <span className="field-hint">{field.description}</span>}
            <input className="input" type={field.type ?? (isSensitiveConfigKey(field.key) ? 'password' : 'text')} value={String(configValue(runtimeConfig, field.key) ?? '')} onChange={(event) => updateRuntimeConfigField(field, event.target.value)} />
          </label>)}
        </div>
        <label className="field-label">Advanced runtime config JSON
          <textarea className="input config-json-editor" rows={8} spellCheck={false} value={runtimeConfigJson} onChange={(event) => updateRuntimeConfigJson(event.target.value)} />
          <span className={runtimeConfigJsonError ? 'field-hint danger' : 'field-hint'}>{runtimeConfigJsonError || 'Adapter-specific keys stored in config are preserved here, including legacy publicApiUrl.'}</span>
        </label>
        <button className="btn btn-primary" onClick={saveRuntime}><Save size={15} /> Save runtime</button>
        <div className="table-list">
          {runtimes.map((runtime) => <div className="list-row" key={runtime.id}>
            <b>{runtime.name}</b><p>{companies.find((company) => company.id === runtime.companyId)?.name ?? 'company'} / {runtime.adapterType} / {runtime.isActive === false ? 'inactive' : 'active'}</p>
            <p className="field-hint">{runtime.localWorkspaceRoot ? `Workspace: ${runtime.localWorkspaceRoot}` : 'Workspace root not configured'}{runtime.localScratchRoot ? ` / Scratch: ${runtime.localScratchRoot}` : ''}</p>
            <div className="action-row"><button className="btn" onClick={() => selectRuntime(runtime)}>Edit</button><button className="btn" style={{ color: 'var(--danger)' }} onClick={() => deleteRuntime(runtime)}><Trash2 size={14} /> Delete</button></div>
          </div>)}
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>Runtime health</h2><span className="status-pill">{runtimeHealth.length} runtimes</span></div>
        <div className="table-list">
          {runtimeHealth.map((runtime) => <div className="list-row" key={runtime.runtimeId}>
            <b>{runtime.name}</b>
            <p>{runtime.status} / {runtime.adapterType} / agents {runtime.activeAgents}/{runtime.agents} active / {runtime.busyAgents} busy</p>
            <div className="meta-grid">
              <span>Last run <b>{runtime.lastRunAt ? new Date(runtime.lastRunAt).toLocaleString() : 'none'}</b></span>
              <span>Last status <b>{runtime.lastRunStatus ?? 'none'}</b></span>
              <span>Runtime features <b>{runtime.capabilities?.join(', ') || 'none'}</b></span>
              <span>Error <b>{runtime.lastError ?? 'none'}</b></span>
            </div>
          </div>)}
          {runtimeHealth.length === 0 && <p style={{ color: 'var(--muted)' }}>No runtime presets yet.</p>}
        </div>
      </section>
    </div>}

    {tab === 'company' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Company settings</h2><button className="btn btn-primary" onClick={saveCompany}>Save company</button></div>
        <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => { const company = companies.find((item) => item.id === event.target.value); if (company) selectCompany(company); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <div className="form-grid">
          <label className="field-label">Name<input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
          <label className="field-label">Dispatch interval seconds<input className="input" type="number" min={5} max={3600} value={companyInterval} onChange={(event) => setCompanyInterval(Number(event.target.value))} /></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={autoDispatch} onChange={(event) => setAutoDispatch(event.target.checked)} /> Auto-dispatch todo tasks</label>
        <label className="field-label">Mission<textarea className="input" rows={4} value={companyMission} onChange={(event) => setCompanyMission(event.target.value)} /></label>
        <div className="form-grid">
          <label className="field-label">New department<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} /></label>
          <label className="field-label">Slug<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(event.target.value)} /></label>
        </div>
        <button className="btn" title={companyId ? 'Add department' : 'Create a company first before adding departments'} disabled={!companyId || !deptName.trim() || !deptSlug.trim()} onClick={addDepartment}>Add department</button>
        <div className="table-list">{selectedCompanyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>
      </section>
    </div>}

    {tab === 'members' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Company members</h2><span className="status-pill">{selectedCompanyMembers.length} active</span></div>
        <div className="form-grid">
          <label className="field-label">User email<input className="input" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} /></label>
          <label className="field-label">Role<select className="input" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select></label>
        </div>
        <button className="btn" onClick={addMember}>Add or update member</button>
        <div className="table-list">
          {selectedCompanyMembers.map((membership) => <div className="list-row" key={membership.id}>
            <b>{membership.userName ?? membership.userEmail ?? membership.userId}</b>
            <p>{membership.userEmail ?? membership.userId} / {membership.status}</p>
            <div className="action-row">
              <select className="input compact" value={membership.role} onChange={(event) => updateMember(membership, event.target.value)}>
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
              </select>
              <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => disableMember(membership)}>Disable</button>
            </div>
          </div>)}
          {selectedCompanyMembers.length === 0 && <p style={{ color: 'var(--muted)' }}>No active members.</p>}
        </div>
      </section>
    </div>}

    {tab === 'advanced' && <section className="card section-card">
      <div className="panel-title"><h2>Advanced</h2><span className="status-pill">future settings</span></div>
      <div className="meta-grid">
        <span>Budget <b>Moved out of primary navigation; ready to host budget controls here.</b></span>
        <span>Secrets <b>API keys and webhook secrets can be added here without crowding runtime setup.</b></span>
        <span>Company <b>{companies.length} visible companies</b></span>
        <span>Runtimes <b>{runtimes.length} configured</b></span>
      </div>
    </section>}
  </div>;
}
