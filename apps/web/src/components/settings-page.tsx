'use client';
import { useEffect, useMemo, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Runtime = { id: string; name: string; adapterType: string; config: Record<string, unknown>; isActive?: boolean };
type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean };
type Department = { id: string; companyId: string; name: string; slug: string };

const adapterTypes = ['mock', 'hermes', 'hermes-gateway', 'webhook', 'openclaw'];

function configFields(adapterType: string): Array<[string, string]> {
  if (adapterType === 'hermes') return [
    ['portainerUrl', 'Portainer URL'],
    ['portainerUser', 'Portainer user'],
    ['portainerPass', 'Portainer password'],
    ['portainerEndpointId', 'Endpoint ID'],
    ['hermesContainer', 'Hermes container'],
    ['publicApiUrl', 'MegaCorps public API URL'],
    ['reasoningEffort', 'Reasoning effort'],
    ['maxTurns', 'Max turns'],
  ];
  if (adapterType === 'hermes-gateway') return [
    ['hermesGatewayUrl', 'Hermes HTTP API URL'],
    ['hermesDashboardToken', 'Hermes dashboard token'],
    ['publicApiUrl', 'MegaCorps public API URL'],
  ];
  if (adapterType === 'webhook') return [['webhookUrl', 'Webhook URL']];
  if (adapterType === 'openclaw') return [['openclawUrl', 'OpenClaw URL']];
  return [['publicApiUrl', 'MegaCorps public API URL']];
}

export function SettingsPage() {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [runtimeId, setRuntimeId] = useState('');
  const [runtimeName, setRuntimeName] = useState('Local Mock Runtime');
  const [runtimeAdapter, setRuntimeAdapter] = useState('mock');
  const [runtimeActive, setRuntimeActive] = useState(true);
  const [runtimeConfig, setRuntimeConfig] = useState<Record<string, unknown>>({});
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyMission, setCompanyMission] = useState('');
  const [companyInterval, setCompanyInterval] = useState(10);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [toast, setToast] = useState('');

  async function refresh() {
    const [nextRuntimes, nextCompanies, nextDepartments] = await Promise.all([
      api<Runtime[]>('/api/agent-runtimes'),
      api<Company[]>('/api/companies'),
      api<Department[]>('/api/departments'),
    ]);
    setRuntimes(nextRuntimes);
    setCompanies(nextCompanies);
    setDepartments(nextDepartments);
    const company = nextCompanies.find((item) => item.id === companyId) ?? nextCompanies[0];
    if (company) selectCompany(company);
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setDeptSlug(deptName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }, [deptName]);

  const selectedCompanyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [companyId, departments]);

  function selectRuntime(runtime: Runtime) {
    setRuntimeId(runtime.id);
    setRuntimeName(runtime.name);
    setRuntimeAdapter(runtime.adapterType);
    setRuntimeActive(runtime.isActive !== false);
    setRuntimeConfig(runtime.config ?? {});
  }

  function selectCompany(company: Company) {
    setCompanyId(company.id);
    setCompanyName(company.name);
    setCompanyMission(company.mission ?? '');
    setCompanyInterval(company.dispatchIntervalSeconds ?? 10);
    setAutoDispatch(company.autoDispatchEnabled !== false);
  }

  async function saveRuntime() {
    const payload = { name: runtimeName, adapterType: runtimeAdapter, isActive: runtimeActive, config: runtimeConfig };
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

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div><h1>Settings</h1><p>Configure companies, departments, agent runtimes, and adapter endpoints.</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    <div className="data-grid">
      <section className="card section-card">
        <div className="panel-title"><h2>Agent runtimes</h2><button className="btn" onClick={() => { setRuntimeId(''); setRuntimeName(''); setRuntimeAdapter('mock'); setRuntimeConfig({}); }}>New</button></div>
        <div className="form-grid">
          <label className="field-label">Name<input className="input" value={runtimeName} onChange={(event) => setRuntimeName(event.target.value)} /></label>
          <label className="field-label">Adapter<select className="input" value={runtimeAdapter} onChange={(event) => setRuntimeAdapter(event.target.value)}>{adapterTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={runtimeActive} onChange={(event) => setRuntimeActive(event.target.checked)} /> Runtime active</label>
        <div className="form-grid">
          {configFields(runtimeAdapter).map(([key, label]) => <label className="field-label" key={key}>{label}
            <input className="input" type={key.toLowerCase().includes('pass') || key.toLowerCase().includes('token') ? 'password' : key === 'maxTurns' ? 'number' : 'text'} value={String(runtimeConfig[key] ?? '')} onChange={(event) => setRuntimeConfig({ ...runtimeConfig, [key]: key === 'maxTurns' ? Number(event.target.value) : event.target.value })} />
          </label>)}
        </div>
        <button className="btn btn-primary" onClick={saveRuntime}><Save size={15} /> Save runtime</button>
        <div className="table-list">
          {runtimes.map((runtime) => <div className="list-row" key={runtime.id}>
            <b>{runtime.name}</b><p>{runtime.adapterType} / {runtime.isActive === false ? 'inactive' : 'active'}</p>
            <div className="action-row"><button className="btn" onClick={() => selectRuntime(runtime)}>Edit</button><button className="btn" style={{ color: 'var(--danger)' }} onClick={() => deleteRuntime(runtime)}><Trash2 size={14} /> Delete</button></div>
          </div>)}
        </div>
      </section>

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
        <button className="btn" onClick={addDepartment}>Add department</button>
        <div className="table-list">{selectedCompanyDepartments.map((department) => <div className="list-row" key={department.id}><b>{department.name}</b><p>{department.slug}</p></div>)}</div>
      </section>
    </div>
  </div>;
}
