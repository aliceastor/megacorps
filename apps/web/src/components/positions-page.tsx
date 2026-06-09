'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Position = { id: string; companyId: string; name: string; slug: string; prompt?: string | null; createdAt?: string; updatedAt?: string };
type Agent = { id: string; companyId: string; positionId?: string | null; name: string; role: string };

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function PositionsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [prompt, setPrompt] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const companyPositions = useMemo(() => positions.filter((position) => position.companyId === companyId), [positions, companyId]);
  const selectedPosition = positions.find((position) => position.id === selectedId) ?? null;
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const assignedAgents = useMemo(() => agents.filter((agent) => agent.positionId === selectedId), [agents, selectedId]);

  async function refresh(nextCompanyId = companyId, nextSelectedId = selectedId) {
    setError('');
    try {
      const [companyRows, positionRows, agentRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Position[]>('/api/positions'),
        api<Agent[]>('/api/agents'),
      ]);
      setCompanies(companyRows);
      setPositions(positionRows);
      setAgents(agentRows);
      const activeCompanyId = companyRows.some((company) => company.id === nextCompanyId) ? nextCompanyId : companyRows[0]?.id ?? '';
      setCompanyId(activeCompanyId);
      const activePositions = positionRows.filter((position) => position.companyId === activeCompanyId);
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
    setPrompt(position.prompt ?? '');
    setError('');
  }

  function startNewPosition(focus = true) {
    setSelectedId('');
    setName('');
    setSlug('');
    setPrompt('');
    setError('');
    if (focus) window.setTimeout(() => nameRef.current?.focus(), 0);
  }

  async function savePosition() {
    if (!companyId || !name.trim() || !slug.trim()) {
      setError('Company, position name, and slug are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = { companyId, name: name.trim(), slug: slug.trim(), prompt };
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
        <div className="panel-title"><h2>Position List</h2><span className="status-pill">{companyPositions.length}</span></div>
        <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => selectCompany(event.target.value)}>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        <div className="table-list">
          {companyPositions.map((position) => <button className={`list-row selectable-row ${position.id === selectedId ? 'active' : ''}`} key={position.id} onClick={() => selectPosition(position)}>
            <b>{position.name}</b>
            <p>{position.slug} / {agents.filter((agent) => agent.positionId === position.id).length} agents</p>
          </button>)}
          {companyPositions.length === 0 && <p className="chat-empty">No positions yet.</p>}
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
          </div>
          <label className="field-label">Position prompt
            <span className="field-hint">Injected after: You are {name || 'xxxxx'} in agent department of firm {selectedCompany?.name ?? 'yyyy'}.</span>
            <textarea className="input" rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Define authority, responsibilities, decision style, escalation rules, and limits for this position." />
          </label>
          <section className="config-summary">
            <div className="panel-title"><h3>Prompt preview</h3><span className="status-pill">runtime department</span></div>
            <pre className="log-block">{[`You are ${name || 'xxxxx'} in {agent.department} department of firm ${selectedCompany?.name ?? 'yyyy'}.`, prompt || '{custom position prompt}'].join('\n')}</pre>
          </section>
          <div className="action-row">
            <button className="btn btn-primary" disabled={busy || !companyId || !name.trim() || !slug.trim()} onClick={savePosition}><Save size={15} /> Save Position</button>
            <button className="btn" disabled={busy || !selectedPosition} onClick={deletePosition} style={{ color: 'var(--danger)' }}><Trash2 size={15} /> Delete Position</button>
          </div>
        </section>

        <section className="card section-card">
          <div className="panel-title"><h2>Assigned agents</h2><span className="status-pill">{assignedAgents.length}</span></div>
          <div className="table-list">
            {assignedAgents.map((agent) => <div className="list-row" key={agent.id}><b>{agent.name}</b><p>{agent.role}</p></div>)}
            {selectedPosition && assignedAgents.length === 0 && <p className="chat-empty">No agents use this position yet.</p>}
            {!selectedPosition && <p className="chat-empty">Select or create a position to see assigned agents.</p>}
          </div>
        </section>
      </main>
    </div>
  </div>;
}
