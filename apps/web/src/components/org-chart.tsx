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
type Runtime = { id: string; name: string; adapterType: string; config?: Record<string, unknown>; isActive?: boolean };

function adapterFields(adapterType?: string): Array<[string, string]> {
  if (adapterType === 'hermes') return [['portainerUrl', 'Portainer URL'], ['portainerUser', 'Portainer user'], ['portainerPass', 'Portainer password'], ['portainerEndpointId', 'Endpoint ID'], ['hermesContainer', 'Hermes container'], ['publicApiUrl', 'MegaCorps public API URL']];
  if (adapterType === 'hermes-gateway') return [['hermesGatewayUrl', 'Hermes HTTP API URL'], ['hermesDashboardToken', 'Hermes token'], ['publicApiUrl', 'MegaCorps public API URL']];
  if (adapterType === 'webhook') return [['webhookUrl', 'Webhook URL']];
  if (adapterType === 'openclaw') return [['openclawUrl', 'OpenClaw URL']];
  return [];
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 8, background: type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontSize: 14, zIndex: 200 }}>
    {message}
  </motion.div>;
}

export function OrgChart() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
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
  const [role, setRole] = useState('worker');
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
      const [rows, companyRows, departmentRows, runtimeRows] = await Promise.all([api<Agent[]>('/api/agents'), api<Company[]>('/api/companies'), api<Department[]>('/api/departments'), api<Runtime[]>('/api/agent-runtimes')]);
      setAgents(rows);
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setRuntimes(runtimeRows);
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
        body: JSON.stringify({ companyId: companyId || undefined, departmentId: departmentId || null, runtimeId: runtimeId || null, name: name.trim(), slug: slug.trim(), role, title: role === 'ceo' ? 'CEO Agent' : 'Hermes Agent', adapterType, hermesProfile: profile, bossId: bossId || null }),
      });
      setAgents([...agents, agent]);
      setName('');
      setSlug('');
      setBossId('');
      setDepartmentId('');
      setRuntimeId('');
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
        role: String(agentDraft.role ?? selected.role),
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

  const companyDepartments = departments.filter((department) => !companyId || department.companyId === companyId);
  const visibleAgents = agents.filter((agent) => !companyId || agent.companyId === companyId);
  const roots = visibleAgents.filter((agent) => !agent.bossId);

  return <>
    <section className="card" style={{ padding: 16, display: 'grid', gap: 12, marginBottom: 16 }}>
      <div className="panel-title">
        <div><h2>Company Setup</h2><span className="status-pill">auto-dispatch every {companyInterval}s</span></div>
        <button className="btn btn-primary" onClick={saveCompany}>Save Company</button>
      </div>
      <div className="form-grid">
        <label className="field-label">Company
          <select className="input" value={companyId} onChange={(event) => {
            const next = companies.find((company) => company.id === event.target.value);
            setCompanyId(event.target.value);
            setCompanyName(next?.name ?? '');
            setCompanyMission(next?.mission ?? '');
            setCompanyInterval(next?.dispatchIntervalSeconds ?? 10);
            setCompanyAutoDispatch(next?.autoDispatchEnabled !== false);
          }}>
            {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="field-label">Company name<input className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
        <label className="field-label">Dispatch interval seconds<input className="input" type="number" min={5} max={3600} value={companyInterval} onChange={(event) => setCompanyInterval(Number(event.target.value))} /></label>
        <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={companyAutoDispatch} onChange={(event) => setCompanyAutoDispatch(event.target.checked)} /> Auto-dispatch backlog/todo</label>
      </div>
      <label className="field-label">Mission<textarea className="input" rows={3} value={companyMission} onChange={(event) => setCompanyMission(event.target.value)} /></label>
      <div className="form-grid">
        <label className="field-label">New department<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} /></label>
        <label className="field-label">Department slug<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(event.target.value)} /></label>
      </div>
      <button className="btn" onClick={createDepartment}><Plus size={14} /> Add Department</button>
    </section>

    <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(8, minmax(110px, 1fr)) auto', gap: 8, marginBottom: 16, alignItems: 'center', overflowX: 'auto' }}>
      <input className="input" placeholder="Agent Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input" placeholder="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input className="input" placeholder="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="worker">Worker</option><option value="reviewer">Reviewer</option><option value="ceo">CEO</option></select>
      <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">Department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select>
      <select className="input" value={bossId} onChange={(e) => setBossId(e.target.value)}><option value="">Boss</option>{visibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
      <select className="input" value={adapterType} onChange={(e) => setAdapterType(e.target.value)}>
        <option value="mock">Mock</option>
        <option value="hermes">Hermes Portainer</option>
        <option value="hermes-gateway">Hermes HTTP API</option>
        <option value="webhook">Webhook</option>
        <option value="openclaw">OpenClaw</option>
      </select>
      <select className="input" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}><option value="">Runtime</option>{runtimes.filter((runtime) => runtime.adapterType === adapterType).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select>
      <button className="btn btn-primary" onClick={create} disabled={creating}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} New</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'grid', gap: 14 }}>
          {companyDepartments.map((department) => <section key={department.id} className="card" style={{ padding: 14 }}>
            <h3 style={{ margin: '0 0 12px' }}>{department.name}</h3>
            <div style={{ display: 'flex', gap: 18, alignItems: 'start', flexWrap: 'wrap' }}>
              <AnimatePresence>
                {(roots.filter((agent) => agent.departmentId === department.id).length ? roots.filter((agent) => agent.departmentId === department.id) : visibleAgents.filter((agent) => agent.departmentId === department.id)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} selectedId={selected?.id} onSelect={setSelected} />)}
              </AnimatePresence>
            </div>
          </section>)}
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'start', flexWrap: 'wrap' }}>
          <AnimatePresence>
            {(roots.filter((agent) => !agent.departmentId).length ? roots.filter((agent) => !agent.departmentId) : visibleAgents.filter((agent) => !agent.departmentId)).map((agent) => <AgentNode key={agent.id} agent={agent} agents={visibleAgents} selectedId={selected?.id} onSelect={setSelected} />)}
          </AnimatePresence>
        </div>
        {selected && (
          <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{selected.name}</h2><span className="status-pill">{selected.isBusy ? 'busy' : selected.isActive ? 'idle' : 'offline'}</span></div>
              <button className="btn" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="meta-grid">
              <span>Role <b>{selected.role}</b></span>
              <span>Adapter <b>{selected.adapterType ?? 'hermes'}</b></span>
              <span>Profile <b>{selected.hermesProfile ?? 'none'}</b></span>
              <span>Session <b>{selected.currentSessionId ?? 'none'}</b></span>
              <span>Budget <b>${selected.spentThisMonth ?? '0'} / ${selected.budgetMonthly ?? 'none'}</b></span>
            </div>
            <div className="form-grid">
              <label className="field-label">Name<input className="input" value={String(agentDraft?.name ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), name: e.target.value })} /></label>
              <label className="field-label">Slug<input className="input" value={String(agentDraft?.slug ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), slug: e.target.value })} /></label>
              <label className="field-label">Role<select className="input" value={String(agentDraft?.role ?? 'worker')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), role: e.target.value })}><option value="worker">Worker</option><option value="reviewer">Reviewer</option><option value="ceo">CEO</option></select></label>
              <label className="field-label">Title<input className="input" value={String(agentDraft?.title ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), title: e.target.value })} /></label>
              <label className="field-label">Profile<input className="input" value={String(agentDraft?.hermesProfile ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), hermesProfile: e.target.value })} /></label>
              <label className="field-label">Adapter<select className="input" value={String(agentDraft?.adapterType ?? 'mock')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), adapterType: e.target.value })}>
                <option value="mock">Mock</option>
                <option value="hermes">Hermes Portainer</option>
                <option value="hermes-gateway">Hermes HTTP API</option>
                <option value="webhook">Webhook</option>
                <option value="openclaw">OpenClaw</option>
              </select></label>
              <label className="field-label">Runtime preset<select className="input" value={String(agentDraft?.runtimeId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), runtimeId: e.target.value || null })}><option value="">Use env / agent override</option>{runtimes.filter((runtime) => runtime.adapterType === String(agentDraft?.adapterType ?? selected.adapterType ?? 'mock')).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
              <label className="field-label">Department<select className="input" value={String(agentDraft?.departmentId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), departmentId: e.target.value || null })}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
              <label className="field-label">Boss<select className="input" value={String(agentDraft?.bossId ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), bossId: e.target.value || null })}><option value="">No boss</option>{visibleAgents.filter((agent) => agent.id !== selected.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
              <label className="field-label">Monthly budget<input className="input" type="number" min={0} step="0.01" value={String(agentDraft?.budgetMonthly ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), budgetMonthly: e.target.value })} /></label>
              {adapterFields(String(agentDraft?.adapterType ?? selected.adapterType ?? 'mock')).map(([key, label]) => <label className="field-label" key={key}>Override {label}<input className="input" type={key.toLowerCase().includes('pass') || key.toLowerCase().includes('token') ? 'password' : 'text'} value={String((agentDraft?.adapterConfig as Record<string, unknown> | undefined)?.[key] ?? '')} onChange={(e) => setAgentDraft({ ...(agentDraft ?? {}), adapterConfig: { ...((agentDraft?.adapterConfig as Record<string, unknown> | undefined) ?? {}), [key]: e.target.value } })} /></label>)}
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
  return <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} style={{ display: 'grid', gap: 10 }}>
    <button className="card" onClick={() => onSelect(agent)} style={{ padding: 14, minWidth: 250, textAlign: 'left', borderColor: selectedId === agent.id ? 'var(--primary)' : 'var(--border)', cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: agent.isBusy ? '#16a34a' : agent.isActive ? '#3b82f6' : '#94a3b8' }} />
        <b>{agent.name}</b>
        {!agent.isActive && <Ban size={14} style={{ marginLeft: 'auto', color: '#dc2626' }} />}
      </div>
      <div style={{ fontSize: 13, opacity: 0.72, display: 'grid', gap: 4 }}>
        <span>{agent.role} / {agent.adapterType ?? 'hermes'}</span>
        <span>{agent.hermesProfile ?? 'no-profile'}</span>
      </div>
    </button>
    {children.length > 0 && <div style={{ marginLeft: 28, paddingLeft: 16, borderLeft: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {children.map((child) => <AgentNode key={child.id} agent={child} agents={agents} selectedId={selectedId} onSelect={onSelect} />)}
    </div>}
  </motion.div>;
}
