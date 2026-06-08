'use client';
import { useEffect, useMemo, useState } from 'react';
import { BriefcaseBusiness, FolderGit2, GitBranch, Plus, Save, Target } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
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

type ProjectAuthorityPanelProps = {
  lockedCompanyId?: string;
  heading?: string;
  description?: string;
  compact?: boolean;
  showPageHead?: boolean;
};

function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function ProjectAuthorityPanel({ lockedCompanyId, heading = 'Projects', description = 'Project CRUD, repository rules, branch policy, work path, and project goals.', compact = false, showPageHead = false }: ProjectAuthorityPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState(lockedCompanyId ?? '');
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
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const activeCompanyId = lockedCompanyId ?? companyId;
  const activeCompany = companies.find((company) => company.id === activeCompanyId) ?? null;
  const companyProjects = useMemo(() => projects.filter((project) => project.companyId === activeCompanyId), [projects, activeCompanyId]);
  const selectedProject = selectedProjectId !== '__none' ? companyProjects.find((project) => project.id === selectedProjectId) ?? null : null;
  const selectedProjectGoals = selectedProject ? goals.filter((goal) => goal.projectId === selectedProject.id) : [];

  function resetProjectDraft() {
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
    setGoalTitle('');
    setGoalBody('');
  }

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
    setGoalTitle('');
    setGoalBody('');
  }, [selectedProject?.id]);

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
    if (runtimeServices === null) return null;
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

  async function refresh(nextCompanyId = activeCompanyId) {
    setError('');
    try {
      const companyRows = await api<Company[]>('/api/companies');
      const nextActiveCompanyId = lockedCompanyId || (companyRows.some((company) => company.id === nextCompanyId) ? nextCompanyId : companyRows[0]?.id ?? '');
      setCompanies(companyRows);
      setCompanyId(nextActiveCompanyId);
      if (!nextActiveCompanyId) {
        setProjects([]);
        setGoals([]);
        return;
      }
      const [projectRows, goalRows] = await Promise.all([
        api<Project[]>(`/api/projects?companyId=${nextActiveCompanyId}`),
        api<Goal[]>(`/api/goals?companyId=${nextActiveCompanyId}`),
      ]);
      setProjects(projectRows);
      setGoals(goalRows);
      setSelectedProjectId((current) => current === '__none' || projectRows.some((project) => project.id === current) ? current : projectRows[0]?.id ?? '__none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    }
  }

  useEffect(() => {
    setCompanyId(lockedCompanyId ?? '');
    resetProjectDraft();
    void refresh(lockedCompanyId ?? companyId);
  }, [lockedCompanyId]);

  async function addProject() {
    if (!activeCompanyId || !projectName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const payload = projectPayload();
      if (!payload) return;
      const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ companyId: activeCompanyId, ...payload }) });
      setToast('Project added');
      setSelectedProjectId(project.id);
      await refresh(activeCompanyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project');
    } finally {
      setBusy(false);
    }
  }

  async function saveProject() {
    if (!selectedProject || !projectName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const payload = projectPayload();
      if (!payload) return;
      await api<Project>(`/api/projects/${selectedProject.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      setToast('Project saved');
      await refresh(activeCompanyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project');
    } finally {
      setBusy(false);
    }
  }

  async function addGoal() {
    if (!activeCompanyId || !selectedProject || !goalTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api<Goal>('/api/goals', { method: 'POST', body: JSON.stringify({ companyId: activeCompanyId, projectId: selectedProject.id, title: goalTitle.trim(), body: goalBody }) });
      setGoalTitle('');
      setGoalBody('');
      setToast('Project goal added');
      await refresh(activeCompanyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add goal');
    } finally {
      setBusy(false);
    }
  }

  return <div className={`project-console ${compact ? 'project-console-compact' : ''}`}>
    {showPageHead && <div className="page-head"><div><h1>{heading}</h1><p>{description}</p></div></div>}
    {!showPageHead && heading !== 'Projects' && <div className="panel-title project-inline-title"><div><h2>{heading}</h2><span className="status-pill">top-level project controls</span></div></div>}
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}
    {!lockedCompanyId && <label className="field-label project-company-selector">Company<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); resetProjectDraft(); void refresh(event.target.value); }}>
      {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </select></label>}
    {!activeCompanyId && <section className="card section-card"><p className="chat-empty">Create a company before adding projects.</p></section>}
    {activeCompanyId && <section className="card project-workbench">
      <aside className="project-rail">
        <div className="panel-title"><div><h2><BriefcaseBusiness size={18} /> {activeCompany?.name ?? 'Company'} Projects</h2><span className="status-pill">{companyProjects.length} projects</span></div></div>
        <button className={`list-row selectable-row ${selectedProjectId === '__none' ? 'active' : ''}`} onClick={resetProjectDraft}>
          <b>New project</b>
          <p>Create a project record with repo, work path, branch policy, and runtime commands.</p>
        </button>
        <div className="table-list">
          {companyProjects.map((project) => <button className={`list-row selectable-row ${project.id === selectedProjectId ? 'active' : ''}`} key={project.id} onClick={() => setSelectedProjectId(project.id)}>
            <b>{project.name}</b>
            <p>{project.repoUrl || project.workPath || project.description || 'No repository configured'}</p>
          </button>)}
          {companyProjects.length === 0 && <p className="chat-empty">No projects yet.</p>}
        </div>
      </aside>

      <main className="project-editor-panel">
        <div className="project-editor-head">
          <div><h2><FolderGit2 size={18} /> {selectedProject ? selectedProject.name : 'New Project'}</h2><span className="status-pill">{selectedProject ? 'editing authority' : 'create authority'}</span></div>
          {selectedProject
            ? <button className="btn btn-primary" disabled={busy || !projectName.trim()} onClick={saveProject}><Save size={15} /> Save project</button>
            : <button className="btn btn-primary" disabled={busy || !projectName.trim()} onClick={addProject}><Plus size={15} /> Add project</button>}
        </div>

        <section className="project-section">
          <h3>Identity</h3>
          <div className="project-form-grid">
            <label className="field-label">Project name<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
            <label className="field-label">Runtime-local path hint<input className="input" value={workspacePathHint} onChange={(event) => setWorkspacePathHint(event.target.value)} placeholder="Optional runtime-local clone/folder hint only" /></label>
          </div>
          <label className="field-label">Description<textarea className="input" rows={3} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
        </section>

        <section className="project-section">
          <h3><GitBranch size={16} /> Repository Authority</h3>
          <div className="project-form-grid">
            <label className="field-label">Repo provider<select className="input" value={repoProvider} onChange={(event) => setRepoProvider(event.target.value as typeof repoProvider)}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="gitea">Gitea</option>
              <option value="generic">Generic Git</option>
            </select></label>
            <label className="field-label">Default branch<input className="input" value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></label>
            <label className="field-label field-wide">Repository URL<input className="input" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/repo" /></label>
            <label className="field-label field-wide">Project work path<input className="input" value={workPath} onChange={(event) => setWorkPath(event.target.value)} placeholder="Repo/workspace-relative path, e.g. apps/server or reports/final" /></label>
            <label className="field-label">Protected branches<input className="input" value={protectedBranches} onChange={(event) => setProtectedBranches(event.target.value)} placeholder="main, master, production" /></label>
            <label className="field-label field-wide">Work branch pattern<input className="input" value={workBranchPattern} onChange={(event) => setWorkBranchPattern(event.target.value)} /></label>
          </div>
          <div className="project-toggle-grid">
            <label className="check-row"><input type="checkbox" checked={pullBeforeRun} onChange={(event) => setPullBeforeRun(event.target.checked)} /> Pull before every run</label>
            <label className="check-row"><input type="checkbox" checked={pushAfterRun} onChange={(event) => setPushAfterRun(event.target.checked)} /> Push after completion</label>
          </div>
          <label className="field-label">Completion policy<select className="input" value={completionPolicy} onChange={(event) => setCompletionPolicy(event.target.value as typeof completionPolicy)}>
            <option value="push_or_pr">Push branch or PR</option>
            <option value="pull_request">Pull request</option>
            <option value="push_branch">Push branch</option>
            <option value="manual">Manual evidence</option>
          </select></label>
        </section>

        <section className="project-section">
          <h3>Runtime Commands</h3>
          <div className="project-form-grid">
            <label className="field-label">Setup command<textarea className="input" rows={2} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} /></label>
            <label className="field-label">Test command<textarea className="input" rows={2} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} /></label>
          </div>
          <label className="field-label">Runtime services JSON<textarea className="input" rows={4} value={runtimeServicesJson} onChange={(event) => setRuntimeServicesJson(event.target.value)} placeholder='{"postgres":"postgres://...","web":"http://localhost:3000"}' /></label>
        </section>

        <section className="project-section">
          <h3><Target size={16} /> Project Goals</h3>
          <div className="project-form-grid">
            <label className="field-label">Goal title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedProject} /></label>
            <label className="field-label">Goal body<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedProject} /></label>
          </div>
          <button className="btn" disabled={busy || !selectedProject || !goalTitle.trim()} onClick={addGoal}><Plus size={15} /> Add project goal</button>
          <div className="table-list">
            {selectedProjectGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}
            {selectedProject && selectedProjectGoals.length === 0 && <p className="chat-empty">No project goals yet.</p>}
            {!selectedProject && <p className="chat-empty">Save or select a project before adding goals.</p>}
          </div>
        </section>
      </main>
    </section>}
  </div>;
}
