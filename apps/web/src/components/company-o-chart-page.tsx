'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Loader2, Network, Pause, Save, Users, Wifi } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Position = { id: string; companyId: string; name: string; slug: string };
type Runtime = { id: string; companyId?: string | null; name: string; adapterType: string; config?: Record<string, unknown>; isActive?: boolean };
type Agent = {
  id: string;
  companyId: string;
  departmentId?: string | null;
  positionId?: string | null;
  bossId?: string | null;
  name: string;
  slug: string;
  role: string;
  soul?: string | null;
  hermesProfile?: string | null;
  runtimeId?: string | null;
  adapterConfig?: Record<string, unknown>;
  budgetPerTask?: string | null;
  budgetMonthly?: string | null;
  spentThisMonth?: string | null;
  adapterType?: string | null;
  isActive?: boolean;
  isBusy?: boolean;
};

function agentStatus(agent: Agent): string {
  if (agent.isBusy) return 'busy';
  if (agent.isActive === false) return 'offline';
  return 'active';
}

function agentStatusLabel(agent: Agent): string {
  if (agent.isBusy) return 'Busy';
  if (agent.isActive === false) return 'Offline';
  return 'Idle';
}

function OChartNode({ agent, agents, departments, positions, selectedId, onSelect, lineage = new Set<string>() }: {
  agent: Agent;
  agents: Agent[];
  departments: Department[];
  positions: Position[];
  selectedId?: string;
  onSelect: (agent: Agent) => void;
  lineage?: Set<string>;
}) {
  const nextLineage = new Set(lineage).add(agent.id);
  const children = agents.filter((item) => item.bossId === agent.id && !nextLineage.has(item.id));
  const department = departments.find((item) => item.id === agent.departmentId);
  const position = positions.find((item) => item.id === agent.positionId);
  const assignment = `${position?.name ?? 'No position'}${department ? ` / ${department.name}` : ''}`;
  return <div className={`company-o-node${children.length ? ' has-children' : ''}`}>
    <button type="button" className={`company-o-card ${selectedId === agent.id ? 'active' : ''}`} onClick={() => onSelect(agent)}>
      <span className="company-o-copy">
        <span className={`org-agent-dot ${agentStatus(agent)}`} />
        <span className="company-o-copy-text">
          <b>{agent.name}</b>
          <small>{assignment}</small>
          <small>{agent.adapterType ?? 'hermes-ssh'} | {agentStatusLabel(agent)}</small>
        </span>
      </span>
    </button>
    {children.length > 0 && <div className="company-o-children">
      {children.map((child) => <OChartNode key={child.id} agent={child} agents={agents} departments={departments} positions={positions} selectedId={selectedId} onSelect={onSelect} lineage={nextLineage} />)}
    </div>}
  </div>;
}

