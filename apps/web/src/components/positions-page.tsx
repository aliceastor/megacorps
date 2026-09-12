'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Department = { id: string; companyId: string; name: string; slug: string };
type Position = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  prompt?: string | null;
  description?: string | null;
  rank?: number | null;
  isCompanyBoss?: boolean | null;
  isDepartmentHead?: boolean | null;
  isCompanyLeadership?: boolean | null;
  canDelegateAcrossDepartments?: boolean | null;
  defaultDepartmentId?: string | null;
  managerPositionId?: string | null;
  isActive?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
};
type Agent = { id: string; companyId: string; positionId?: string | null; name: string; role: string };
type PositionTemplate = { key: string; name: string; slug: string; isCompanyBoss: boolean; reviewDomain: string | null; description: string; prompt: string };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function PositionsPage({ scopeCompanyId, scopeDepartmentId, leadership = false }: { scopeCompanyId?: string; scopeDepartmentId?: string; leadership?: boolean } = {}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companyId, setCompanyId] = useState(scopeCompanyId ?? '');
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState(2);
  const [isCompanyBoss, setIsCompanyBoss] = useState(leadership);
  const [isDepartmentHead, setIsDepartmentHead] = useState(false);
  const [canDelegateAcrossDepartments, setCanDelegateAcrossDepartments] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [defaultDepartmentId, setDefaultDepartmentId] = useState('');
  const [managerPositionId, setManagerPositionId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [templates, setTemplates] = useState<PositionTemplate[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const companyPositions = useMemo(() => positions.filter((position) => position.companyId === companyId), [positions, companyId]);
  const companyDepartments = useMemo(() => departments.filter((department) => department.companyId === companyId), [departments, companyId]);
  const selectedPosition = positions.find((position) => position.id === selectedId) ?? null;
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const assignedAgents = useMemo(() => agents.filter((agent) => agent.positionId === selectedId), [agents, selectedId]);
  const scopedPositions = companyPositions.filter(position => leadership ? (position.isCompanyBoss || position.isCompanyLeadership) : scopeDepartmentId ? position.defaultDepartmentId === scopeDepartmentId && !position.isCompanyBoss && !position.isCompanyLeadership : !position.isCompanyBoss && !position.isCompanyLeadership);
  const headConflict = companyPositions.some(position => position.id !== selectedId && position.isDepartmentHead && position.defaultDepartmentId === defaultDepartmentId);
  const bossPosition = companyPositions.find(position => position.isCompanyBoss && position.isActive !== false);
  const companyHasBoss = companyPositions.some((position) => position.isCompanyBoss && position.isActive !== false);

  useEffect(() => {
    api<PositionTemplate[]>('/api/positions/templates').then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // A template fills the prompt; when drafting a new position it also proposes
  // name, slug and the boss flag (never a second boss for a company that has one).
  function applyTemplate(key: string) {
    const template = templates.find((item) => item.key === key);
    if (!template) return;
    setPrompt(template.prompt);
    if (selectedPosition) return;
    if (!name.trim()) { setName(template.name); setSlug(template.slug); }
    if (!description.trim()) setDescription(template.description);
    if (template.isCompanyBoss && !companyHasBoss && leadership) { setIsCompanyBoss(true); setIsDepartmentHead(false); setRank(0); }
  }

  async function refresh(nextCompanyId = companyId, nextSelectedId = selectedId) {
    setError('');
    try {
      const [companyRows, positionRows, agentRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Position[]>('/api/positions'),
        api<Agent[]>('/api/agents'),
      ]);
      const departmentRows = await api<Department[]>('/api/departments');
      setCompanies(companyRows);
      setDepartments(departmentRows);
      setPositions(positionRows);
      setAgents(agentRows);
      const activeCompanyId = companyRows.some((company) => company.id === nextCompanyId) ? nextCompanyId : companyRows[0]?.id ?? '';
      setCompanyId(activeCompanyId);
      const activePositions = positionRows.filter((position) => position.companyId === activeCompanyId && (leadership ? (position.isCompanyBoss || position.isCompanyLeadership) : scopeDepartmentId ? position.defaultDepartmentId === scopeDepartmentId && !position.isCompanyBoss && !position.isCompanyLeadership : !position.isCompanyBoss && !position.isCompanyLeadership));
      const activePosition = activePositions.find((position) => position.id === nextSelectedId) ?? activePositions[0] ?? null;
      if (activePosition) selectPosition(activePosition);
      else startNewPosition(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions');
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!selectedPosition) setSlug(slugify(name)); }, [name, selectedPosition]);

  function selectCompany(nextCompanyId: string) {
    setCompanyId(nextCompanyId);
    const nextPosition = positions.find((position) => position.companyId === nextCompanyId) ?? null;
    if (nextPosition) selectPosition(nextPosition);
    else startNewPosition(false);
  }

  function selectPosition(position: Position) {
    setSelectedId(position.id);
    setCompanyId(position.companyId);
    setName(position.name);
    setSlug(position.slug);
    setDescription(position.description ?? '');
    setRank(position.rank ?? 2);
    setIsCompanyBoss(Boolean(position.isCompanyBoss));
    setIsDepartmentHead(Boolean(position.isDepartmentHead));
    setCanDelegateAcrossDepartments(Boolean(position.canDelegateAcrossDepartments));
    setIsActive(position.isActive !== false);
    setDefaultDepartmentId(position.defaultDepartmentId ?? '');
    setManagerPositionId(position.managerPositionId ?? '');
    setPrompt(position.prompt ?? '');
    setError('');
  }

  function startNewPosition(focus = true) {
    setSelectedId('');
    setName('');
    setSlug('');
    setDescription('');
    setIsCompanyBoss(leadership && !companyHasBoss);
    setIsDepartmentHead(false);
    setRank(leadership && !companyHasBoss ? 0 : 2);
    setCanDelegateAcrossDepartments(false);
    setIsActive(true);
    setDefaultDepartmentId(scopeDepartmentId ?? '');
    setManagerPositionId('');
    setPrompt('');
    setError('');
    if (focus) window.setTimeout(() => nameRef.current?.focus(), 0);
  }

  async function savePosition() {
    if (!companyId || !name.trim() || !slug.trim()) {
      setError('Company, position name, and slug are required.');
      return;
    }
    if (!leadership && !isCompanyBoss && !defaultDepartmentId) { setError('Choose a department for this position.'); return; }
    if (isDepartmentHead && headConflict) { setError('This department already has a Department Head position (including inactive positions).'); return; }
    if (!Number.isInteger(rank) || (!isCompanyBoss && !isDepartmentHead && (rank < 2 || rank > 9))) { setError('Staff rank must be an integer from 2 to 9.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = {
        companyId,
        name: name.trim(),
        slug: slug.trim(),
        description,
        rank: isCompanyBoss ? 0 : isDepartmentHead ? 1 : rank,
        isCompanyBoss,
        isDepartmentHead,
        isCompanyLeadership: leadership || isCompanyBoss,
        canDelegateAcrossDepartments,
        isActive,
        defaultDepartmentId: leadership || isCompanyBoss ? null : defaultDepartmentId || null,
        managerPositionId: isCompanyBoss ? null : isDepartmentHead ? bossPosition?.id ?? null : managerPositionId || null,
        prompt,
      };
      const saved = selectedPosition
        ? await api<Position>(`/api/positions/${selectedPosition.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api<Position>('/api/positions', { method: 'POST', body: JSON.stringify(payload) });
      setToast(selectedPosition ? 'Position saved' : 'Position created');
      await refresh(companyId, saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Position save failed');
    } finally {
      setBusy(false);
    }
  }

  async function deletePosition() {
    if (!selectedPosition) return;
    if (!window.confirm(`Delete position "${selectedPosition.name}"? Assigned agents will keep working but lose this position prompt.`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/positions/${selectedPosition.id}`, { method: 'DELETE' });
      setToast('Position deleted');
      await refresh(companyId, '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Position delete failed');
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-stack positions-page">
    <div className="page-head">
      <div><h1>Positions</h1><p>Manage reusable company position prompts injected into Direct Chat and Kanban dispatch.</p></div>
      <button className="btn" disabled={!companyId} onClick={() => startNewPosition()}><Plus size={15} /> New Position</button>
    </div>
    {toast && <p className="status-pill">{toast}</p>}
    {error && <p className="form-error">{error}</p>}

    <div className="split-layout position-workbench">
      <aside className="card section-card">
        <div className="panel-title"><h2>Position List</h2><span className="status-pill">{scopedPositions.length}</span></div>
        <label className="field-label">Company<select className="input" value={companyId} disabled={Boolean(scopeCompanyId)} onChange={(event) => selectCompany(event.target.value)}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        <div className="table-list">
          {scopedPositions.map((position) => <button className={`list-row selectable-row ${position.id === selectedId ? 'active' : ''}`} key={position.id} onClick={() => selectPosition(position)}>
            <b>{position.name} {position.isCompanyBoss ? <span className="status-pill">boss</span> : null} {position.isActive === false ? <span className="status-pill">inactive</span> : null}</b>
            <p>{position.slug} / rank {position.rank ?? 2} / {agents.filter((agent) => agent.positionId === position.id).length} agents</p>
          </button>)}
          {scopedPositions.length === 0 && <p className="chat-empty">No positions yet.</p>}
        </div>
      </aside>

      <main className="page-stack">
        <section className="card section-card">
          <div className="panel-title">
            <div><h2>{selectedPosition ? 'Position Editor' : 'New Position'}</h2><span className="status-pill">{selectedCompany?.name ?? 'No company'}</span></div>
            <BriefcaseBusiness size={18} />
          </div>
          <div className="form-grid">
            <label className="field-label">Position name<input ref={nameRef} className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="field-label">Slug<input className="input" value={slug} onChange={(event) => setSlug(slugify(event.target.value))} /></label>
            <label className="field-label">Rank<input className="input" type="number" min={isCompanyBoss ? 0 : isDepartmentHead ? 1 : 2} max={9} step={1} disabled={isCompanyBoss || isDepartmentHead} value={isCompanyBoss ? 0 : isDepartmentHead ? 1 : rank} onChange={(event) => setRank(Number(event.target.value) || 0)} /></label>
            <p className="field-hint">{leadership ? 'Company leadership — outside departments' : `Department: ${companyDepartments.find(department => department.id === scopeDepartmentId)?.name ?? 'Choose a department'}`}</p>
            <label className="field-label">Manager position<select className="input" value={isCompanyBoss ? '' : isDepartmentHead ? bossPosition?.id ?? '' : managerPositionId} disabled={isCompanyBoss || isDepartmentHead} onChange={(event) => setManagerPositionId(event.target.value)}>
              <option value="">None</option>
              {companyPositions.filter((position) => position.id !== selectedId && position.isActive !== false).map((position) => <option key={position.id} value={position.id}>{position.name}</option>)}
            </select></label>
          </div>
          <div className="form-grid">
            <label className="check-row"><input type="checkbox" checked={isCompanyBoss} disabled={!leadership || (!isCompanyBoss && companyHasBoss)} onChange={(event) => { setIsCompanyBoss(event.target.checked); setIsDepartmentHead(false); setRank(event.target.checked ? 0 : 2); setDefaultDepartmentId(''); setManagerPositionId(''); }} /> <ShieldCheck size={15} /> Company boss position</label>
            <label className="check-row"><input type="checkbox" checked={isDepartmentHead} disabled={leadership || isCompanyBoss || (!isDepartmentHead && headConflict)} onChange={(event) => { setIsDepartmentHead(event.target.checked); setRank(event.target.checked ? 1 : 2); setManagerPositionId(''); }} /> Department Head</label>
            <label className="check-row"><input type="checkbox" checked={canDelegateAcrossDepartments} onChange={(event) => setCanDelegateAcrossDepartments(event.target.checked)} /> Cross-department delegation</label>
            <label className="check-row"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> Active position</label>
          </div>
          {headConflict && !isDepartmentHead && !isCompanyBoss && <p className="field-hint">This department already has a Department Head position. Edit that position to change its leadership role.</p>}
          <p className="field-hint">{isCompanyBoss ? 'Company Boss has no department or superior.' : isDepartmentHead ? 'The head reports to the current Company Boss. One head position is allowed per department.' : leadership ? 'Company-direct Staff use ranks 2–9 and remain outside departments. Choose their manager position below.' : 'Staff ranks are 2–9. The position determines each assigned Agent’s department.'}</p>
          <label className="field-label">Description<textarea className="input" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Operational authority, scope, and how this position fits into the company hierarchy." /></label>
          <label className="field-label">Start from a template
            <span className="field-hint">Fills the prompt with a ready-made role. The operating procedure for a boss, department head, member or reviewer is injected automatically from the org chart, so the prompt only needs personality, expertise and house rules.</span>
            <select className="input" value="" onChange={(event) => applyTemplate(event.target.value)} disabled={templates.length === 0}>
              <option value="">{templates.length === 0 ? 'Templates unavailable' : 'Choose a template to apply'}</option>
              {templates.map((template) => <option key={template.key} value={template.key}>{template.name}: {template.description}</option>)}
            </select>
          </label>
          <label className="field-label">Position prompt
            <span className="field-hint">Injected after the {leadership || isCompanyBoss ? 'company leadership' : 'department'} role context for {name || 'this position'} at {selectedCompany?.name ?? 'the company'}.</span>
            <textarea className="input" rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Define authority, responsibilities, decision style, escalation rules, and limits for this position." />
          </label>
          <section className="config-summary">
            <div className="panel-title"><h3>Prompt preview</h3><span className="status-pill">{isCompanyBoss ? 'company boss' : leadership ? 'company leadership' : 'department'}</span></div>
            <pre className="log-block">{[
              leadership || isCompanyBoss ? `You are ${name || 'xxxxx'} in the company leadership of ${selectedCompany?.name ?? 'yyyy'}, outside departments.` : `You are ${name || 'xxxxx'} in the ${companyDepartments.find(department => department.id === defaultDepartmentId)?.name ?? '{agent.department}'} department of ${selectedCompany?.name ?? 'yyyy'}.`,
              `Authority: rank ${rank}; boss=${isCompanyBoss ? 'yes' : 'no'}; active=${isActive ? 'yes' : 'no'}; cross-department delegation=${canDelegateAcrossDepartments ? 'yes' : 'no'}.`,
              description ? `Description: ${description}` : '',
              prompt || '{custom position prompt}',
            ].filter(Boolean).join('\n')}</pre>
          </section>
          <div className="action-row">
            <button className="btn btn-primary" disabled={busy || !companyId || !name.trim() || !slug.trim()} onClick={savePosition}><Save size={15} /> Save Position</button>
            <button className="btn" disabled={busy || !selectedPosition || Boolean(selectedPosition?.isCompanyBoss && selectedPosition?.isActive !== false)} onClick={deletePosition} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> Delete Position</button>
          </div>
        </section>

        <section className="card section-card">
          <div className="panel-title"><h2>Assigned agents</h2><span className="status-pill">{assignedAgents.length}</span></div>
          <div className="table-list">
            {assignedAgents.map((agent) => <div className="list-row" key={agent.id}><b>{agent.name}</b><p>{agent.role}</p></div>)}
            {selectedPosition && assignedAgents.length === 0 && <p className="chat-empty">Vacant — no Agent currently occupies this position.</p>}
            {!selectedPosition && <p className="chat-empty">Select or create a position to see assigned agents.</p>}
          </div>
        </section>
      </main>
    </div>
  </div>;
}
