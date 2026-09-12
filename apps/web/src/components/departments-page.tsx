'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Target, Users, X } from 'lucide-react';
import { PositionsPage } from './positions-page';
import { positionAssignment, eligibleSupervisors, selectSupervisor, supervisorHint, type AuthorityPosition } from '@/lib/position-assignment';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string; headAgentId?: string | null; description?: string | null; headRolePrompt?: string | null };
type Agent = { id: string; companyId: string; departmentId?: string | null; positionId?: string | null; bossId?: string | null; name: string; role: string; adapterType?: string | null; isActive?: boolean; isBusy?: boolean };
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
  const positionsQuery = useQuery({ queryKey: ['positions'], queryFn: () => api<(AuthorityPosition & {companyId: string; name: string; isActive?: boolean})[]>('/api/positions') });
  const [tab, setTab] = useState('settings');
  const [pendingPositions, setPendingPositions] = useState<Record<string, string | null>>({});
  const [pendingBosses, setPendingBosses] = useState<Record<string, string | null>>({});
  useEffect(() => { if (new URLSearchParams(window.location.search).get('tab') === 'positions') setTab('positions'); }, []);
  const goalsQuery = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
  const [companyId, setCompanyId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [deptHead, setDeptHead] = useState('');
  const [deptDescription, setDeptDescription] = useState('');
  const [headRolePrompt, setHeadRolePrompt] = useState('');
  const [settingsRolePrompt, setSettingsRolePrompt] = useState('');
  const [settingsHead, setSettingsHead] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
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
  const positions = positionsQuery.data ?? [];
  const companyPositions = positions.filter(position => position.companyId === companyId);
  const bossAgentId = agents.find(agent => agent.companyId === companyId && agent.isActive !== false && companyPositions.some(position => position.id === agent.positionId && position.isCompanyBoss))?.id;
  const goals = goalsQuery.data ?? [];
  const loadError = companiesQuery.error ?? departmentsQuery.error ?? agentsQuery.error ?? positionsQuery.error ?? goalsQuery.error;
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedDepartment = departmentId === '__unassigned' || departmentId === '__leadership' ? null : companyDepartments.find((department) => department.id === departmentId) ?? companyDepartments[0] ?? null;
  const unassignedAgents = companyAgents.filter((agent) => !agent.departmentId && !companyPositions.some(position => position.id === agent.positionId && (position.isCompanyBoss || position.isCompanyLeadership)));
  const isLeadershipAgent = (agent: Agent) => companyPositions.some(position => position.id === agent.positionId && (position.isCompanyBoss || position.isCompanyLeadership));
  const leadershipAgents = companyAgents.filter(isLeadershipAgent);
  const visibleMembers = departmentId === '__leadership' ? leadershipAgents : departmentId === '__unassigned' ? unassignedAgents : companyAgents.filter(agent => agent.departmentId === selectedDepartment?.id);
  function memberAssignment(agent: Agent) {
    const positionId = Object.hasOwn(pendingPositions, agent.id) ? pendingPositions[agent.id] : agent.positionId;
    const position = companyPositions.find(position => position.id === positionId);
    const candidates = eligibleSupervisors(position, agent.id, companyId, companyAgents, companyPositions);
    const bossId = selectSupervisor(candidates, Object.hasOwn(pendingBosses, agent.id) ? pendingBosses[agent.id] : agent.bossId);
    return { positionId, position, candidates, bossId, pending: Object.hasOwn(pendingPositions, agent.id) };
  }
  function stagePosition(agent: Agent, positionId: string | null) {
    const candidates = eligibleSupervisors(companyPositions.find(position => position.id === positionId), agent.id, companyId, companyAgents, companyPositions);
    setPendingPositions(current => ({ ...current, [agent.id]: positionId }));
    setPendingBosses(current => ({ ...current, [agent.id]: selectSupervisor(candidates, agent.bossId) }));
  }
  function chooseSupervisor(agent: Agent, bossId: string | null) {
    if (memberAssignment(agent).pending) setPendingBosses(current => ({ ...current, [agent.id]: bossId }));
    else void updateAgentOrg(agent, { bossId });
  }
  const selectedAgent = visibleMembers.find((agent) => agent.id === selectedAgentId) ?? null;
  const departmentGoals = useMemo(() => goals.filter((goal) => goal.departmentId === selectedDepartment?.id), [goals, selectedDepartment?.id]);

  async function refreshQueries() {
    await Promise.all([['companies'], ['departments'], ['agents'], ['positions'], ['goals']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  useEffect(() => {
    if (!companiesQuery.data || !departmentsQuery.data) return;
    const activeCompanyId = companiesQuery.data.some((company) => company.id === companyId) ? companyId : companiesQuery.data[0]?.id ?? '';
    const activeDepartments = departmentsQuery.data.filter((department) => department.companyId === activeCompanyId);
    const preserveVirtualSelection = activeCompanyId === companyId && (departmentId === '__leadership' || departmentId === '__unassigned');
    setCompanyId(activeCompanyId);
    setDepartmentId(preserveVirtualSelection || activeDepartments.some((department) => department.id === departmentId) ? departmentId : activeDepartments[0]?.id ?? '');
  }, [companiesQuery.data, departmentsQuery.data]);
  useEffect(() => {
    if (loadError) setError(loadError instanceof Error ? loadError.message : t('departments.loadFailed'));
  }, [loadError]);
  useEffect(() => { setDeptSlug(slugify(deptName)); }, [deptName]);
  useEffect(() => {
    setSettingsHead(selectedDepartment?.headAgentId ?? '');
    setSettingsDescription(selectedDepartment?.description ?? '');
    setSettingsRolePrompt(selectedDepartment?.headRolePrompt ?? '');
  }, [selectedDepartment?.id, selectedDepartment?.headAgentId, selectedDepartment?.description, selectedDepartment?.headRolePrompt]);
  useEffect(() => {
    if (selectedAgentId && !companyAgents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId('');
  }, [companyAgents, selectedAgentId]);

  async function addDepartment() {
    if (!companyId || !deptName.trim() || !deptSlug.trim()) return;
    setBusy(true);
    setError('');
    try {
      const department = await api<Department>('/api/departments', { method: 'POST', body: JSON.stringify({ companyId, name: deptName.trim(), slug: deptSlug.trim(), description: deptDescription.trim() || null, headRolePrompt: headRolePrompt.trim() || null }) });
      setDeptName('');
      setDeptSlug('');
      setDeptHead('');
      setDeptDescription('');
    setHeadRolePrompt('');
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

  async function updateAgentOrg(agent: Agent, patch: Pick<Agent, 'positionId' | 'bossId'>) {
    setBusyAgentId(agent.id);
    setError('');
    try {
      const updated = await api<Agent>(`/api/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(patch.positionId !== undefined ? { ...patch, ...positionAssignment(companyPositions.find(position => position.id === patch.positionId), patch.bossId === undefined ? agent.bossId : patch.bossId, bossAgentId) } : patch) });
      queryClient.setQueryData<Agent[]>(['agents'], (current) => current?.map((item) => item.id === updated.id ? updated : item));
      setSelectedAgentId(updated.id);
      setPendingPositions(current => { const next = { ...current }; delete next[agent.id]; return next; });
      setPendingBosses(current => { const next = { ...current }; delete next[agent.id]; return next; });
      await refreshQueries();
      setToast(`${updated.name} ${t('departments.agentUpdated')}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('departments.agentUpdateFailed'));
    } finally {
      setBusyAgentId('');
    }
  }

  async function saveDepartmentSettings() {
    if (!selectedDepartment) return;
    setBusy(true);
    setError('');
    try {
      await api<Department>(`/api/departments/${selectedDepartment.id}`, { method: 'PUT', body: JSON.stringify({ description: settingsDescription.trim() || null, headRolePrompt: settingsRolePrompt.trim() || null }) });
      setToast(t('departments.settingsSaved'));
      await refreshQueries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('departments.agentUpdateFailed'));
    } finally {
      setBusy(false);
    }
  }

  function startNewDepartment() {
    setDeptName('');
    setDeptSlug('');
    setDeptHead('');
    setDeptDescription('');
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
          <label className="field-label">{t('departments.head')}
            <span className="field-hint">{t('departments.headHint')}</span>
            <select className="input" value={deptHead} onChange={(event) => setDeptHead(event.target.value)} disabled>
              <option value="">{t('departments.noHead')}</option>
              {companyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="field-label field-wide">{t('departments.description')}
            <span className="field-hint">{t('departments.descriptionHint')}</span>
            <textarea className="input" rows={2} value={deptDescription} onChange={(event) => setDeptDescription(event.target.value)} disabled={!companyId} />
          </label>
          <label className="field-label field-wide">Head role instructions (optional)<textarea className="input" rows={3} maxLength={8000} value={headRolePrompt} onChange={event => setHeadRolePrompt(event.target.value)} /><span className="field-hint">Adds responsibilities to the department head role; expertise stays in the position prompt.</span></label>
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
          <button aria-label={t('departments.leadership')} className={`list-row selectable-row ${departmentId === '__leadership' ? 'active' : ''}`} onClick={() => { setDepartmentId('__leadership'); setTab('positions'); }}><b>{t('departments.leadership')}</b><p>{t('departments.leadership')} / {leadershipAgents.length} {t('departments.agentsCount')}</p></button>
          {companyDepartments.map((department) => <button className={`list-row selectable-row ${department.id === selectedDepartment?.id ? 'active' : ''}`} key={department.id} onClick={() => setDepartmentId(department.id)}>
            <b>{department.name}</b>
            <p>{department.slug} / {companyAgents.filter((agent) => agent.departmentId === department.id).length} {t('departments.agentsCount')}</p>
          </button>)}
          <button className={`list-row selectable-row ${departmentId === '__unassigned' ? 'active' : ''}`} onClick={() => { setDepartmentId('__unassigned'); if (tab === 'settings' || tab === 'goals') setTab('members'); }}>
            <b>{t('common.noDepartment')}</b>
            <p>{unassignedAgents.length} {t('departments.agentsCount')}</p>
          </button>
          {companyDepartments.length === 0 && <p className="chat-empty">{t('departments.empty')}</p>}
        </div>
      </aside>

      <main className="page-stack">
        <div role="tablist" aria-label="Department views" className="action-row">
          <button role="tab" aria-selected={tab === 'settings'} disabled={!selectedDepartment} className="btn" onClick={() => setTab('settings')}>{t('nav.settings')}</button>
          <button role="tab" aria-selected={tab === 'goals'} disabled={!selectedDepartment} className="btn" onClick={() => setTab('goals')}>{t('departments.goalsTab')}</button>
          <button role="tab" aria-selected={tab === 'members'} className="btn" onClick={() => setTab('members')}>{t('departments.membersTab')}</button>
          <button role="tab" aria-selected={tab === 'positions'} className="btn" onClick={() => setTab('positions')}>{t('nav.positions')}</button>
        </div>
        {tab === 'positions' ? (selectedDepartment || departmentId === '__leadership' ? <PositionsPage key={`${companyId}:${departmentId}`} scopeCompanyId={companyId} scopeDepartmentId={selectedDepartment?.id} leadership={departmentId === '__leadership'} /> : <p className="chat-empty">Choose a department to manage its positions.</p>) : <>

        {tab === 'members' && <><section className="card section-card">
          <div className="panel-title"><div><h2><Users size={18} /> {t('departments.memberAssignment')}</h2><span className="status-pill">{visibleMembers.length} {t('departments.agentsCount')}</span></div></div>
          <div className="table-wrap">
            <table className="data-table org-assignment-table">
              <thead><tr><th>{t('common.agent')}</th><th>Position</th><th>{t('common.department')}</th><th>{t('common.reportsTo')}</th><th>{t('common.status')}</th><th>Assignment</th></tr></thead>
              <tbody>
                {visibleMembers.map((agent) => <tr key={agent.id}>
                  <td><button type="button" className="text-button agent-name-button" onClick={() => setSelectedAgentId(agent.id)}><b>{agent.name}</b><small>{agent.role} / {agent.adapterType ?? 'hermes-ssh'}</small></button></td>
                  <td><select aria-label={`Position for ${agent.name}`} className="input compact" disabled={busyAgentId === agent.id} value={memberAssignment(agent).positionId ?? ''} onChange={(event) => stagePosition(agent, event.target.value || null)}>
                    <option value="">No position</option>
                    {companyPositions.filter(position => position.isActive !== false || position.id === agent.positionId).map(position => <option key={position.id} value={position.id}>{position.name}</option>)}
                  </select></td>
                  <td><span title="Department is determined by position">{companyDepartments.find(department => department.id === agent.departmentId)?.name ?? (isLeadershipAgent(agent) ? 'Company leadership' : 'Unconfigured')}</span></td>
                  <td><select className="input compact" aria-label={`Reports to for ${agent.name}`} disabled={busyAgentId === agent.id || Boolean(memberAssignment(agent).position?.isCompanyBoss || memberAssignment(agent).position?.isDepartmentHead)} value={memberAssignment(agent).bossId ?? ''} onChange={(event) => chooseSupervisor(agent, event.target.value || null)}>
                    <option value="">{memberAssignment(agent).candidates.length ? 'Choose supervisor' : 'No eligible supervisor'}</option>
                    {memberAssignment(agent).candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select></td>
                  <td><span className="badge">{agent.isBusy ? t('common.busy') : agent.isActive === false ? t('common.offline') : t('common.ready')}</span></td>
                  <td>{memberAssignment(agent).pending && <button className="btn" disabled={busyAgentId === agent.id || (memberAssignment(agent).candidates.length > 1 && !memberAssignment(agent).bossId)} onClick={() => void updateAgentOrg(agent, { positionId: memberAssignment(agent).positionId || null, bossId: memberAssignment(agent).bossId })}>Save assignment</button>}<small>{supervisorHint(memberAssignment(agent).position, memberAssignment(agent).candidates)}</small></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {visibleMembers.length === 0 && <p className="chat-empty">{t('chat.noAgents')}</p>}
        </section>

        {selectedAgent && <section className="card section-card agent-inline-editor">
          <div className="panel-title"><div><h2><Pencil size={18} /> {t('departments.agentEditor')}</h2><span className="status-pill">{selectedAgent.name}</span></div></div>
          <div className="agent-editor-summary">
            <b>{selectedAgent.role}</b>
            <span>{selectedAgent.adapterType ?? 'hermes-ssh'} / {selectedAgent.isBusy ? t('common.busy') : selectedAgent.isActive === false ? t('common.offline') : t('common.ready')}</span>
          </div>
          <div className="form-grid department-agent-edit-grid">
            <label className="field-label">Position<select className="input compact" disabled={busyAgentId === selectedAgent.id} value={memberAssignment(selectedAgent).positionId ?? ''} onChange={(event) => stagePosition(selectedAgent, event.target.value || null)}>
              <option value="">No position</option>
              {companyPositions.filter(position => position.isActive !== false || position.id === selectedAgent.positionId).map(position => <option key={position.id} value={position.id}>{position.name}</option>)}
            </select><span className="field-hint">Department is determined by position.</span></label>
            <label className="field-label">{t('common.reportsTo')}<select className="input compact" disabled={busyAgentId === selectedAgent.id || Boolean(memberAssignment(selectedAgent).position?.isCompanyBoss || memberAssignment(selectedAgent).position?.isDepartmentHead)} value={memberAssignment(selectedAgent).bossId ?? ''} onChange={(event) => chooseSupervisor(selectedAgent, event.target.value || null)}>
              <option value="">{memberAssignment(selectedAgent).candidates.length ? 'Choose supervisor' : 'No eligible supervisor'}</option>
              {memberAssignment(selectedAgent).candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select></label>
          </div>
          <p className="field-hint">{supervisorHint(memberAssignment(selectedAgent).position, memberAssignment(selectedAgent).candidates)}</p>
          {memberAssignment(selectedAgent).pending && <button className="btn" disabled={busyAgentId === selectedAgent.id || (memberAssignment(selectedAgent).candidates.length > 1 && !memberAssignment(selectedAgent).bossId)} onClick={() => void updateAgentOrg(selectedAgent, { positionId: memberAssignment(selectedAgent).positionId || null, bossId: memberAssignment(selectedAgent).bossId })}>Save assignment</button>}
        </section>}

        </>}
        {tab === 'settings' && selectedDepartment && <section className="card section-card">
          <div className="panel-title"><div><h2><Users size={18} /> {t('departments.settings')}</h2><span className="status-pill">{selectedDepartment.name}</span></div></div>
          <div className="form-grid">
            <label className="field-label">{t('departments.head')}
              <span className="field-hint">{t('departments.headHint')}</span>
              <select className="input" disabled value={settingsHead} onChange={(event) => setSettingsHead(event.target.value)}>
                <option value="">{t('departments.noHead')}</option>
                {companyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label className="field-label field-wide">{t('departments.description')}
              <span className="field-hint">{t('departments.descriptionHint')}</span>
              <textarea className="input" rows={2} value={settingsDescription} onChange={(event) => setSettingsDescription(event.target.value)} />
            </label>
            <label className="field-label field-wide">Head role instructions (optional)
              <textarea className="input" rows={3} maxLength={8000} value={settingsRolePrompt} onChange={event => setSettingsRolePrompt(event.target.value)} />
              <span className="field-hint">Adds responsibilities to the built-in head role. Platform gates remain required.</span>
            </label>
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void saveDepartmentSettings()}>{t('departments.saveSettings')}</button>
        </section>}

        {tab === 'goals' && selectedDepartment && <section className="card section-card">
          <div className="panel-title"><div><h2><Target size={18} /> {t('departments.goals')}</h2><span className="status-pill">{selectedDepartment?.name ?? t('departments.noneSelected')}</span></div></div>
          <label className="field-label">{t('companies.goalTitle')}<input className="input" value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} disabled={!selectedDepartment} /></label>
          <label className="field-label">{t('companies.goalBody')}<textarea className="input" rows={3} value={goalBody} onChange={(event) => setGoalBody(event.target.value)} disabled={!selectedDepartment} /></label>
          <button className="btn btn-primary" disabled={busy || !selectedDepartment || !goalTitle.trim()} onClick={addDepartmentGoal}><Plus size={15} /> {t('departments.addGoal')}</button>
          <div className="table-list">
            {departmentGoals.map((goal) => <div className="list-row" key={goal.id}><b>{goal.title}</b><p>{goal.body || t('companies.noGoalBody')}</p></div>)}
            {selectedDepartment && departmentGoals.length === 0 && <p className="chat-empty">{t('departments.noGoals')}</p>}
          </div>
        </section>}
      </>}
      </main>
    </div>
  </div>;
}
