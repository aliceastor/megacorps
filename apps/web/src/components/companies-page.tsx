'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Save, Target, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { CompanySetup } from './company-setup';
import { useLocale } from '@/lib/locale-context';

type Company = { setupDraft?: { completed?: boolean }; id: string; name: string; slug: string; mission?: string | null; bossRolePrompt?: string | null; nfsShareUrl?: string | null; panelReviewDefault?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean; createdAt?: string };
// When a single-mode card still gets a blind review panel (§17): critical cards only (default), every card, or never.
type PanelReviewDefault = 'critical_only' | 'always' | 'never';
const PANEL_REVIEW_DEFAULTS: PanelReviewDefault[] = ['critical_only', 'always', 'never'];

function panelReviewDefaultOf(value: string | null | undefined): PanelReviewDefault {
  return PANEL_REVIEW_DEFAULTS.includes(value as PanelReviewDefault) ? (value as PanelReviewDefault) : 'critical_only';
}
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = { id: string; companyId: string };
type Project = { id: string; companyId: string };
type Card = { id: string; companyId: string };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string; body?: string | null };
type Membership = { companyId: string; role: 'viewer' | 'operator' | 'admin'; status?: string };
type Me = { user?: { id:string; role:string }; memberships: Membership[] };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formatBlocking(blocking: unknown): string {
  if (!blocking || typeof blocking !== 'object') return '';
  return Object.entries(blocking as Record<string, unknown>)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${key}: ${count}`)
    .join(', ');
}

function companyDeleteErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError && error.data && typeof error.data === 'object') {
    const data = error.data as { error?: unknown; blocking?: unknown; requiredRole?: unknown };
    if (data.error === 'company_not_empty') {
      const blocking = formatBlocking(data.blocking);
      return `${t('companies.deleteBlocked')}${blocking ? ` (${blocking})` : ''}`;
    }
    if (data.error === 'company_role_required') return t('companies.deleteRoleRequired');
    if (data.error === 'company_access_denied') return t('companies.deleteAccessDenied');
  }
  return error instanceof Error ? error.message : t('companies.deleteFailed');
}

export function CompaniesPage() {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/api/companies') });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/api/departments') });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') });
  const cardsQuery = useQuery({ queryKey: ['cards'], queryFn: () => api<Card[]>('/api/cards') });
  const goalsQuery = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
  const meQuery = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  const [companyId, setCompanyId] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCompanyId, setSetupCompanyId] = useState<string>();
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('setup'); if (id) { setSetupCompanyId(id); setSetupOpen(true); } }, []);
  const readinessQuery = useQuery({ queryKey: ['company-execution-readiness', companyId], enabled: Boolean(companyId), queryFn: () => api<{ ready: boolean; issues: string[]; setupIssues: string[]; runtimeIssues: string[] }>(`/api/companies/${companyId}/execution-readiness`) });
  const [companyName, setCompanyName] = useState('');
  const [companySlug, setCompanySlug] = useState('');
  const [mission, setMission] = useState('');
  const [bossRolePrompt, setBossRolePrompt] = useState('');
  const [nfsShareUrl, setNfsShareUrl] = useState('');
  const [dispatchInterval, setDispatchInterval] = useState(10);
  const [autoDispatch, setAutoDispatch] = useState(false);
  const [panelReviewDefault, setPanelReviewDefault] = useState<PanelReviewDefault>('critical_only');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const companyNameRef = useRef<HTMLInputElement>(null);

  const companies = companiesQuery.data ?? [];
  const departments = departmentsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const cards = cardsQuery.data ?? [];
  const goals = goalsQuery.data ?? [];
  const memberships = meQuery.data?.memberships ?? [];
  const loadError = companiesQuery.error ?? departmentsQuery.error ?? agentsQuery.error ?? projectsQuery.error ?? cardsQuery.error ?? goalsQuery.error ?? meQuery.error;
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const selectedDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const selectedAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedProjects = useMemo(() => projects.filter((project) => project.companyId === companyId), [projects, companyId]);
  const selectedCards = useMemo(() => cards.filter((card) => card.companyId === companyId), [cards, companyId]);
  const companyGoals = useMemo(() => goals.filter((goal) => goal.companyId === companyId && !goal.departmentId && !goal.projectId), [goals, companyId]);
  const selectedCompanyRole = memberships.find((membership) => membership.companyId === companyId && membership.status !== 'disabled')?.role ?? null;
  const canDeleteSelectedCompany = selectedCompanyRole === 'admin';
  const deleteCompanyTitle = !selectedCompany
    ? t('companies.selectFirst')
    : canDeleteSelectedCompany
      ? t('companies.deleteCompany')
      : t('companies.requiresAdmin');

  async function refreshQueries() {
    await Promise.all([['companies'], ['departments'], ['agents'], ['projects'], ['cards'], ['goals'], ['me']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  useEffect(() => {
    if (!companiesQuery.data) return;
    const activeCompany = companiesQuery.data.find((company) => company.id === companyId) ?? companiesQuery.data[0];
    if (activeCompany) selectCompany(activeCompany);
    else { startNewCompany(false); setSetupOpen(true); }
  }, [companiesQuery.data]);
  useEffect(() => {
    if (loadError) setError(loadError instanceof Error ? loadError.message : t('companies.loadFailed'));
  }, [loadError]);
  useEffect(() => { if (!selectedCompany) setCompanySlug(slugify(companyName)); }, [companyName, selectedCompany]);

  function selectCompany(company: Company) {
    setCompanyId(company.id);
    setCompanyName(company.name);
    setCompanySlug(company.slug);
    setMission(company.mission ?? '');
    setBossRolePrompt(company.bossRolePrompt ?? '');
    setNfsShareUrl(company.nfsShareUrl ?? '');
    setDispatchInterval(company.dispatchIntervalSeconds ?? 10);
    setAutoDispatch(company.autoDispatchEnabled !== false);
    setPanelReviewDefault(panelReviewDefaultOf(company.panelReviewDefault));
    setError('');
  }

  function startNewCompany(focus = true) {
    setCompanyId('');
    setCompanyName('');
    setCompanySlug('');
    setMission('');
    setBossRolePrompt('');
    setNfsShareUrl('');
    setDispatchInterval(10);
    setAutoDispatch(false);
    setPanelReviewDefault('critical_only');
    setGoalTitle('');
    setGoalBody('');
    setError('');
    if (focus) window.setTimeout(() => companyNameRef.current?.focus(), 0);
  }

  async function saveCompany() {
    if (!companyName.trim() || !companySlug.trim()) {
      setError(t('companies.nameSlugRequired'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: companyName.trim(),
        slug: companySlug.trim(),
        mission,
        bossRolePrompt: bossRolePrompt.trim() || null,
        nfsShareUrl: nfsShareUrl.trim() || null,
        panelReviewDefault,
        dispatchIntervalSeconds: dispatchInterval,
        autoDispatchEnabled: autoDispatch,
      };
      const saved = selectedCompany
        ? await api<Company>(`/api/companies/${selectedCompany.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api<Company>('/api/companies', { method: 'POST', body: JSON.stringify(payload) });
      setToast(selectedCompany ? t('companies.saved') : t('companies.created'));
      selectCompany(saved);
      await refreshQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('companies.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  const deletionPreview = useQuery({ queryKey: ['company-deletion-preview',companyId], enabled: Boolean(companyId && canDeleteSelectedCompany), queryFn: () => api<{canDelete:boolean;blocking:Record<string,number>;inventory:Record<string,{count:number;ids:string[]}>}>(`/api/companies/${companyId}/deletion-preview`) });
  async function deleteCompany() {
    if (!selectedCompany) return;
    const preview = await deletionPreview.refetch();
    if (!preview.data?.canDelete) { setError(preview.error ? companyDeleteErrorMessage(preview.error,t) : `${t('companies.deleteBlocked')} (${formatBlocking(preview.data?.blocking)})`); return; }
    if (!window.confirm(`${t('companies.deleteCompany')} "${selectedCompany.name}"? ${t('companies.deleteConfirmDetail')}`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/companies/${selectedCompany.id}`, { method: 'DELETE' });
      setToast(t('companies.deleted'));
      await refreshQueries();
    } catch (err) {
      setError(companyDeleteErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function addCompanyGoal() {
    if (!selectedCompany || !goalTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api<Goal>('/api/goals', { method: 'POST', body: JSON.stringify({ companyId: selectedCompany.id, title: goalTitle.trim(), body: goalBody }) });
      setGoalTitle('');
      setGoalBody('');
      setToast(t('companies.goalAdded'));
      await refreshQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('companies.goalAddFailed'));
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-stack companies-page">
    <div className="page-head">
      <div><h1>{t('title.companies')}</h1><p>{t('companies.subtitle')}</p></div>
      {!setupOpen && <button className="btn btn-primary" onClick={() => { setSetupCompanyId(undefined); setSetupOpen(true); window.history.replaceState(null,'','?setup=new'); }}><Plus size={15} /> {t('setup.start')}</button>}
    </div>
    {!setupOpen && selectedCompany && ((selectedCompany.setupDraft && !selectedCompany.setupDraft.completed) || readinessQuery.data?.ready === false) && <button className="btn" onClick={() => { setSetupCompanyId(selectedCompany.id); setSetupOpen(true); window.history.replaceState(null,'', '?setup='+selectedCompany.id); }}>{t('setup.resume')}</button>}
    {setupOpen && meQuery.data?.user && <CompanySetup key={setupCompanyId ?? 'new'} initialCompanyId={setupCompanyId === 'new' ? undefined : setupCompanyId} userId={meQuery.data.user.id} onSaved={() => { void refreshQueries(); }} onClose={() => { setSetupOpen(false); window.history.replaceState(null,'',window.location.pathname); }} />}
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    {!setupOpen && canDeleteSelectedCompany && <details className="card section-card"><summary>{t('setup.deletionPreview')}</summary>{deletionPreview.error && <p role="alert">{companyDeleteErrorMessage(deletionPreview.error,t)}</p>}<p>{deletionPreview.data?.canDelete ? t('setup.deletionEmpty') : formatBlocking(deletionPreview.data?.blocking)}</p>{Object.entries(deletionPreview.data?.inventory ?? {}).filter(([,row]) => row.count>0).map(([table,row])=><details key={table}><summary>{table}: {row.count}</summary><p style={{overflowWrap:'anywhere'}}>{row.ids.join(', ')}</p></details>)}</details>}
    {!setupOpen && <div className="split-layout company-workbench">
      <aside className="card section-card">
        <div className="panel-title"><h2>{t('companies.list')}</h2><span className="status-pill">{companies.length}</span></div>
        <div className="table-list">
          {companies.map((company) => <button className="list-row selectable-row" key={company.id} style={{ borderColor: company.id === companyId ? 'var(--primary)' : 'var(--border)' }} onClick={() => selectCompany(company)}>
            <b>{company.name}</b>
            <p>{company.slug}</p>
          </button>)}
          {companies.length === 0 && <p className="chat-empty">{t('companies.empty')}</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title">
            <div><h2>{selectedCompany ? t('companies.editor') : t('companies.newCompany')}</h2><span className="status-pill">{selectedCompany ? selectedCompany.slug : t('companies.draft')}</span></div>
            <Building2 size={18} />
          </div>
          <div className="form-grid">
            <label className="field-label">{t('companies.companyName')}<input ref={companyNameRef} className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
            <label className="field-label">{t('common.slug')}<input className="input" value={companySlug} onChange={(event) => setCompanySlug(slugify(event.target.value))} /></label>
            <label className="field-label">{t('companies.dispatchIntervalSeconds')}<input className="input" type="number" min={5} max={3600} value={dispatchInterval} onChange={(event) => setDispatchInterval(Number(event.target.value))} /></label>
            <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={autoDispatch} onChange={(event) => setAutoDispatch(event.target.checked)} /> {t('companies.autoDispatchTodo')}</label>
          </div>
          <label className="field-label">Boss role instructions (optional)<textarea className="input" rows={4} maxLength={8000} value={bossRolePrompt} onChange={event => setBossRolePrompt(event.target.value)} /><span className="field-hint">Adds company-specific responsibilities to the strategy-only Boss role. Platform delegation and approval gates remain required.</span></label>
          {readinessQuery.data && <div className="notice" role="status"><strong>{readinessQuery.data.ready ? 'Company structure and runtimes are ready' : 'Company execution needs setup'}</strong>{[...new Set([...readinessQuery.data.issues, ...readinessQuery.data.runtimeIssues, ...readinessQuery.data.setupIssues])].map(issue => <p key={issue}>{issue}</p>)}<p>Repository write capability is checked separately for the selected worker and project.</p></div>}
          <label className="field-label">{t('companies.mission')}<textarea className="input" rows={4} value={mission} onChange={(event) => setMission(event.target.value)} /></label>
          <label className="field-label">NFS share URL
            <span className="field-hint">Informational: where the company shared root export lives (e.g. nfs://nas/megacorps). Each runtime records its own local mount point in Settings.</span>
            <input className="input" value={nfsShareUrl} onChange={(event) => setNfsShareUrl(event.target.value)} />
          </label>
          <label className="field-label">{t('companies.panelReviewDefault')}
            <span className="field-hint">{t('companies.panelReviewDefaultHint')}</span>
            <select className="input" value={panelReviewDefault} onChange={(event) => setPanelReviewDefault(panelReviewDefaultOf(event.target.value))}>
              <option value="critical_only">{t('companies.panelCriticalOnly')}</option>
              <option value="always">{t('companies.panelAlways')}</option>
              <option value="never">{t('companies.panelNever')}</option>
            </select>
          </label>
          <div className="action-row">
            <button className="btn btn-primary" disabled={busy || !companyName.trim() || !companySlug.trim()} onClick={saveCompany}><Save size={15} /> {t('companies.saveCompany')}</button>
            <button className="btn" disabled={busy || !selectedCompany || !canDeleteSelectedCompany} title={deleteCompanyTitle} onClick={deleteCompany} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> {t('companies.deleteCompany')}</button>
          </div>
        </section>

        <section className="stat-grid company-stats-grid" aria-label={t('companies.selectedSummary')}>
          <div className="card stat-card"><span>{t('nav.departments')}</span><b>{selectedDepartments.length}</b></div>
          <div className="card stat-card"><span>{t('common.agents')}</span><b>{selectedAgents.length}</b></div>
          <div className="card stat-card"><span>{t('nav.projects')}</span><b>{selectedProjects.length}</b></div>
          <div className="card stat-card"><span>{t('companies.kanbanCards')}</span><b>{selectedCards.length}</b></div>
        </section>

        <section className="card section-card company-goal-card">
          <div className="panel-title"><div><h2>{t('companies.goals')}</h2><span className="status-pill">{companyGoals.length} {t('companies.goalsCount')}</span></div><Target size={18} /></div>
          <label className="field-label">{t('companies.goalTitle')}<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedCompany} /></label>
          <label className="field-label">{t('companies.goalBody')}<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedCompany} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedCompany || !goalTitle.trim()} onClick={addCompanyGoal}><Plus size={15} /> {t('companies.addGoal')}</button>
          <div className="table-list">
            {companyGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || t('companies.noGoalBody')}</p></div>)}
            {selectedCompany && companyGoals.length === 0 && <p className="chat-empty">{t('companies.noGoals')}</p>}
          </div>
        </section>
      </main>
    </div>}
  </div>;
}