export function CompanyOChartPage() {
  const queryClient = useQueryClient();
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/api/companies') });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/api/departments') });
  const positionsQuery = useQuery({ queryKey: ['positions'], queryFn: () => api<Position[]>('/api/positions') });
  const runtimesQuery = useQuery({ queryKey: ['agentRuntimes'], queryFn: () => api<Runtime[]>('/api/agent-runtimes') });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') });
  const [companyId, setCompanyId] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [agentDraft, setAgentDraft] = useState<Partial<Agent> | null>(null);
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const companies = companiesQuery.data ?? [];
  const departments = departmentsQuery.data ?? [];
  const positions = positionsQuery.data ?? [];
  const runtimes = runtimesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const loadError = companiesQuery.error ?? departmentsQuery.error ?? positionsQuery.error ?? runtimesQuery.error ?? agentsQuery.error;

  async function refreshQueries() {
    await Promise.all([['companies'], ['departments'], ['positions'], ['agentRuntimes'], ['agents']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  useEffect(() => {
    if (!companiesQuery.data) return;
    const rows = companiesQuery.data;
    setCompanyId((current) => rows.some((company) => company.id === current) ? current : rows[0]?.id ?? '');
  }, [companiesQuery.data]);
  useEffect(() => {
    if (loadError) setError(loadError instanceof Error ? loadError.message : 'Failed to load O-Chart');
  }, [loadError]);

  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyPositions = useMemo(() => positions.filter((position) => position.companyId === companyId), [positions, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const companyAgentIds = useMemo(() => new Set(companyAgents.map((agent) => agent.id)), [companyAgents]);
  const roots = useMemo(() => {
    const rootRows = companyAgents.filter((agent) => !agent.bossId || !companyAgentIds.has(agent.bossId));
    return rootRows.length ? rootRows : companyAgents;
  }, [companyAgents, companyAgentIds]);
  const selectedAgent = companyAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedDepartment = selectedAgent ? companyDepartments.find((department) => department.id === selectedAgent.departmentId) : null;
  const selectedPosition = selectedAgent ? companyPositions.find((position) => position.id === selectedAgent.positionId) : null;
  const directReports = selectedAgent ? companyAgents.filter((agent) => agent.bossId === selectedAgent.id) : [];
  const selectedAdapterType = String(agentDraft?.adapterType ?? selectedAgent?.adapterType ?? 'hermes-ssh');

  useEffect(() => {
    if (!selectedAgent) {
      setAgentDraft(null);
      return;
    }
    setAgentDraft({
      name: selectedAgent.name,
      slug: selectedAgent.slug,
      departmentId: selectedAgent.departmentId ?? '',
      positionId: selectedAgent.positionId ?? '',
      bossId: selectedAgent.bossId ?? '',
      adapterType: selectedAgent.adapterType ?? 'hermes-ssh',
      runtimeId: selectedAgent.runtimeId ?? '',
      hermesProfile: selectedAgent.hermesProfile ?? '',
      budgetPerTask: selectedAgent.budgetPerTask ?? '',
      budgetMonthly: selectedAgent.budgetMonthly ?? '',
    });
  }, [selectedAgent?.id]);

  async function saveSelectedAgent() {
    if (!selectedAgent || !agentDraft) return;
    setSavingAgentId(selectedAgent.id);
    setError('');
    setNotice('');
    try {
      const payload = {
        name: String(agentDraft.name ?? selectedAgent.name),
        slug: String(agentDraft.slug ?? selectedAgent.slug),
        role: selectedAgent.role || 'worker',
        soul: selectedAgent.soul ?? null,
        capabilities: [],
        adapterType: String(agentDraft.adapterType ?? selectedAgent.adapterType ?? 'hermes-ssh'),
        adapterConfig: selectedAgent.adapterConfig ?? {},
        runtimeId: agentDraft.runtimeId || null,
        hermesProfile: agentDraft.hermesProfile ? String(agentDraft.hermesProfile) : undefined,
        bossId: agentDraft.bossId || null,
        departmentId: agentDraft.departmentId || null,
        positionId: agentDraft.positionId || null,
        budgetPerTask: agentDraft.budgetPerTask ? Number(agentDraft.budgetPerTask) : undefined,
        budgetMonthly: agentDraft.budgetMonthly ? Number(agentDraft.budgetMonthly) : undefined,
      };
      const updated = await api<Agent>(`/api/agents/${selectedAgent.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((agent) => agent.id === updated.id ? updated : agent));
      setSelectedAgentId(updated.id);
      setNotice('Agent saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSavingAgentId(null);
    }
  }

  async function agentAction(path: string, message: string) {
    if (!selectedAgent) return;
    setSavingAgentId(selectedAgent.id);
    setError('');
    setNotice('');
    try {
      const result = await api<Agent | { ok: true }>(path, { method: 'POST' });
      if ('id' in result) queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((agent) => agent.id === result.id ? result : agent));
      setNotice(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSavingAgentId(null);
    }
  }

  return <div className="page-stack company-o-chart-page">
    <div className="page-head">
      <div><h1>O-Chart</h1><p>Company-based reporting structure for agents and departments.</p></div>
      <label className="field-label o-chart-company-select">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setSelectedAgentId(''); setError(''); void refreshQueries(); }}>
        {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select></label>
    </div>
    {error && <p className="form-error">{error}</p>}
    {notice && <p className="field-hint">{notice}</p>}

    <section className="card company-o-stage">
      <div className="company-o-stage-head">
        <div><h2><Network size={18} /> {selectedCompany?.name ?? 'Company'} O-Chart</h2><span>{companyAgents.length} agents / {companyDepartments.length} departments</span></div>
        <Building2 size={18} />
      </div>
      <div className="company-o-scroll" aria-label="Company organization chart">
        {roots.length > 0 ? roots.map((agent) => <OChartNode key={agent.id} agent={agent} agents={companyAgents} departments={companyDepartments} positions={companyPositions} selectedId={selectedAgent?.id} onSelect={(next) => setSelectedAgentId(next.id)} />) : <div className="chat-empty-state"><Users size={28} /><b>No agents in this company</b><span>Create agents first, then assign reporting lines in Departments.</span></div>}
      </div>
    </section>

    {selectedAgent && agentDraft && <section className="card section-card company-o-details">
      <div className="panel-title">
        <div><h2>{selectedAgent.name}</h2><span className="status-pill">{agentStatus(selectedAgent)}</span></div>
        <button className="btn btn-primary" disabled={savingAgentId === selectedAgent.id} onClick={() => void saveSelectedAgent()}>{savingAgentId === selectedAgent.id ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Save</button>
      </div>
      <div className="meta-grid">
        <span>Position <b>{selectedPosition?.name ?? 'No position'}</b></span>
        <span>Department <b>{selectedDepartment?.name ?? 'No department'}</b></span>
        <span>Reports to <b>{companyAgents.find((agent) => agent.id === selectedAgent.bossId)?.name ?? 'top-level'}</b></span>
        <span>Direct reports <b>{directReports.length}</b></span>
        <span>Adapter <b>{selectedAgent.adapterType ?? 'hermes-ssh'}</b></span>
      </div>
      <div className="form-grid">
        <label className="field-label">Name<input className="input" value={String(agentDraft.name ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })} /></label>
        <label className="field-label">Slug<input className="input" value={String(agentDraft.slug ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, slug: event.target.value })} /></label>
        <label className="field-label">Department<select className="input" value={String(agentDraft.departmentId ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, departmentId: event.target.value || null })}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
        <label className="field-label">Position<select className="input" value={String(agentDraft.positionId ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, positionId: event.target.value || null })}><option value="">No position</option>{companyPositions.map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
        <label className="field-label">Reports to<select className="input" value={String(agentDraft.bossId ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, bossId: event.target.value || null })}><option value="">Top-level</option>{companyAgents.filter((agent) => agent.id !== selectedAgent.id).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field-label">Profile<input className="input" value={String(agentDraft.hermesProfile ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, hermesProfile: event.target.value })} /></label>
        <label className="field-label">Adapter<select className="input" value={String(agentDraft.adapterType ?? 'hermes-ssh')} onChange={(event) => setAgentDraft({ ...agentDraft, adapterType: event.target.value, runtimeId: '' })}>
          <option value="hermes-ssh">Hermes SSH</option>
          <option value="hermes-gateway">Hermes HTTP API</option>
          <option value="codex-app">Codex App Server</option>
          <option value="webhook">Webhook</option>
          <option value="openclaw">OpenClaw</option>
        </select></label>
        <label className="field-label">Runtime<select className="input" value={String(agentDraft.runtimeId ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, runtimeId: event.target.value || null })}><option value="">No runtime</option>{runtimes.filter((runtime) => runtime.adapterType === selectedAdapterType && (!runtime.companyId || runtime.companyId === selectedAgent.companyId)).map((runtime) => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label>
        <label className="field-label">Per-task budget<input className="input" type="number" min={0} step="0.01" value={String(agentDraft.budgetPerTask ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, budgetPerTask: event.target.value })} /></label>
        <label className="field-label">Monthly budget<input className="input" type="number" min={0} step="0.01" value={String(agentDraft.budgetMonthly ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, budgetMonthly: event.target.value })} /></label>
      </div>
      <div className="action-row">
        <button className="btn" disabled={savingAgentId === selectedAgent.id} onClick={() => void agentAction(`/api/agents/${selectedAgent.id}/test-connection`, 'Connection successful')}><Wifi size={14} /> Test</button>
        {selectedAgent.isActive ? <button className="btn" disabled={savingAgentId === selectedAgent.id} onClick={() => void agentAction(`/api/agents/${selectedAgent.id}/pause`, 'Agent paused')}><Pause size={14} /> Pause</button> : <button className="btn" disabled={savingAgentId === selectedAgent.id} onClick={() => void agentAction(`/api/agents/${selectedAgent.id}/resume`, 'Agent resumed')}><CheckCircle2 size={14} /> Resume</button>}
      </div>
    </section>}
  </div>;
}
