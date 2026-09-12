'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Loader2, Network, Pause, Save, Users, Wifi } from 'lucide-react';
import { positionAssignment, positionEditPatch, eligibleSupervisors, selectSupervisor, supervisorHint } from '@/lib/position-assignment';
import { api } from '@/lib/api';
import { layoutOrgChart } from '@/lib/org-layout';
import { useLocale } from '@/lib/locale-context';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string; headAgentId?: string | null };
type Position = { id: string; companyId: string; name: string; slug: string; rank?: number | null; isCompanyBoss?: boolean; isDepartmentHead?: boolean; isCompanyLeadership?: boolean; isActive?: boolean; managerPositionId?: string | null; defaultDepartmentId?: string | null };
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

function MeasuredOrgChart({ agents, departments, positions, selectedId, onSelect }: {
  agents: Agent[]; departments: Department[]; positions: Position[];
  selectedId?: string; onSelect: (agent: Agent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const [cardWidth, setCardWidth] = useState(264);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const layout = useMemo(() => layoutOrgChart({ departments, nodes: agents.map(agent => ({
    id: agent.id, name: agent.name, bossId: agent.bossId, departmentId: agent.departmentId,
    rank: positions.find(position => position.id === agent.positionId)?.rank ?? null,
    isCompanyBoss: positions.find(position => position.id === agent.positionId)?.isCompanyBoss === true,
    isCompanyLeadership: positions.find(position => position.id === agent.positionId)?.isCompanyLeadership === true,
    width: sizes[agent.id]?.width ?? cardWidth, height: sizes[agent.id]?.height ?? 128,
  })) }), [agents, departments, positions, sizes, cardWidth]);

  useLayoutEffect(() => {
    let frame = 0, disposed = false;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        if (scrollRef.current) setCardWidth(Math.max(220, Math.min(264, Math.floor(scrollRef.current.clientWidth - 48))));
        const next: Record<string, { width: number; height: number }> = {};
        for (const [id, element] of cardRefs.current) {
          const bounds = element.getBoundingClientRect(); next[id] = { width: bounds.width, height: bounds.height };
        }
        setSizes(previous => Object.keys(previous).length === Object.keys(next).length && Object.entries(next).every(([id, value]) => previous[id] && Math.abs(previous[id].width-value.width)<.1 && Math.abs(previous[id].height-value.height)<.1) ? previous : next);
      });
    };
    const observer = new ResizeObserver(measure);
    if (scrollRef.current) observer.observe(scrollRef.current);
    for (const card of cardRefs.current.values()) observer.observe(card);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, [agents, cardWidth]);

  return <div className="company-o-scroll" ref={scrollRef} role="region" tabIndex={0} aria-label="Company organization chart. Scroll to explore all ranks and departments.">
    <div className="company-o-canvas" style={{ width: layout.width, height: layout.height }}>
      {layout.groups.map(group => <div key={group.id} className="company-o-group" data-org-group={group.id} data-members={JSON.stringify(group.memberIds)} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}><h3>{group.name}</h3></div>)}
      <svg className="company-o-edges" width={layout.width} height={layout.height} aria-hidden="true">
        <defs><marker id="org-report-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 6 4 L 0 8" fill="none" stroke="currentColor" strokeWidth="1.5" /></marker></defs>
        {layout.departmentEdges.map(edge => <path key={edge.id} className="company-o-department-edge" data-org-department-edge={edge.id} data-source={edge.sourceId} data-target-group={edge.targetGroupId} d={edge.path} fill="none" strokeWidth={edge.strokeWidth} />)}
        {layout.edges.map(edge => <g key={edge.id}>
          <path d={edge.path} fill="none" stroke="var(--card)" strokeWidth="6" />
          <path data-org-edge={edge.id} data-source={edge.sourceId} data-target={edge.targetId} d={edge.path} fill="none" stroke="currentColor" strokeWidth={edge.strokeWidth} markerEnd="url(#org-report-arrow)" />
        </g>)}
      </svg>
      {layout.nodes.map(node => {
        const agent = agents.find(a => a.id === node.id)!;
        const position = positions.find(p => p.id === agent.positionId);
        const manager = agents.find(a => a.id === agent.bossId);
        return <button key={node.id} ref={element => { if (element) cardRefs.current.set(node.id, element); else cardRefs.current.delete(node.id); }} type="button" className={`company-o-card ${node.groupId === '__company_leadership__' ? 'company-o-card-leadership' : ''} ${selectedId === node.id ? 'active' : ''}`} data-org-agent={node.id} data-org-group-id={node.groupId} data-rank={node.rank ?? ''} aria-pressed={selectedId === node.id} style={{ left: node.x, top: node.y, width: cardWidth }} onClick={() => onSelect(agent)}>
          <span className="company-o-copy"><span className={`org-agent-dot ${agentStatus(agent)}`} /><span className="company-o-copy-text">
            <b>{agent.name}</b>
            <small>{position?.name ?? 'No position'} · {node.rank == null ? 'Unassigned rank' : `Rank ${node.rank}`}</small>
            <small>Reports to: {manager?.name ?? (agent.bossId ? 'unavailable manager' : 'top-level')}</small>
            {node.relationshipIssue && <small className="company-o-warning">{node.relationshipIssue}</small>}
            <small>{agent.adapterType ?? 'hermes-ssh'} · {agentStatusLabel(agent)}</small>
          </span></span>
        </button>;
      })}
    </div>
  </div>;
}
export function CompanyOChartPage() {
  const { t } = useLocale();
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
  const selectedAgent = companyAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedDepartment = selectedAgent ? companyDepartments.find((department) => department.id === selectedAgent.departmentId) : null;
  const selectedPosition = selectedAgent ? companyPositions.find((position) => position.id === selectedAgent.positionId) : null;
  const draftPosition = companyPositions.find(position => position.id === agentDraft?.positionId);
  const companyBossId = companyAgents.find(agent => agent.isActive !== false && companyPositions.some(position => position.id === agent.positionId && position.isCompanyBoss))?.id;
  const draftCandidates = eligibleSupervisors(draftPosition, selectedAgent?.id, companyId, companyAgents, companyPositions);
  const draftSupervisorId = draftPosition ? selectSupervisor(draftCandidates, agentDraft?.bossId) : agentDraft?.bossId ?? null;
  const draftOrg = positionAssignment(draftPosition, draftSupervisorId, companyBossId);
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
    if (draftCandidates.length > 1 && !draftSupervisorId) { setError('Choose an eligible supervisor from the manager position.'); return; }
    setSavingAgentId(selectedAgent.id);
    setError('');
    setNotice('');
    try {
      // This editor owns only the visible fields. Omitted advanced fields
      // remain stored verbatim, including redacted runtime configuration.
      const payload: Record<string, unknown> = {};
      for (const field of ['name', 'slug', 'adapterType'] as const) {
        const value = String(agentDraft[field] ?? selectedAgent[field] ?? '');
        if (value !== selectedAgent[field]) payload[field] = value;
      }
      for (const field of ['runtimeId', 'hermesProfile'] as const) {
        const value = agentDraft[field] || null;
        if (value !== (selectedAgent[field] || null)) payload[field] = value;
      }
      Object.assign(payload, positionEditPatch(selectedAgent, draftPosition, agentDraft.positionId, draftSupervisorId, companyBossId));
      for (const field of ['budgetPerTask', 'budgetMonthly'] as const) {
        const value = agentDraft[field] === '' || agentDraft[field] == null ? null : Number(agentDraft[field]);
        const original = selectedAgent[field] == null || selectedAgent[field] === '' ? null : Number(selectedAgent[field]);
        if (value !== original) payload[field] = value;
      }
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
      <p className="company-o-legend">Smaller Rank appears higher. Arrows run from each manager's bottom to each report's top. Scroll inside the chart to explore.</p>
      {companyAgents.length ? <MeasuredOrgChart agents={companyAgents} departments={companyDepartments} positions={companyPositions} selectedId={selectedAgent?.id} onSelect={next => setSelectedAgentId(next.id)} /> : <div className="chat-empty-state"><Users size={28} /><b>No agents in this company</b><span>Create agents first, then assign reporting lines in Departments.</span></div>}
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
        <label className="field-label">Department<select className="input" disabled title="Department is determined by position" value={draftOrg.departmentId ?? ''}><option value="">No department</option>{companyDepartments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
        <label className="field-label">Position<select className="input" value={String(agentDraft.positionId ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, positionId: event.target.value || null })}><option value="">No position</option>{companyPositions.map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
        <label className="field-label">Reports to<select aria-label="Reports to" className="input" disabled={Boolean(draftPosition?.isCompanyBoss || draftPosition?.isDepartmentHead)} value={draftOrg.bossId ?? ''} onChange={(event) => setAgentDraft({ ...agentDraft, bossId: event.target.value || null })}><option value="">{draftCandidates.length ? 'Choose supervisor' : 'No eligible supervisor'}</option>{draftCandidates.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select><span className="field-hint">{supervisorHint(draftPosition, draftCandidates)}</span></label>
        <label className="field-label">Profile<input className="input" value={String(agentDraft.hermesProfile ?? '')} onChange={(event) => setAgentDraft({ ...agentDraft, hermesProfile: event.target.value })} /></label>
        <label className="field-label">Adapter<select className="input" value={String(agentDraft.adapterType ?? 'hermes-ssh')} onChange={(event) => setAgentDraft({ ...agentDraft, adapterType: event.target.value, runtimeId: '' })}>
          <option value="a2a">A2A</option>{selectedAgent.adapterType === 'hermes-ssh' && <option value="hermes-ssh">Hermes SSH ({t('setup.legacy')})</option>}
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
