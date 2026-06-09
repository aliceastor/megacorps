'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Plus, Save, Target, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string; mission?: string | null; dispatchIntervalSeconds?: number; autoDispatchEnabled?: boolean; createdAt?: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = { id: string; companyId: string };
type Project = { id: string; companyId: string };
type Card = { id: string; companyId: string };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string; body?: string | null };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companySlug, setCompanySlug] = useState('');
  const [mission, setMission] = useState('');
  const [dispatchInterval, setDispatchInterval] = useState(10);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [goalTitle, setGoalTitle] = useState('');
  const [goalBody, setGoalBody] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const companyNameRef = useRef<HTMLInputElement>(null);

  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const selectedDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const selectedAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedProjects = useMemo(() => projects.filter((project) => project.companyId === companyId), [projects, companyId]);
  const selectedCards = useMemo(() => cards.filter((card) => card.companyId === companyId), [cards, companyId]);
  const companyGoals = useMemo(() => goals.filter((goal) => goal.companyId === companyId && !goal.departmentId && !goal.projectId), [goals, companyId]);

  async function refresh(nextCompanyId = companyId) {
    setError('');
    try {
      const [companyRows, departmentRows, agentRows, projectRows, cardRows, goalRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Department[]>('/api/departments'),
        api<Agent[]>('/api/agents'),
        api<Project[]>('/api/projects'),
        api<Card[]>('/api/cards'),
        api<Goal[]>('/api/goals'),
      ]);
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setAgents(agentRows);
      setProjects(projectRows);
      setCards(cardRows);
      setGoals(goalRows);
      const activeCompany = companyRows.find((company) => company.id === nextCompanyId) ?? companyRows[0];
      if (activeCompany) selectCompany(activeCompany);
      else startNewCompany(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load companies');
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!selectedCompany) setCompanySlug(slugify(companyName)); }, [companyName, selectedCompany]);

  function selectCompany(company: Company) {
    setCompanyId(company.id);
    setCompanyName(company.name);
    setCompanySlug(company.slug);
    setMission(company.mission ?? '');
    setDispatchInterval(company.dispatchIntervalSeconds ?? 10);
    setAutoDispatch(company.autoDispatchEnabled !== false);
    setError('');
  }

  function startNewCompany(focus = true) {
    setCompanyId('');
    setCompanyName('');
    setCompanySlug('');
    setMission('');
    setDispatchInterval(10);
    setAutoDispatch(true);
    setGoalTitle('');
    setGoalBody('');
    setError('');
    if (focus) window.setTimeout(() => companyNameRef.current?.focus(), 0);
  }

  async function saveCompany() {
    if (!companyName.trim() || !companySlug.trim()) {
      setError('Company name and slug are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: companyName.trim(),
        slug: companySlug.trim(),
        mission,
        dispatchIntervalSeconds: dispatchInterval,
        autoDispatchEnabled: autoDispatch,
      };
      const saved = selectedCompany
        ? await api<Company>(`/api/companies/${selectedCompany.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api<Company>('/api/companies', { method: 'POST', body: JSON.stringify(payload) });
      setToast(selectedCompany ? 'Company saved' : 'Company created');
      await refresh(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Company save failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteCompany() {
    if (!selectedCompany) return;
    if (!window.confirm(`Delete company "${selectedCompany.name}"? This only succeeds for an empty company.`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/companies/${selectedCompany.id}`, { method: 'DELETE' });
      setToast('Company deleted');
      await refresh('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Company delete failed');
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
      setToast('Company goal added');
      await refresh(selectedCompany.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goal add failed');
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-stack companies-page">
    <div className="page-head">
      <div><h1>Companies</h1><p>Create, edit, and delete company records. Departments, agents, and org chart live on their own pages.</p></div>
      <button className="btn" onClick={() => startNewCompany()}><Plus size={15} /> New Company</button>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <div className="split-layout company-workbench">
      <aside className="card section-card">
        <div className="panel-title"><h2>Company List</h2><span className="status-pill">{companies.length}</span></div>
        <div className="table-list">
          {companies.map((company) => <button className="list-row selectable-row" key={company.id} style={{ borderColor: company.id === companyId ? 'var(--primary)' : 'var(--border)' }} onClick={() => selectCompany(company)}>
            <b>{company.name}</b>
            <p>{company.slug}</p>
          </button>)}
          {companies.length === 0 && <p className="chat-empty">No companies yet.</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title">
            <div><h2>{selectedCompany ? 'Company Editor' : 'New Company'}</h2><span className="status-pill">{selectedCompany ? selectedCompany.slug : 'draft'}</span></div>
            <Building2 size={18} />
          </div>
          <div className="form-grid">
            <label className="field-label">Company name<input ref={companyNameRef} className="input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></label>
            <label className="field-label">Slug<input className="input" value={companySlug} onChange={(event) => setCompanySlug(slugify(event.target.value))} /></label>
            <label className="field-label">Dispatch interval seconds<input className="input" type="number" min={5} max={3600} value={dispatchInterval} onChange={(event) => setDispatchInterval(Number(event.target.value))} /></label>
            <label className="check-row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={autoDispatch} onChange={(event) => setAutoDispatch(event.target.checked)} /> Auto-dispatch todo tasks</label>
          </div>
          <label className="field-label">Mission<textarea className="input" rows={4} value={mission} onChange={(event) => setMission(event.target.value)} /></label>
          <div className="action-row">
            <button className="btn btn-primary" disabled={busy || !companyName.trim() || !companySlug.trim()} onClick={saveCompany}><Save size={15} /> Save Company</button>
            <button className="btn" disabled={busy || !selectedCompany} onClick={deleteCompany} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> Delete Company</button>
          </div>
        </section>

        <section className="stat-grid company-stats-grid" aria-label="Selected company summary">
          <div className="card stat-card"><span>Departments</span><b>{selectedDepartments.length}</b></div>
          <div className="card stat-card"><span>Agents</span><b>{selectedAgents.length}</b></div>
          <div className="card stat-card"><span>Projects</span><b>{selectedProjects.length}</b></div>
          <div className="card stat-card"><span>Kanban cards</span><b>{selectedCards.length}</b></div>
        </section>

        <section className="card section-card company-goal-card">
          <div className="panel-title"><div><h2>Company Goals</h2><span className="status-pill">{companyGoals.length} goals</span></div><Target size={18} /></div>
          <label className="field-label">Goal title<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedCompany} /></label>
          <label className="field-label">Goal body<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedCompany} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedCompany || !goalTitle.trim()} onClick={addCompanyGoal}><Plus size={15} /> Add Company Goal</button>
          <div className="table-list">
            {companyGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || 'No goal body'}</p></div>)}
            {selectedCompany && companyGoals.length === 0 && <p className="chat-empty">No company goals yet.</p>}
          </div>
        </section>
      </main>
    </div>
  </div>;
}
