'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Target, Users, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Agent = { id: string; companyId: string; departmentId?: string | null; bossId?: string | null; name: string; role: string; adapterType?: string | null; isActive?: boolean; isBusy?: boolean };
type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string; body?: string | null };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function DepartmentsPage() {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/api/companies') });
  const departmentsQuery = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/api/departments') });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') });
  const goalsQuery = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
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

  const companies = companiesQuery.data ?? [];
  const departments = departmentsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const goals = goalsQuery.data ?? [];
  const loadError = companiesQuery.error ?? departmentsQuery.error ?? agentsQuery.error ?? goalsQuery.error;
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedDepartment = departmentId === '__unassigned' ? null : companyDepartments.find((department) => department.id === departmentId) ?? companyDepartments[0] ?? null;
  const unassignedAgents = companyAgents.filter((agent) => !agent.departmentId);
  const selectedAgent = companyAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const departmentGoals = useMemo(() => goals.filter((goal) => goal.departmentId === selectedDepartment?.id), [goals, selectedDepartment?.id]);

  async function refreshQueries() {
    await Promise.all([['companies'], ['departments'], ['agents'], ['goals']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  useEffect(() => {
    if (!companiesQuery.data || !departmentsQuery.data) return;
    const activeCompanyId = companiesQuery.data.some((company) => company.id === companyId) ? companyId : companiesQuery.data[0]?.id ?? '';
    const activeDepartments = departmentsQuery.data.filter((department) => department.companyId === activeCompanyId);
    setCompanyId(activeCompanyId);
    setDepartmentId(activeDepartments.some((department) => department.id === departmentId) ? departmentId : activeDepartments[0]?.id ?? '');
  }, [companiesQuery.data, departmentsQuery.data]);
  useEffect(() => {
    if (loadError) setError(loadError instanceof Error ? loadError.message : t('departments.loadFailed'));
  }, [loadError]);
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
      setToast(t('departments.added'));
      await refreshQueries();
      setDepartmentId(department.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('departments.addFailed'));
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
      setToast(t('departments.goalAdded'));
      await refreshQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('departments.goalAddFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function updateAgentOrg(agent: Agent, patch: Pick<Agent, 'departmentId' | 'bossId'>) {
    setBusyAgentId(agent.id);
    setError('');
    try {
      const updated = await api<Agent>(`/api/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((item) => item.id === updated.id ? updated : item));
      setSelectedAgentId(updated.id);
      setToast(`${updated.name} ${t('departments.agentUpdated')}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('departments.agentUpdateFailed'));
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
      <div><h1>{t('title.departments')}</h1><p>{t('departments.subtitle')}</p></div>
      <button className="btn" disabled={!companyId} title={companyId ? t('departments.createDepartment') : t('departments.createCompanyFirst')} onClick={startNewDepartment}><Plus size={15} /> {t('departments.newDepartment')}</button>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    {departmentCreateOpen && <div className="overlay">
      <section className="card modal department-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-department-title">
        <div className="panel-title">
          <div><h2 id="new-department-title">{t('departments.newDepartment')}</h2><span className="status-pill">{companies.find((company) => company.id === companyId)?.name ?? t('departments.noCompany')}</span></div>
          <button className="btn icon-btn" aria-label={t('common.close')} onClick={() => setDepartmentCreateOpen(false)}><X size={16} /></button>
        </div>
        <div className="form-grid">
          <label className="field-label">{t('common.company')}<select className="input" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(''); setError(''); void refreshQueries(); }}>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select></label>
          <label className="field-label">{t('departments.departmentName')}<input className="input" value={deptName} onChange={(event) => setDeptName(event.target.value)} disabled={!companyId} /></label>
          <label className="field-label">{t('common.slug')}<input className="input" value={deptSlug} onChange={(event) => setDeptSlug(slugify(event.target.value))} disabled={!companyId} /></label>
        </div>
        <div className="action-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setDepartmentCreateOpen(false)}>{t('common.cancel')}</button>
          <button className="btn btn-primary" title={companyId ? t('departments.addDepartment') : t('departments.createCompanyFirstHint')} disabled={addDepartmentDisabled} onClick={addDepartment}><Plus size={14} /> {t('departments.addDepartment')}</button>
        </div>
      </section>
    </div>}

    <div className="department-workbench">
      <aside className="card section-card department-rail">
        <div className="panel-title"><h2>{t('title.departments')}</h2><span className="status-pill">{companyDepartments.length}</span></div>
        <label className="field-label">{t('common.company')}<select className="input compact" value={companyId} onChange={(event) => { setCompanyId(event.target.value); setDepartmentId(''); setError(''); void refreshQueries(); }}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        <div className="table-list">
          {companyDepartments.map((department) => <button className={`list-row selectable-row ${department.id === selectedDepartment?.id ? 'active' : ''}`} key={department.id} onClick={() => setDepartmentId(department.id)}>
            <b>{department.name}</b>
            <p>{department.slug} / {companyAgents.filter((agent) => agent.departmentId === department.id).length} {t('departments.agentsCount')}</p>
          </button>)}
          <button className={`list-row selectable-row ${departmentId === '__unassigned' ? 'active' : ''}`} onClick={() => setDepartmentId('__unassigned')}>
            <b>{t('common.noDepartment')}</b>
            <p>{unassignedAgents.length} {t('departments.agentsCount')}</p>
          </button>
          {companyDepartments.length === 0 && <p className="chat-empty">{t('departments.empty')}</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title"><div><h2><Users size={18} /> {t('departments.memberAssignment')}</h2><span className="status-pill">{companyAgents.length} {t('departments.companyAgentsCount')}</span></div></div>
          <div className="table-wrap">
            <table className="data-table org-assignment-table">
              <thead><tr><th>{t('common.agent')}</th><th>{t('common.department')}</th><th>{t('common.reportsTo')}</th><th>{t('common.status')}</th></tr></thead>
              <tbody>
                {companyAgents.map((agent) => <tr key={agent.id}>
                  <td><button type="button" className="text-button agent-name-button" onClick={() => setSelectedAgentId(agent.id)}><b>{agent.name}</b><small>{agent.role} / {agent.adapterType ?? 'hermes-ssh'}</small></button></td>
                  <td><select className="input compact" disabled={busyAgentId === agent.id} value={agent.departmentId ?? ''} onChange={(event) => void updateAgentOrg(agent, { departmentId: event.target.value || null })}>
                    <option value="">{t('common.noDepartment')}</option>
                    {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select></td>
                  <td><select className="input compact" disabled={busyAgentId === agent.id} value={agent.bossId ?? ''} onChange={(event) => void updateAgentOrg(agent, { bossId: event.target.value || null })}>
                    <option value="">{t('departments.topLevelAgent')}</option>
                    {companyAgents.filter((candidate) => candidate.id !== agent.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select></td>
                  <td><span className="badge">{agent.isBusy ? t('common.busy') : agent.isActive === false ? t('common.offline') : t('common.ready')}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {companyAgents.length === 0 && <p className="chat-empty">{t('chat.noAgents')}</p>}
        </section>

        {selectedAgent && <section className="card section-card agent-inline-editor">
          <div className="panel-title"><div><h2><Pencil size={18} /> {t('departments.agentEditor')}</h2><span className="status-pill">{selectedAgent.name}</span></div></div>
          <div className="agent-editor-summary">
            <b>{selectedAgent.role}</b>
            <span>{selectedAgent.adapterType ?? 'hermes-ssh'} / {selectedAgent.isBusy ? t('common.busy') : selectedAgent.isActive === false ? t('common.offline') : t('common.ready')}</span>
          </div>
          <div className="form-grid department-agent-edit-grid">
            <label className="field-label">{t('common.department')}<select className="input compact" disabled={busyAgentId === selectedAgent.id} value={selectedAgent.departmentId ?? ''} onChange={(event) => void updateAgentOrg(selectedAgent, { departmentId: event.target.value || null })}>
              <option value="">{t('common.noDepartment')}</option>
              {companyDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select></label>
            <label className="field-label">{t('common.reportsTo')}<select className="input compact" disabled={busyAgentId === selectedAgent.id} value={selectedAgent.bossId ?? ''} onChange={(event) => void updateAgentOrg(selectedAgent, { bossId: event.target.value || null })}>
              <option value="">{t('departments.topLevelAgent')}</option>
              {companyAgents.filter((candidate) => candidate.id !== selectedAgent.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select></label>
          </div>
        </section>}

        <section className="card section-card">
          <div className="panel-title"><div><h2><Target size={18} /> {t('departments.goals')}</h2><span className="status-pill">{selectedDepartment?.name ?? t('departments.noneSelected')}</span></div></div>
          <label className="field-label">{t('companies.goalTitle')}<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedDepartment} /></label>
          <label className="field-label">{t('companies.goalBody')}<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedDepartment} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedDepartment || !goalTitle.trim()} onClick={addDepartmentGoal}><Plus size={15} /> {t('departments.addGoal')}</button>
          <div className="table-list">
            {departmentGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || t('companies.noGoalBody')}</p></div>)}
            {selectedDepartment && departmentGoals.length === 0 && <p className="chat-empty">{t('departments.noGoals')}</p>}
          </div>
        </section>
      </main>
    </div>
  </div>;
}
