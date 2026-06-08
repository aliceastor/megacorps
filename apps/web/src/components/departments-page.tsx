'use client';
import { useEffect, useMemo, useState } from 'react';
import { Network, Plus, Target } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = { id: string; companyId: string; departmentId?: string | null; bossId?: string | null; name: string; role: string; title?: string | null; adapterType?: string | null; isActive?: boolean; isBusy?: boolean };
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
  const [busy, setBusy] = useState(false);

  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedDepartment = companyDepartments.find((department) => department.id === departmentId) ?? companyDepartments[0] ?? null;
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

  async function addDepartment() {
    if (!companyId || !deptName.trim() || !deptSlug.trim()) return;
    setBusy(true);
    setError('');
    try {
      const department = await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName.trim(), slug: deptSlug.trim() }) });
      setDeptName('');
      setDeptSlug('');
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

  const addDepartmentDisabled = !companyId || busy || !deptName.trim() || !deptSlug.trim();

  return <div className="page-stack">
    <div className="page-head">
      <div><h1>Departments</h1><p>Manage department lanes, browse org structure, and set department goals.</p></div>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <section className="card section-card">
      <div className="panel-title"><div><h2>Department Management</h2><span className="status-pill">{companyDepartments.length} departments</span></div><Network size={18} /></div>
      <label className="field-label">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(''); void refresh(event.target.value, ''); }}>
        {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select></label>
      <div className="form-grid">
        <label className="field-label">New department<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} disabled={!companyId} /></label>
        <label className="field-label">Slug<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(slugify(event.target.value))} disabled={!companyId} /></label>
      </div>
      <button className="btn" title={companyId ? 'Add department' : 'Create a company first before adding departments'} disabled={addDepartmentDisabled} onClick={addDepartment}><Plus size={14} /> Add Department</button>
    </section>

    <div className="split-layout">
      <aside className="card section-card">
        <div className="panel-title"><h2>Departments</h2><span className="status-pill">{companyDepartments.length}</span></div>
        <div className="table-list">
          {companyDepartments.map((department) => <button className="list-row selectable-row" style={{ borderColor: department.id === selectedDepartment?.id ? 'var(--primary)' : 'var(--border)' }} key={department.id} onClick={() => setDepartmentId(department.id)}>
            <b>{department.name}</b>
            <p>{department.slug} / {companyAgents.filter((agent) => agent.departmentId === department.id).length} agents</p>
          </button>)}
          {companyDepartments.length === 0 && <p className="chat-empty">No departments yet.</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title"><div><h2>Department Goals</h2><span className="status-pill">{selectedDepartment?.name ?? 'No department'}</span></div><Target size={18} /></div>
          <label className="field-label">Goal title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedDepartment} /></label>
          <label className="field-label">Goal body<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedDepartment} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedDepartment || !goalTitle.trim()} onClick={addDepartmentGoal}><Plus size={15} /> Add Department Goal</button>
          <div className="table-list">
            {departmentGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}
            {selectedDepartment && departmentGoals.length === 0 && <p className="chat-empty">No department goals yet.</p>}
          </div>
        </section>

        <div className="page-stack">
          {companyDepartments.map((department) => {
            const laneAgents = companyAgents.filter((agent) => agent.departmentId === department.id);
            return <section className="card org-chart-lane" key={department.id}>
              <div className="panel-title"><h3>{department.name}</h3><span className="status-pill">{laneAgents.length} members</span></div>
              <div className="org-node-list">
                {laneAgents.map((agent) => <article className="agent-node-card org-agent-node" key={agent.id}>
                  <div className="org-agent-head"><span className={`org-agent-dot ${agent.isBusy ? 'busy' : agent.isActive === false ? 'offline' : 'active'}`} /><b>{agent.name}</b></div>
                  <div className="org-agent-meta"><span>{agent.title || agent.role}</span><span>{agent.adapterType ?? 'mock'}</span></div>
                </article>)}
                {laneAgents.length === 0 && <p className="chat-empty">No agents in this department.</p>}
              </div>
            </section>;
          })}
          <section className="card org-chart-lane">
            <div className="panel-title"><h3>Unassigned department</h3><span className="status-pill">{companyAgents.filter((agent) => !agent.departmentId).length} members</span></div>
            <div className="org-node-list">
              {companyAgents.filter((agent) => !agent.departmentId).map((agent) => <article className="agent-node-card org-agent-node" key={agent.id}>
                <div className="org-agent-head"><span className={`org-agent-dot ${agent.isBusy ? 'busy' : agent.isActive === false ? 'offline' : 'active'}`} /><b>{agent.name}</b></div>
                <div className="org-agent-meta"><span>{agent.title || agent.role}</span><span>{agent.adapterType ?? 'mock'}</span></div>
              </article>)}
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>;
}
