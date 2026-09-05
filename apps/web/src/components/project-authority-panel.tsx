'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, FolderGit2, GitBranch, Plus, Save, Target, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Company = { id: string; name: string };
type Project = {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  repoProvider?: 'github' | 'gitlab' | 'gitea' | 'gitea-local' | 'generic' | null;
  publishRepoUrl?: string | null;
  publishToken?: string | null;
  repoUrl?: string | null;
  workPath?: string | null;
  defaultBranch?: string | null;
  protectedBranches?: string[] | null;
  workBranchPattern?: string | null;
  pullBeforeRun?: boolean | null;
  pushAfterRun?: boolean | null;
  completionPolicy?: 'push_branch' | 'pull_request' | 'push_or_pr' | 'manual' | null;
  completionRequiresMerge?: boolean;
  autoMergeAfterApproval?: boolean;
  mergeReadiness?: { ready: boolean; issues: string[]; checkedAt: string } | null;
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

function formatBlocking(blocking: unknown): string {
  if (!blocking || typeof blocking !== 'object') return '';
  return Object.entries(blocking as Record<string, unknown>)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${key}: ${count}`)
    .join(', ');
}

function projectErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.data && typeof error.data === 'object') {
    const data = error.data as { error?: unknown; blocking?: unknown };
    if (data.error === 'project_not_empty') {
      const blocking = formatBlocking(data.blocking);
      return `Project still has linked records${blocking ? ` (${blocking})` : ''}, so it cannot be permanently deleted. Archiving it instead keeps the records and can be undone from Trash.`;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

export function ProjectAuthorityPanel({ lockedCompanyId, heading = 'Projects', description = 'Project CRUD, repository rules, branch policy, work path, and project goals.', compact = false, showPageHead = false }: ProjectAuthorityPanelProps) {
  const { t } = useLocale();
  const refreshVersion = useRef(0);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState(lockedCompanyId ?? '');
  const [selectedProjectId, setSelectedProjectId] = useState('__none');
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [repoProvider, setRepoProvider] = useState<'github' | 'gitlab' | 'gitea' | 'gitea-local' | 'generic'>('github');
  const [publishRepoUrl, setPublishRepoUrl] = useState('');
  const [publishToken, setPublishToken] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [workPath, setWorkPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [protectedBranches, setProtectedBranches] = useState('main, master');
  const [workBranchPattern, setWorkBranchPattern] = useState('megacorps/card-{cardId}-{agentSlug}');
  const [pullBeforeRun, setPullBeforeRun] = useState(true);
  const [pushAfterRun, setPushAfterRun] = useState(true);
  const [completionPolicy, setCompletionPolicy] = useState<'push_branch' | 'pull_request' | 'push_or_pr' | 'manual'>('push_or_pr');
  const [setupCommand, setSetupCommand] = useState('');
  const [completionRequiresMerge, setCompletionRequiresMerge] = useState<boolean | undefined>();
  const [autoMergeAfterApproval, setAutoMergeAfterApproval] = useState<boolean | undefined>();
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
    setPublishRepoUrl('');
    setPublishToken('');
    setRepoUrl('');
    setWorkPath('');
    setDefaultBranch('main');
    setProtectedBranches('main, master');
    setWorkBranchPattern('megacorps/card-{cardId}-{agentSlug}');
    setPullBeforeRun(true);
    setPushAfterRun(true);
    setCompletionPolicy('push_or_pr');
    setCompletionRequiresMerge(undefined);
    setAutoMergeAfterApproval(undefined);
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
    setCompletionRequiresMerge(selectedProject.completionRequiresMerge ?? false);
    setAutoMergeAfterApproval(selectedProject.autoMergeAfterApproval ?? false);
    setSetupCommand(selectedProject.setupCommand ?? '');
    setTestCommand(selectedProject.testCommand ?? '');
    setRuntimeServicesJson(JSON.stringify(selectedProject.runtimeServices ?? {}, null, 2));
    setWorkspacePathHint(selectedProject.workspacePathHint ?? '');
    setPublishRepoUrl(selectedProject.publishRepoUrl ?? '');
    setPublishToken(selectedProject.publishToken ?? '');
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
      completionRequiresMerge,
      autoMergeAfterApproval,
      setupCommand: setupCommand || null,
      testCommand: testCommand || null,
      runtimeServices,
      workspacePathHint: workspacePathHint || null,
      publishRepoUrl: publishRepoUrl || null,
      publishToken: publishToken || null,
    };
  }

  async function refresh(nextCompanyId = activeCompanyId) {
    const version = ++refreshVersion.current;
    setError('');
    try {
      const companyRows = await api<Company[]>('/api/companies');
      if (version !== refreshVersion.current) return;
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
      if (version !== refreshVersion.current) return;
      setProjects(projectRows);
      setGoals(goalRows);
      setSelectedProjectId((current) => current === '__none' || projectRows.some((project) => project.id === current) ? current : '__none');
    } catch (err) {
      if (version !== refreshVersion.current) return;
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
      setProjects(current => [...current.filter(row => row.id !== project.id), project]);
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

  async function deleteProject() {
    if (!selectedProject) return;
    if (!window.confirm(`Delete project "${selectedProject.name}"? Cards, work products, chat sessions, and cost history must be empty.`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${selectedProject.id}`, { method: 'DELETE' });
      setToast('Project deleted');
      resetProjectDraft();
      await refresh(activeCompanyId);
    } catch (err) {
      setError(projectErrorMessage(err, 'Failed to delete project'));
    } finally {
      setBusy(false);
    }
  }

  async function addGoal() {
    if (!activeCompanyId || !selectedProject || !goalTitle.trim()) return;
    if (goalTitle.trim().length > 160 || goalBody.length > 4000) { setError(t('forms.goalLength')); return; }
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
    {!lockedCompanyId && <label className="field-label project-company-selector">Company<select className="input compact" disabled={busy} value={companyId} onChange={(event) => { setCompanyId(event.target.value); resetProjectDraft(); void refresh(event.target.value); }}>
      {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </select></label>}
    {!activeCompanyId && <section className="card section-card"><p className="chat-empty">Create a company before adding projects.</p></section>}
    {activeCompanyId && <section className="card project-workbench">
      <aside className="project-rail">
        <div className="panel-title"><div><h2><BriefcaseBusiness size={18} /> {activeCompany?.name ?? 'Company'} Projects</h2><span className="status-pill">{companyProjects.length} projects</span></div></div>
        <button type="button" disabled={busy} className={`list-row selectable-row ${selectedProjectId === '__none' ? 'active' : ''}`} onClick={resetProjectDraft}>
          <b>New project</b>
          <p>{t('forms.projectIntro')}</p>
        </button>
        <div className="table-list">
          {companyProjects.map((project) => <button type="button" disabled={busy} className={`list-row selectable-row ${project.id === selectedProjectId ? 'active' : ''}`} key={project.id} onClick={() => setSelectedProjectId(project.id)}>
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
            ? <div className="action-row">
              <button className="btn" disabled={busy} onClick={deleteProject} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> Delete project</button>
              <button className="btn btn-primary" disabled={busy || !projectName.trim()} onClick={saveProject}><Save size={15} /> Save project</button>
            </div>
            : <button className="btn btn-primary" disabled={busy || !projectName.trim()} onClick={addProject}><Plus size={15} /> Add project</button>}
        </div>

        <section className="project-section">
          <h3>Project basics</h3>
          <div className="project-form-grid">
            <label className="field-label">Project name<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
          </div>
          <label className="field-label">Description<textarea className="input" rows={3} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
            <label className="field-label field-wide">Repository URL<input className="input" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder={repoProvider === 'gitea-local' ? 'Leave empty — the built-in Gitea repo is created and filled in automatically' : 'https://github.com/org/repo'} /></label>
        </section>

        {(completionRequiresMerge ?? repoProvider === 'gitea-local') && <p role="status">{t('forms.mergeRequired')} {(autoMergeAfterApproval ?? (repoProvider === 'gitea-local' && !repoUrl)) ? t('forms.mergeAutomatic') : t('forms.mergeManual')}</p>}
        {selectedProject?.autoMergeAfterApproval && <p role="status">{selectedProject.mergeReadiness?.ready ? t('forms.protectionReady') : t('forms.protectionRequired')} {selectedProject.mergeReadiness?.issues.join(' ')}</p>}
        <details className="project-advanced">
          <summary>{t('forms.advanced')}</summary>
          <p className="field-hint">{t('forms.projectAdvancedHelp')}</p>
        <section className="project-section">
          <h3><GitBranch size={16} /> Repository Authority</h3>
          <div className="project-form-grid">
            <label className="field-label">Repo provider<select className="input" value={repoProvider} onChange={(event) => setRepoProvider(event.target.value as typeof repoProvider)}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="gitea">Gitea (external)</option>
              <option value="gitea-local">Gitea (built-in, auto-provisioned)</option>
              <option value="generic">Generic Git</option>
            </select></label>
            <label className="field-label">Default branch<input className="input" value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></label>
            <label className="field-label">Runtime-local path hint<input className="input" value={workspacePathHint} onChange={(event) => setWorkspacePathHint(event.target.value)} placeholder="Optional runtime-local clone/folder hint only" /></label>
            <label className="field-label field-wide">Publish repo URL<input className="input" value={publishRepoUrl} onChange={(event) => setPublishRepoUrl(event.target.value)} placeholder="Optional, e.g. a GitHub Pages repo the agent pushes publishable output to" /></label>
            <label className="field-label field-wide">Publish token<input className="input" type="password" value={publishToken} onChange={(event) => setPublishToken(event.target.value)} placeholder="Optional token injected into task prompts for the publish push" /></label>
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
          <details><summary>Advanced merge policy</summary>
            <label className="field-label"><input type="checkbox" checked={completionRequiresMerge ?? repoProvider === 'gitea-local'} onChange={(event) => { setCompletionRequiresMerge(event.target.checked); if (!event.target.checked) setAutoMergeAfterApproval(false); }} /> Require verified merge before completion</label>
            <label className="field-label"><input type="checkbox" checked={autoMergeAfterApproval ?? (repoProvider === 'gitea-local' && !repoUrl)} onChange={(event) => { setAutoMergeAfterApproval(event.target.checked); if (event.target.checked) setCompletionRequiresMerge(true); }} /> Let MegaCorps merge after all approvals</label>
            <p>Managed Gitea projects use the server identity to merge the exact approved head. Save to verify branch protection. Disable automatic merge to keep manual merging.</p>
          </details>
        </section>

        <section className="project-section">
          <h3>Runtime Commands</h3>
          <div className="project-form-grid">
            <label className="field-label">Setup command<textarea className="input" rows={2} value={setupCommand} onChange={(event) => setSetupCommand(event.target.value)} /></label>
            <label className="field-label">Test command<textarea className="input" rows={2} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} /></label>
          </div>
          <label className="field-label">Runtime services JSON<textarea className="input" rows={4} value={runtimeServicesJson} onChange={(event) => setRuntimeServicesJson(event.target.value)} placeholder='{"postgres":"postgres://...","web":"http://localhost:3000"}' /></label>
        </section>

        </details>

        <section className="project-section">
          <h3><Target size={16} /> Project Goals</h3>
          {!selectedProject && <p className="field-hint">{t('forms.saveProjectFirst')}</p>}
          <div className="project-form-grid">
            <label className="field-label field-wide">Goal title<input className="input" required maxLength={160} value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedProject || busy} /></label>
            <label className="field-label field-wide">Goal body<textarea className="input" maxLength={4000} rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedProject || busy} /></label>
          </div>
          <button className="btn" disabled={busy || !selectedProject || !goalTitle.trim()} onClick={addGoal}><Plus size={15} /> Add project goal</button>
          <div className="table-list">
            {selectedProjectGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}
            {selectedProject && selectedProjectGoals.length === 0 && <p className="chat-empty">No project goals yet.</p>}
          </div>
        </section>
      </main>
    </section>}
  </div>;
}
