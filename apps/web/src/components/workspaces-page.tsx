'use client';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
type Project = { id: string; companyId: string; name: string; description?: string | null; createdAt?: string };
type Goal = { id: string; companyId: string; title: string; body?: string | null; createdAt?: string };

export function WorkspacesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');

  async function refresh(nextCompanyId = companyId) {
    const companyRows = await api<Company[]>('/api/companies');
    const activeCompanyId = nextCompanyId || companyRows[0]?.id || '';
    setCompanies(companyRows);
    setCompanyId(activeCompanyId);
    if (activeCompanyId) {
      const [projectRows, goalRows] = await Promise.all([api<Project[]>(`/api/projects?companyId=${activeCompanyId}`), api<Goal[]>(`/api/goals?companyId=${activeCompanyId}`)]);
      setProjects(projectRows);
      setGoals(goalRows);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function addProject() {
    if (!companyId || !projectName.trim()) return;
    await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ companyId, name: projectName.trim(), description: projectDescription }) });
    setProjectName('');
    setProjectDescription('');
    await refresh(companyId);
  }

  async function addGoal() {
    if (!companyId || !goalTitle.trim()) return;
    await api<Goal>('/api/goals', { method: 'POST', body: JSON.stringify({ companyId, title: goalTitle.trim(), body: goalBody }) });
    setGoalTitle('');
    setGoalBody('');
    await refresh(companyId);
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Workspaces</h1><p>Company projects and goals used for task context and future git worktrees.</p></div></div>
    <label className="field-label">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); void refresh(event.target.value); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    <div className="data-grid">
      <section className="card section-card">
        <h2>Projects</h2>
        <label className="field-label">Name<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
        <label className="field-label">Description<textarea className="input" rows={4} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={!projectName.trim()} onClick={addProject}><Plus size={15} /> Add project</button>
        <div className="table-list">{projects.map((project) => <div className="list-row" key={project.id}><b>{project.name}</b><p>{project.description || 'No description'}</p></div>)}</div>
      </section>
      <section className="card section-card">
        <h2>Goals</h2>
        <label className="field-label">Title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} /></label>
        <label className="field-label">Body<textarea className="input" rows={4} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={!goalTitle.trim()} onClick={addGoal}><Plus size={15} /> Add goal</button>
        <div className="table-list">{goals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}</div>
      </section>
    </div>
  </div>;
}
