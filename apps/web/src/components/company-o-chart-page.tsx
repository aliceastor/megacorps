'use client';
import { useEffect, useMemo, useState } from 'react';
import { Building2, Network, UserRound, Users } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = {
  id: string;
  companyId: string;
  departmentId?: string | null;
  bossId?: string | null;
  name: string;
  role: string;
  title?: string | null;
  adapterType?: string | null;
  isActive?: boolean;
  isBusy?: boolean;
};

function agentStatus(agent: Agent): string {
  if (agent.isBusy) return 'busy';
  if (agent.isActive === false) return 'offline';
  return 'active';
}

function agentLabel(agent: Agent): string {
  return agent.title || agent.role || 'Agent';
}

function OChartNode({ agent, agents, departments, selectedId, onSelect, lineage = new Set<string>() }: {
  agent: Agent;
  agents: Agent[];
  departments: Department[];
  selectedId?: string;
  onSelect: (agent: Agent) => void;
  lineage?: Set<string>;
}) {
  const nextLineage = new Set(lineage).add(agent.id);
  const children = agents.filter((item) => item.bossId === agent.id && !nextLineage.has(item.id));
  const department = departments.find((item) => item.id === agent.departmentId);
  return <div className={`company-o-node${children.length ? ' has-children' : ''}`}>
    <button type="button" className={`company-o-card ${selectedId === agent.id ? 'active' : ''}`} onClick={() => onSelect(agent)}>
      <span className="company-o-icon"><UserRound size={16} /></span>
      <span className="company-o-copy">
        <b>{agentLabel(agent)}</b>
        <small><span className={`org-agent-dot ${agentStatus(agent)}`} /> {agent.name}</small>
        <small>{department?.name ?? 'No department'} / {agent.adapterType ?? 'mock'}</small>
      </span>
    </button>
    {children.length > 0 && <div className="company-o-children">
      {children.map((child) => <OChartNode key={child.id} agent={child} agents={agents} departments={departments} selectedId={selectedId} onSelect={onSelect} lineage={nextLineage} />)}
    </div>}
  </div>;
}

export function CompanyOChartPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [error, setError] = useState('');

  async function refresh(nextCompanyId = companyId) {
    setError('');
    try {
      const [companyRows, departmentRows, agentRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Department[]>('/api/departments'),
        api<Agent[]>('/api/agents'),
      ]);
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setAgents(agentRows);
      const activeCompanyId = companyRows.some((company) => company.id === nextCompanyId) ? nextCompanyId : companyRows[0]?.id ?? '';
      setCompanyId(activeCompanyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load O-Chart');
    }
  }

  useEffect(() => { void refresh(); }, []);

  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const companyAgentIds = useMemo(() => new Set(companyAgents.map((agent) => agent.id)), [companyAgents]);
  const roots = useMemo(() => {
    const rootRows = companyAgents.filter((agent) => !agent.bossId || !companyAgentIds.has(agent.bossId));
    return rootRows.length ? rootRows : companyAgents;
  }, [companyAgents, companyAgentIds]);
  const selectedAgent = companyAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedDepartment = selectedAgent ? companyDepartments.find((department) => department.id === selectedAgent.departmentId) : null;
  const directReports = selectedAgent ? companyAgents.filter((agent) => agent.bossId === selectedAgent.id) : [];

  return <div className="page-stack company-o-chart-page">
    <div className="page-head">
      <div><h1>O-Chart</h1><p>Company-based reporting structure for agents and departments.</p></div>
      <label className="field-label o-chart-company-select">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setSelectedAgentId(''); void refresh(event.target.value); }}>
        {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select></label>
    </div>
    {error && <p className="form-error">{error}</p>}

    <section className="card company-o-stage">
      <div className="company-o-stage-head">
        <div><h2><Network size={18} /> {selectedCompany?.name ?? 'Company'} O-Chart</h2><span>{companyAgents.length} agents / {companyDepartments.length} departments</span></div>
        <Building2 size={18} />
      </div>
      <div className="company-o-scroll" aria-label="Company organization chart">
        {roots.length > 0 ? roots.map((agent) => <OChartNode key={agent.id} agent={agent} agents={companyAgents} departments={companyDepartments} selectedId={selectedAgent?.id} onSelect={(next) => setSelectedAgentId(next.id)} />) : <div className="chat-empty-state"><Users size={28} /><b>No agents in this company</b><span>Create agents first, then assign reporting lines in Departments.</span></div>}
      </div>
    </section>

    {selectedAgent && <section className="card section-card company-o-details">
      <div className="panel-title"><div><h2>{selectedAgent.name}</h2><span className="status-pill">{agentStatus(selectedAgent)}</span></div></div>
      <div className="meta-grid">
        <span>Role <b>{selectedAgent.role}</b></span>
        <span>Title <b>{selectedAgent.title || 'not set'}</b></span>
        <span>Department <b>{selectedDepartment?.name ?? 'No department'}</b></span>
        <span>Reports to <b>{companyAgents.find((agent) => agent.id === selectedAgent.bossId)?.name ?? 'top-level'}</b></span>
        <span>Direct reports <b>{directReports.length}</b></span>
        <span>Adapter <b>{selectedAgent.adapterType ?? 'mock'}</b></span>
      </div>
    </section>}
  </div>;
}
