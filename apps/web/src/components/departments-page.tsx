'use client';
import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Target, Users, X } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = { id: string; companyId: string; departmentId?: string | null; bossId?: string | null; name: string; role: string; adapterType?: string | null; isActive?: boolean; isBusy?: boolean };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string; body?: string | null };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function DepartmentsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busyAgentId, setBusyAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [departmentCreateOpen, setDepartmentCreateOpen] = useState(false);

  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedDepartment = departmentId === '__unassigned' ? null : companyDepartments.find((department) => department.id === departmentId) ?? companyDepartments[0] ?? null;
  const unassignedAgents = companyAgents.filter((agent) => !agent.departmentId);
  const selectedAgent = companyAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const departmentGoals = useMemo(() => goals.filter((goal) => goal.departmentId === selectedDepartment?.id), [goals, selectedDepartment?.id]);

  async function refresh(nextCompanyId = companyId, nextDepartmentId = departmentId) {
    setError('');
    try {
      const [companyRows, departmentRows, agentRows, goalRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Department[]>('/api/departments'),
        api<Agent[]>('/api/agents'),
        api<Goal[]>('/api/goals'),
      ]);
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setAgents(agentRows);
      setGoals(goalRows);
      const activeCompanyId = companyRows.some((company) => company.id === nextCompanyId) ? nextCompanyId : companyRows[0]?.id ?? '';
      const activeDepartments = departmentRows.filter((department) => department.companyId === activeCompanyId);
      setCompanyId(activeCompanyId);
      setDepartmentId(activeDepartments.some((department) => department.id === nextDepartmentId) ? nextDepartmentId : activeDepartments[0]?.id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load departments');
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setDeptSlug(slugify(deptName)); }, [deptName]);
  useEffect(() => {
    if (selectedAgentId && !companyAgents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId('');
  }, [companyAgents, selectedAgentId]);

  async function addDepartment() {
    if (!companyId || !deptName.trim() || !deptSlug.trim()) return;
    setBusy(true);
    setError('');
    try {
      const department = await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName.trim(), slug: deptSlug.trim() }) });
      setDeptName('');
      setDeptSlug('');
      setDepartmentCreateOpen(false);
      setToast('Department added');
      await refresh(companyId, department.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Department add failed');
    } finally {
      setBusy(false);
    }
  }

  async function addDepartmentGoal() {
    if (!companyId || !selectedDepartment || !goalTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api<Goal>('/api/goals', { method: 'POST', body: JSON.stringify({ companyId, departmentId: selectedDepartment.id, title: goalTitle.trim(), body: goalBody }) });
      setGoalTitle('');
      setGoalBody('');
      setToast('Department goal added');
      await refresh(companyId, selectedDepartment.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goal add failed');
    } finally {
      setBusy(false);
    }
  }

  async function updateAgentOrg(agent: Agent, patch: Pick<Agent, 'departmentId' | 'bossId'>) {
    setBusyAgentId(agent.id);
    setError('');
    try {
      const updated = await api<Agent>(`/api/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedAgentId(updated.id);
      setToast(`${updated.name} updated`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent update failed');
    } finally {
      setBusyAgentId('');
    }
  }

  function startNewDepartment() {
    setDeptName('');
    setDeptSlug('');
    setError('');
    setDepartmentCreateOpen(true);
  }

  const addDepartmentDisabled = !companyId || busy || !deptName.trim() || !deptSlug.trim();

  return <div className="page-stack departments-page">
    <div className="page-head">
      <div><h1>Departments</h1><p>Manage department membership, reporting lines, and department goals.</p></div>
      <button className="btn" disabled={!companyId} title={companyId ? 'Create department' : 'Create a company first'} onClick={startNewDepartment}><Plus size={15} /> New Department</button>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    {departmentCreateOpen && <div className="overlay">
      <section className="card modal department-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-department-title">
        <div className="panel-title">
          <div><h2 id="new-department-title">New Department</h2><span className="status-pill">{companies.find((company) => company.id === companyId)?.name ?? 'No company'}</span></div>
          <button className="btn icon-btn" aria-label="Close new department" onClick={() => setDepartmentCreateOpen(false)}><X size={16} /></button>
        </div>
        <div className="form-grid">
          <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(''); void refresh(event.target.value, ''); }}>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select></label>
          <label className="field-label">Department name<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} disabled={!companyId} /></label>
          <label className="field-label">Slug<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(slugify(event.target.value))} disabled={!companyId} /></label>
        </div>
        <div className="action-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setDepartmentCreateOpen(false)}>Cancel</button>
          <button className="btn btn-primary" title={companyId ? 'Add department' : 'Create a company first before adding departments'} disabled={addDepartmentDisabled} onClick={addDepartment}><Plus size={14} /> Add Department</button>
        </div>
      </section>
    </div>}

    <div className="department-workbench">
      <aside className="card section-card department-rail">
        <div className="panel-title"><h2>Departments</h2><span className="status-pill">{companyDepartments.length}</span></div>
        <label className="field-label">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(''); void refresh(event.target.value, ''); }}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        <div className="table-list">
          {companyDepartments.map((department) => <button className={`list-row selectable-row ${department.id === selectedDepartment?.id ? 'active' : ''}`} key={department.id} onClick={() => setDepartmentId(department.id)}>
            <b>{department.name}</b>
            <p>{department.slug} / {companyAgents.filter((agent) => agent.departmentId === department.id).length} agents</p>
          </button>)}
          <button className={`list-row selectable-row ${departmentId === '__unassigned' ? 'active' : ''}`} onClick={() => setDepartmentId('__unassigned')}>
            <b>No department</b>
            <p>{unassignedAgents.length} agents</p>
          </button>
          {companyDepartments.length === 0 && <p className="chat-empty">No departments yet.</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title"><div><h2><Users size={18} /> Member Assignment</h2><span className="status-pill">{companyAgents.length} company agents</span></div></div>
          <div className="table-wrap">
            <table className="data-table org-assignment-table">
              <thead><tr><th>Agent</th><th>Department</th><th>Reports to</th><th>Status</th></tr></thead>
              <tbody>
                {companyAgents.map((agent) => <tr key={agent.id}>
                  <td><button type="button" className="text-button agent-name-button" onClick={() => setSelectedAgentId(agent.id)}><b>{agent.name}</b><small>{agent.role} / {agent.adapterType ?? 'mock'}</small></button></td>
                  <td><select className="input compact" disabled={busyAgentId === agent.id} value={agent.departmentId ?? ''} onChange={(event) => void updateAgentOrg(agent, { departmentId: event.target.value || null })}>
                    <option value="">No department</option>
                    {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select></td>
                  <td><select className="input compact" disabled={busyAgentId === agent.id} value={agent.bossId ?? ''} onChange={(event) => void updateAgentOrg(agent, { bossId: event.target.value || null })}>
                    <option value="">Top-level agent</option>
                    {companyAgents.filter((candidate) => candidate.id !== agent.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select></td>
                  <td><span className="badge">{agent.isBusy ? 'busy' : agent.isActive === false ? 'offline' : 'ready'}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {companyAgents.length === 0 && <p className="chat-empty">No agents in this company yet.</p>}
        </section>

        {selectedAgent && <section className="card section-card agent-inline-editor">
          <div className="panel-title"><div><h2><Pencil size={18} /> Agent Editor</h2><span className="status-pill">{selectedAgent.name}</span></div></div>
          <div className="agent-editor-summary">
            <b>{selectedAgent.role}</b>
            <span>{selectedAgent.adapterType ?? 'mock'} / {selectedAgent.isBusy ? 'busy' : selectedAgent.isActive === false ? 'offline' : 'ready'}</span>
          </div>
          <div className="form-grid department-agent-edit-grid">
            <label className="field-label">Department<select className="input compact" disabled={busyAgentId === selectedAgent.id} value={selectedAgent.departmentId ?? ''} onChange={(event) => void updateAgentOrg(selectedAgent, { departmentId: event.target.value || null })}>
              <option value="">No department</option>
              {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select></label>
            <label className="field-label">Reports to<select className="input compact" disabled={busyAgentId === selectedAgent.id} value={selectedAgent.bossId ?? ''} onChange={(event) => void updateAgentOrg(selectedAgent, { bossId: event.target.value || null })}>
              <option value="">Top-level agent</option>
              {companyAgents.filter((candidate) => candidate.id !== selectedAgent.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select></label>
          </div>
        </section>}

        <section className="card section-card">
          <div className="panel-title"><div><h2><Target size={18} /> Department Goals</h2><span className="status-pill">{selectedDepartment?.name ?? 'No department selected'}</span></div></div>
          <label className="field-label">Goal title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedDepartment} /></label>
          <label className="field-label">Goal body<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedDepartment} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedDepartment || !goalTitle.trim()} onClick={addDepartmentGoal}><Plus size={15} /> Add Department Goal</button>
          <div className="table-list">
            {departmentGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}
            {selectedDepartment && departmentGoals.length === 0 && <p className="chat-empty">No department goals yet.</p>}
          </div>
        </section>
      </main>
    </div>
  </div>;
}
