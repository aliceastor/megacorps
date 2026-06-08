'use client';
import { useEffect, useMemo, useState } from 'react';
import { BriefcaseBusiness, Building2, Plus, Target } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
type Department = { id: string; companyId: string; name: string };
type Project = { id: string; companyId: string; name: string; description?: string | null; createdAt?: string };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string; body?: string | null; createdAt?: string };

function goalScope(goal: Goal): string {
  if (goal.projectId) return 'Project';
  if (goal.departmentId) return 'Department';
  return 'Company';
}

export function WorkspacesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('__none');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [goalScopeValue, setGoalScopeValue] = useState<'company' | 'department' | 'project'>('project');
  const [goalDepartmentId, setGoalDepartmentId] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');
  const [error, setError] = useState('');

  const companyProjects = useMemo(() => projects.filter((project) => project.companyId === companyId), [projects, companyId]);
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const selectedProject = selectedProjectId !== '__none' ? companyProjects.find((project) => project.id === selectedProjectId) ?? null : null;
  const companyGoals = goals.filter((goal) => goal.companyId === companyId && !goal.departmentId && !goal.projectId);
  const departmentGoals = goals.filter((goal) => goal.companyId === companyId && Boolean(goal.departmentId));
  const projectGoals = goals.filter((goal) => goal.companyId === companyId && Boolean(goal.projectId));
  const selectedProjectGoals = selectedProject ? projectGoals.filter((goal) => goal.projectId === selectedProject.id) : [];

  async function refresh(nextCompanyId = companyId) {
    setError('');
    try {
      const companyRows = await api<Company[]>('/api/companies');
      const activeCompanyId = nextCompanyId || companyRows[0]?.id || '';
      setCompanies(companyRows);
      setCompanyId(activeCompanyId);
      if (!activeCompanyId) return;
      const [departmentRows, projectRows, goalRows] = await Promise.all([
        api<Department[]>(`/api/departments?companyId=${activeCompanyId}`),
        api<Project[]>(`/api/projects?companyId=${activeCompanyId}`),
        api<Goal[]>(`/api/goals?companyId=${activeCompanyId}`),
      ]);
      setDepartments(departmentRows);
      setProjects(projectRows);
      setGoals(goalRows);
      if (selectedProjectId !== '__none' && !projectRows.some((project) => project.id === selectedProjectId)) setSelectedProjectId(projectRows[0]?.id ?? '__none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function addProject() {
    if (!companyId || !projectName.trim()) return;
    setError('');
    try {
      const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ companyId, name: projectName.trim(), description: projectDescription }) });
      setProjectName('');
      setProjectDescription('');
      setSelectedProjectId(project.id);
      await refresh(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project');
    }
  }

  async function addGoal() {
    if (!companyId || !goalTitle.trim()) return;
    const departmentId = goalScopeValue === 'department' ? goalDepartmentId || null : null;
    const projectId = goalScopeValue === 'project' ? selectedProject?.id ?? null : null;
    if (goalScopeValue === 'department' && !departmentId) { setError('Choose a department for a department goal.'); return; }
    if (goalScopeValue === 'project' && !projectId) { setError('Choose a project for a project goal.'); return; }
    setError('');
    try {
      await api<Goal>('/api/goals', { method: 'POST', body: JSON.stringify({ companyId, departmentId, projectId, title: goalTitle.trim(), body: goalBody }) });
      setGoalTitle('');
      setGoalBody('');
      await refresh(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add goal');
    }
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Workspaces</h1><p>Projects are the primary workspace. No-project Direct Chat and Kanban remain available for general work.</p></div></div>
    {error && <p className="form-error">{error}</p>}
    <label className="field-label">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setSelectedProjectId('__none'); void refresh(event.target.value); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    <div className="data-grid">
      <section className="card section-card">
        <h2><BriefcaseBusiness size={18} /> Projects</h2>
        <button className={`list-row ${selectedProjectId === '__none' ? 'active' : ''}`} onClick={() => setSelectedProjectId('__none')} style={{ textAlign: 'left' }}>
          <b>No project</b>
          <p>General Direct Chat and Kanban cards without project scope.</p>
        </button>
        <div className="table-list">{companyProjects.map((project) => <button className={`list-row ${project.id === selectedProjectId ? 'active' : ''}`} key={project.id} onClick={() => setSelectedProjectId(project.id)} style={{ textAlign: 'left' }}>
          <b>{project.name}</b><p>{project.description || 'No description'}</p>
        </button>)}</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label className="field-label">New project<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          <label className="field-label">Description<textarea className="input" rows={3} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
          <button className="btn btn-primary" disabled={!projectName.trim()} onClick={addProject}><Plus size={15} /> Add project</button>
        </div>
      </section>

      <section className="card section-card">
        <h2><Target size={18} /> Goal Scope</h2>
        <div className="meta-grid">
          <span>Selected project <b>{selectedProject?.name ?? 'No project'}</b></span>
          <span>Company goals <b>{companyGoals.length}</b></span>
          <span>Department goals <b>{departmentGoals.length}</b></span>
          <span>Project goals <b>{selectedProject ? selectedProjectGoals.length : projectGoals.length}</b></span>
        </div>
        <div className="form-grid">
          <label className="field-label">Scope<select className="input" value={goalScopeValue} onChange={(event) => setGoalScopeValue(event.target.value as typeof goalScopeValue)}>
            <option value="company">Company goal</option>
            <option value="department">Department goal</option>
            <option value="project">Project goal</option>
          </select></label>
          {goalScopeValue === 'department' && <label className="field-label">Department<select className="input" value={goalDepartmentId} onChange={(event) => setGoalDepartmentId(event.target.value)}>
            <option value="">Choose department</option>
            {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select></label>}
          {goalScopeValue === 'project' && <label className="field-label">Project<input className="input" value={selectedProject?.name ?? 'Select a project on the left'} readOnly /></label>}
        </div>
        <label className="field-label">Goal title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} /></label>
        <label className="field-label">Goal body<textarea className="input" rows={4} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={!goalTitle.trim()} onClick={addGoal}><Plus size={15} /> Add goal</button>
      </section>

      <section className="card section-card">
        <h2><Building2 size={18} /> Effective Goals</h2>
        <div className="table-list">
          {[...companyGoals, ...departmentGoals, ...(selectedProject ? selectedProjectGoals : projectGoals)].map((goal) => <div className="list-row" key={goal.id}>
            <b>{goalScope(goal)} / {goal.title}</b>
            <p>{goal.body || 'No goal body'}</p>
          </div>)}
          {!goals.length && <p className="chat-empty">No goals yet</p>}
        </div>
      </section>
    </div>
  </div>;
}
