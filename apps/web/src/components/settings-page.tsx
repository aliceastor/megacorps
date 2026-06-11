'use client';
import { useEffect, useMemo, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Runtime = { id: string; companyId?: string | null; name: string; adapterType: string; localWorkspaceRoot?: string | null; localScratchRoot?: string | null; config: Record<string, unknown>; isActive?: boolean };
type RuntimeHealth = { runtimeId: string; name: string; adapterType: string; status: string; isActive: boolean; agents: number; activeAgents: number; busyAgents: number; lastRunAt?: string | null; lastRunStatus?: string | null; lastError?: string | null; capabilities?: string[] };
type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };
type Department = { id: string; companyId: string; name: string; slug: string };
type Membership = { id: string; companyId: string; userId: string; role: string; status: string; userEmail?: string; userName?: string };

const adapterTypes = ['hermes-ssh', 'hermes-gateway', 'codex-app', 'webhook', 'openclaw'];

type ConfigField = { key: string; label: string; description?: string; type?: 'text' | 'number' | 'password' };

const megacorpsApiDescription = 'MegaCorps API base URL that agents use for task-complete callbacks.';

function configFields(adapterType: string): ConfigField[] {
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
  const { t } = useLocale();
  const [tab, setTab] = useState<'runtimes' | 'company' | 'members' | 'advanced'>('runtimes');
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [runtimeId, setRuntimeId] = useState('');
  const [runtimeCompanyId, setRuntimeCompanyId] = useState('');
  const [runtimeName, setRuntimeName] = useState('Hermes SSH Runtime');
  const [runtimeAdapter, setRuntimeAdapter] = useState('hermes-ssh');
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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('settings.configMustBeObject'));
      setRuntimeConfig(parsed as Record<string, unknown>);
      setRuntimeConfigJsonError('');
    } catch (error) {
      setRuntimeConfigJsonError(error instanceof Error ? error.message : t('settings.invalidJson'));
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
      setToast(`${t('settings.configJsonError')}: ${runtimeConfigJsonError}`);
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
    setToast(t('settings.runtimeSaved'));
    await refresh();
  }

  async function deleteRuntime(runtime: Runtime) {
    if (!window.confirm(`${t('settings.deleteRuntimeConfirm')} "${runtime.name}"? ${t('settings.deleteRuntimeDetail')}`)) return;
    await api(`/api/agent-runtimes/${runtime.id}`, { method: 'DELETE' });
    setRuntimeId('');
    setToast(t('settings.runtimeDeleted'));
    await refresh();
  }

  async function saveCompany() {
    const selected = companies.find((company) => company.id === companyId);
    const payload = { name: companyName, slug: selected?.slug ?? companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), mission: companyMission, dispatchIntervalSeconds: companyInterval, autoDispatchEnabled: autoDispatch };
    const saved = selected ? await api<Company>(`/api/companies/${selected.id}`, { method: 'PUT', body: JSON.stringify(payload) }) : await api<Company>('/api/companies', { method: 'POST', body: JSON.stringify(payload) });
    selectCompany(saved);
    setToast(t('companies.saved'));
    await refresh();
  }

  async function addDepartment() {
    if (!companyId || !deptName || !deptSlug) return;
    await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName, slug: deptSlug }) });
    setDeptName('');
    setDeptSlug('');
    setToast(t('departments.added'));
    await refresh();
  }

  async function addMember() {
    if (!companyId || !memberEmail.trim()) return;
    await api<Membership>('/api/company-memberships', { method: 'POST', body: JSON.stringify({ companyId, email: memberEmail.trim(), role: memberRole, status: 'active' }) });
    setMemberEmail('');
    setMemberRole('viewer');
    setToast(t('settings.memberSaved'));
    await refresh();
  }

  async function updateMember(membership: Membership, role: string) {
    await api<Membership>(`/api/company-memberships/${membership.id}`, { method: 'PUT', body: JSON.stringify({ role, status: membership.status }) });
    setToast(t('settings.memberRoleUpdated'));
    await refresh();
  }

  async function disableMember(membership: Membership) {
    await api(`/api/company-memberships/${membership.id}`, { method: 'DELETE' });
    setToast(t('settings.memberDisabled'));
    await refresh();
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>{t('title.settings')}</h1><p>{t('settings.subtitle')}</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    <div className="tab-row page-tabs">
      {(['runtimes', 'company', 'members', 'advanced'] as const).map((next) => <button key={next} className={`tab ${tab === next ? 'active' : ''}`} onClick={() => setTab(next)}>{t(`settings.tab.${next}`)}</button>)}
    </div>
    {tab === 'runtimes' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>{t('settings.agentRuntimes')}</h2><button className="btn" onClick={() => { setRuntimeId(''); setRuntimeCompanyId(companyId || companies[0]?.id || ''); setRuntimeName(''); setRuntimeAdapter('hermes-ssh'); setRuntimeLocalWorkspaceRoot(''); setRuntimeLocalScratchRoot(''); setRuntimeConfigState({}); }}>{t('common.new')}</button></div>
        <div className="form-grid">
          <label className="field-label">{t('common.company')}<select className="input" value={runtimeCompanyId} onChange={(event) => setRuntimeCompanyId(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
          <label className="field-label">{t('common.name')}<input className="input" value={runtimeName} onChange={(event) => setRuntimeName(event.target.value)} /></label>
          <label className="field-label">{t('settings.adapter')}<select className="input" value={runtimeAdapter} onChange={(event) => setRuntimeAdapter(event.target.value)}>{adapterTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <label className="field-label">{t('settings.localWorkspaceRoot')}
            <span className="field-hint">{t('settings.workspaceRootHint')}</span>
            <input className="input" value={runtimeLocalWorkspaceRoot} onChange={(event) => setRuntimeLocalWorkspaceRoot(event.target.value)} />
          </label>
          <label className="field-label">{t('settings.localScratchRoot')}
            <span className="field-hint">{t('settings.scratchRootHint')}</span>
            <input className="input" value={runtimeLocalScratchRoot} onChange={(event) => setRuntimeLocalScratchRoot(event.target.value)} />
          </label>
        </div>
        <label className="check-row"><input type="checkbox" checked={runtimeActive} onChange={(event) => setRuntimeActive(event.target.checked)} /> {t('settings.runtimeActive')}</label>
        <div className="form-grid">
          {visibleConfigFields(runtimeAdapter, runtimeConfig).map((field) => <label className="field-label" key={field.key}>{field.label}
            {field.description && <span className="field-hint">{field.description}</span>}
            <input className="input" type={field.type ?? (isSensitiveConfigKey(field.key) ? 'password' : 'text')} value={String(configValue(runtimeConfig, field.key) ?? '')} onChange={(event) => updateRuntimeConfigField(field, event.target.value)} />
          </label>)}
        </div>
        <label className="field-label">{t('settings.advancedConfigJson')}
          <textarea className="input config-json-editor" rows={8} spellCheck={false} value={runtimeConfigJson} onChange={(event) => updateRuntimeConfigJson(event.target.value)} />
          <span className={runtimeConfigJsonError ? 'field-hint danger' : 'field-hint'}>{runtimeConfigJsonError || t('settings.configJsonHint')}</span>
        </label>
        <button className="btn btn-primary" onClick={saveRuntime}><Save size={15} /> {t('settings.saveRuntime')}</button>
        <div className="table-list">
          {runtimes.map((runtime) => <div className="list-row" key={runtime.id}>
            <b>{runtime.name}</b><p>{companies.find((company) => company.id === runtime.companyId)?.name ?? 'company'} / {runtime.adapterType} / {runtime.isActive === false ? t('common.inactive') : t('common.active')}</p>
            <p className="field-hint">{runtime.localWorkspaceRoot ? `${t('common.workspace')}: ${runtime.localWorkspaceRoot}` : t('settings.workspaceNotConfigured')}{runtime.localScratchRoot ? ` / ${t('settings.scratchLabel')}: ${runtime.localScratchRoot}` : ''}</p>
            <div className="action-row"><button className="btn" onClick={() => selectRuntime(runtime)}>{t('common.edit')}</button><button className="btn" style={{ color: 'var(--danger)' }} onClick={() => deleteRuntime(runtime)}><Trash2 size={14} /> {t('common.delete')}</button></div>
          </div>)}
        </div>
      </section>

      <section className="card section-card">
        <div className="panel-title"><h2>{t('settings.runtimeHealth')}</h2><span className="status-pill">{runtimeHealth.length} {t('settings.runtimesCount')}</span></div>
        <div className="table-list">
          {runtimeHealth.map((runtime) => <div className="list-row" key={runtime.runtimeId}>
            <b>{runtime.name}</b>
            <p>{runtime.status} / {runtime.adapterType} / agents {runtime.activeAgents}/{runtime.agents} active / {runtime.busyAgents} busy</p>
            <div className="meta-grid">
              <span>{t('settings.lastRun')} <b>{runtime.lastRunAt ? new Date(runtime.lastRunAt).toLocaleString() : 'none'}</b></span>
              <span>{t('cron.lastStatus')} <b>{runtime.lastRunStatus ?? 'none'}</b></span>
              <span>{t('settings.runtimeFeatures')} <b>{runtime.capabilities?.join(', ') || 'none'}</b></span>
              <span>{t('common.errorLabel')} <b>{runtime.lastError ?? 'none'}</b></span>
            </div>
          </div>)}
          {runtimeHealth.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('settings.noRuntimes')}</p>}
        </div>
      </section>
    </div>}

    {tab === 'company' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>{t('settings.companySettings')}</h2><button className="btn btn-primary" onClick={saveCompany}>{t('companies.saveCompany')}</button></div>
        <label className="field-label">{t('common.company')}<select className="input" value={companyId} onChange={(event) => { const company = companies.find((item) => item.id === event.target.value); if (company) selectCompany(company); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <div className="form-grid">
          <label className="field-label">{t('common.name')}<input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
          <label className="field-label">{t('companies.dispatchIntervalSeconds')}<input className="input" type="number" min={5} max={3600} value={companyInterval} onChange={(event) => setCompanyInterval(Number(event.target.value))} /></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={autoDispatch} onChange={(event) => setAutoDispatch(event.target.checked)} /> {t('companies.autoDispatchTodo')}</label>
        <label className="field-label">{t('companies.mission')}<textarea className="input" rows={4} value={companyMission} onChange={(event) => setCompanyMission(event.target.value)} /></label>
        <div className="form-grid">
          <label className="field-label">{t('departments.newDepartment')}<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} /></label>
          <label className="field-label">{t('common.slug')}<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(event.target.value)} /></label>
        </div>
        <button className="btn" title={companyId ? t('departments.addDepartment') : t('departments.createCompanyFirstHint')} disabled={!companyId || !deptName.trim() || !deptSlug.trim()} onClick={addDepartment}>{t('departments.addDepartment')}</button>
        <div className="table-list">{selectedCompanyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>
      </section>
    </div>}

    {tab === 'members' && <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>{t('settings.companyMembers')}</h2><span className="status-pill">{selectedCompanyMembers.length} {t('settings.activeCount')}</span></div>
        <div className="form-grid">
          <label className="field-label">{t('settings.userEmail')}<input className="input" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} /></label>
          <label className="field-label">{t('settings.role')}<select className="input" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select></label>
        </div>
        <button className="btn" onClick={addMember}>{t('settings.addOrUpdateMember')}</button>
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
              <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => disableMember(membership)}>{t('settings.disableMember')}</button>
            </div>
          </div>)}
          {selectedCompanyMembers.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('settings.noActiveMembers')}</p>}
        </div>
      </section>
    </div>}

    {tab === 'advanced' && <section className="card section-card">
      <div className="panel-title"><h2>{t('settings.tab.advanced')}</h2><span className="status-pill">{t('settings.futureSettings')}</span></div>
      <div className="meta-grid">
        <span>{t('agents.budget')} <b>{t('settings.advancedBudgetHint')}</b></span>
        <span>{t('settings.secrets')} <b>{t('settings.advancedSecretsHint')}</b></span>
        <span>{t('common.company')} <b>{companies.length} {t('settings.visibleCompanies')}</b></span>
        <span>{t('settings.runtimes')} <b>{runtimes.length} {t('cron.configured')}</b></span>
      </div>
    </section>}
  </div>;
}
