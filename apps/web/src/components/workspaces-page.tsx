'use client';
import { useEffect, useMemo, useState } from 'react';
import { BriefcaseBusiness, Building2, GitBranch, Plus, Save, Target } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
type Department = { id: string; companyId: string; name: string };
type Project = {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  repoProvider?: 'github' | 'gitlab' | 'gitea' | 'generic' | null;
  repoUrl?: string | null;
  workPath?: string | null;
  defaultBranch?: string | null;
  protectedBranches?: string[] | null;
  workBranchPattern?: string | null;
  pullBeforeRun?: boolean | null;
  pushAfterRun?: boolean | null;
  completionPolicy?: 'push_branch' | 'pull_request' | 'push_or_pr' | 'manual' | null;
  setupCommand?: string | null;
  testCommand?: string | null;
  runtimeServices?: Record<string, unknown> | null;
  workspacePathHint?: string | null;
  createdAt?: string;
};
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
  const [repoProvider, setRepoProvider] = useState<'github' | 'gitlab' | 'gitea' | 'generic'>('github');
  const [repoUrl, setRepoUrl] = useState('');
  const [workPath, setWorkPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [protectedBranches, setProtectedBranches] = useState('main, master');
  const [workBranchPattern, setWorkBranchPattern] = useState('megacorps/card-{cardId}-{agentSlug}');
  const [pullBeforeRun, setPullBeforeRun] = useState(true);
  const [pushAfterRun, setPushAfterRun] = useState(true);
  const [completionPolicy, setCompletionPolicy] = useState<'push_branch' | 'pull_request' | 'push_or_pr' | 'manual'>('push_or_pr');
  const [setupCommand, setSetupCommand] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [runtimeServicesJson, setRuntimeServicesJson] = useState('{}');
  const [workspacePathHint, setWorkspacePathHint] = useState('');
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

  useEffect(() => {
    if (!selectedProject) return;
    setProjectName(selectedProject.name);
    setProjectDescription(selectedProject.description ?? '');
    setRepoProvider(selectedProject.repoProvider ?? 'github');
    setRepoUrl(selectedProject.repoUrl ?? '');
    setWorkPath(selectedProject.workPath ?? '');
    setDefaultBranch(selectedProject.defaultBranch ?? 'main');
    setProtectedBranches((selectedProject.protectedBranches?.length ? selectedProject.protectedBranches : ['main', 'master']).join(', '));
    setWorkBranchPattern(selectedProject.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}');
    setPullBeforeRun(selectedProject.pullBeforeRun !== false);
    setPushAfterRun(selectedProject.pushAfterRun !== false);
    setCompletionPolicy(selectedProject.completionPolicy ?? 'push_or_pr');
    setSetupCommand(selectedProject.setupCommand ?? '');
    setTestCommand(selectedProject.testCommand ?? '');
    setRuntimeServicesJson(JSON.stringify(selectedProject.runtimeServices ?? {}, null, 2));
    setWorkspacePathHint(selectedProject.workspacePathHint ?? '');
  }, [selectedProject?.id]);

  function parseList(value: string): string[] {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  function parseRuntimeServices(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(runtimeServicesJson.trim() || '{}') as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        setError('Runtime services must be a JSON object.');
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      setError('Runtime services must be valid JSON.');
      return null;
    }
  }

  function projectPayload() {
    const runtimeServices = parseRuntimeServices();
    if (!runtimeServices) return null;
    return {
      name: projectName.trim(),
      description: projectDescription,
      repoProvider,
      repoUrl: repoUrl || null,
      workPath: workPath || null,
      defaultBranch,
      protectedBranches: parseList(protectedBranches).length ? parseList(protectedBranches) : ['main', 'master'],
      workBranchPattern,
      pullBeforeRun,
      pushAfterRun,
      completionPolicy,
      setupCommand: setupCommand || null,
      testCommand: testCommand || null,
      runtimeServices,
      workspacePathHint: workspacePathHint || null,
    };
  }

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
      const payload = projectPayload();
      if (!payload) return;
      const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ companyId, ...payload }) });
      setProjectName('');
      setProjectDescription('');
      setRepoUrl('');
      setWorkPath('');
      setProtectedBranches('main, master');
      setRuntimeServicesJson('{}');
      setSelectedProjectId(project.id);
      await refresh(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project');
    }
  }

  async function saveProject() {
    if (!selectedProject || !projectName.trim()) return;
    setError('');
    try {
      const payload = projectPayload();
      if (!payload) return;
      await api<Project>(`/api/projects/${selectedProject.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      await refresh(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project');
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
        <button className={`list-row ${selectedProjectId === '__none' ? 'active' : ''}`} onClick={() => {
          setSelectedProjectId('__none');
          setProjectName('');
          setProjectDescription('');
          setRepoProvider('github');
          setRepoUrl('');
          setWorkPath('');
          setDefaultBranch('main');
          setProtectedBranches('main, master');
          setWorkBranchPattern('megacorps/card-{cardId}-{agentSlug}');
          setPullBeforeRun(true);
          setPushAfterRun(true);
          setCompletionPolicy('push_or_pr');
          setSetupCommand('');
          setTestCommand('');
          setRuntimeServicesJson('{}');
          setWorkspacePathHint('');
        }} style={{ textAlign: 'left' }}>
          <b>No project</b>
          <p>General Direct Chat and Kanban cards without project scope.</p>
        </button>
        <div className="table-list">{companyProjects.map((project) => <button className={`list-row ${project.id === selectedProjectId ? 'active' : ''}`} key={project.id} onClick={() => setSelectedProjectId(project.id)} style={{ textAlign: 'left' }}>
          <b>{project.name}</b><p>{project.repoUrl || project.description || 'No repository configured'}</p>
        </button>)}</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label className="field-label">{selectedProject ? 'Project name' : 'New project'}<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          <label className="field-label">Description<textarea className="input" rows={3} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
          <div className="form-grid">
            <label className="field-label">Repo provider<select className="input" value={repoProvider} onChange={(event) => setRepoProvider(event.target.value as typeof repoProvider)}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="gitea">Gitea</option>
              <option value="generic">Generic Git</option>
            </select></label>
            <label className="field-label">Default branch<input className="input" value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></label>
          </div>
          <label className="field-label">Repository URL<input className="input" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/repo" /></label>
          <label className="field-label">Project work path<input className="input" value={workPath} onChange={(event) => setWorkPath(event.target.value)} placeholder="Repo/workspace-relative path, e.g. apps/server or reports/final" /></label>
          <label className="field-label">Protected branches<input className="input" value={protectedBranches} onChange={(event) => setProtectedBranches(event.target.value)} placeholder="main, master, production" /></label>
          <label className="field-label">Work branch pattern<input className="input" value={workBranchPattern} onChange={(event) => setWorkBranchPattern(event.target.value)} /></label>
          <div className="form-grid">
            <label className="check-row"><input type="checkbox" checked={pullBeforeRun} onChange={(event) => setPullBeforeRun(event.target.checked)} /> Pull before every run</label>
            <label className="check-row"><input type="checkbox" checked={pushAfterRun} onChange={(event) => setPushAfterRun(event.target.checked)} /> Push after completion</label>
          </div>
          <label className="field-label">Completion policy<select className="input" value={completionPolicy} onChange={(event) => setCompletionPolicy(event.target.value as typeof completionPolicy)}>
            <option value="push_or_pr">Push branch or PR</option>
            <option value="pull_request">Pull request</option>
            <option value="push_branch">Push branch</option>
            <option value="manual">Manual evidence</option>
          </select></label>
          <label className="field-label">Setup command<textarea className="input" rows={2} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} /></label>
          <label className="field-label">Test command<textarea className="input" rows={2} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} /></label>
          <label className="field-label">Runtime services JSON<textarea className="input" rows={4} value={runtimeServicesJson} onChange={(event) => setRuntimeServicesJson(event.target.value)} placeholder='{"postgres":"postgres://...","web":"http://localhost:3000"}' /></label>
          <label className="field-label">Runtime-local path hint<input className="input" value={workspacePathHint} onChange={(event) => setWorkspacePathHint(event.target.value)} placeholder="Optional runtime-local clone/folder hint only" /></label>
          {selectedProject
            ? <button className="btn btn-primary" disabled={!projectName.trim()} onClick={saveProject}><Save size={15} /> Save project</button>
            : <button className="btn btn-primary" disabled={!projectName.trim()} onClick={addProject}><Plus size={15} /> Add project</button>}
        </div>
      </section>

      <section className="card section-card">
        <h2><GitBranch size={18} /> Repository Protocol</h2>
        <div className="meta-grid">
          <span>Provider <b>{selectedProject?.repoProvider ?? repoProvider}</b></span>
          <span>Default branch <b>{selectedProject?.defaultBranch ?? defaultBranch}</b></span>
          <span>Protected branches <b>{(selectedProject?.protectedBranches?.length ? selectedProject.protectedBranches : parseList(protectedBranches)).join(', ') || 'none'}</b></span>
          <span>Work path <b>{selectedProject?.workPath || workPath || 'project root'}</b></span>
          <span>Pull before run <b>{(selectedProject?.pullBeforeRun ?? pullBeforeRun) ? 'yes' : 'no'}</b></span>
          <span>Push after run <b>{(selectedProject?.pushAfterRun ?? pushAfterRun) ? 'yes' : 'no'}</b></span>
        </div>
        <p className="chat-empty" style={{ textAlign: 'left' }}>Agents use their own runtime-local clone. MegaCorps injects the repo URL, project work path, branch rules, setup/test commands, and requires PR/commit/preview work products instead of local-only file paths.</p>
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
