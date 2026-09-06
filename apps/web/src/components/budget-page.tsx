'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, RotateCcw, Save, Trash2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';
import { budgetCopy } from '@/lib/budget-copy';
import { currentUtcMonth, formatUsd, type CostEvent, type UsageSummary as Summary } from '@/lib/usage';
import { UsageSummary } from './usage-summary';

type Agent = { id: string; companyId: string; name: string; isActive?: boolean; budgetMonthly?: string | null; budgetPerTask?: string | null };
type Company = { id: string; name: string };
type Card = { id: string; title: string };
type Policy = { id: string; companyId: string; agentId?: string | null; name: string; monthlyLimitUsd?: string | null; perTaskLimitUsd?: string | null; warnAtPercent?: number; hardStop?: boolean; isActive?: boolean };
type Approval = { id: string; cardId?: string | null; type: string; status: string; createdAt?: string };
const pageSize = 25;
function queryPath(path: string, fields: Record<string, string>) {
  const query = new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== ''));
  return `${path}?${query}`;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function BudgetPage() {
  const { locale } = useLocale(); const text = budgetCopy[locale];
  const [companyId, setCompanyId] = useState(''); const [agentId, setAgentId] = useState('');
  const [month, setMonth] = useState(currentUtcMonth); const [allTime, setAllTime] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editingId, setEditingId] = useState(''); const [policyName, setPolicyName] = useState('');
  const [policyCompany, setPolicyCompany] = useState(''); const [policyAgent, setPolicyAgent] = useState('');
  const [monthlyLimit, setMonthlyLimit] = useState('10'); const [cardLimit, setCardLimit] = useState('1');
  const [warn, setWarn] = useState('80'); const [hardStop, setHardStop] = useState(true); const [active, setActive] = useState(true);
  const [toast, setToast] = useState(''); const [writeError, setWriteError] = useState('');
  const [writing, setWriting] = useState(false); const writeLock = useRef(false);
  const catalog = useQuery({ queryKey: ['budget-catalog'], retry: false, queryFn: async () => {
    const [companies, agents] = await Promise.all([api<Company[]>('/api/companies'), api<Agent[]>('/api/agents')]);
    return { companies, agents };
  } });
  const companies = catalog.data?.companies ?? []; const agents = catalog.data?.agents ?? [];
  const enabled = !catalog.isError && companies.length > 0;
  const period = allTime ? 'all' : month;
  const summary = useQuery({ queryKey: ['budget-usage', companyId, agentId, period], enabled, retry: false,
    queryFn: () => api<Summary>(queryPath('/api/usage-summary', { companyId, agentId, period })) });
  const costs = useQuery({ queryKey: ['budget-events', companyId, agentId, offset], enabled, retry: false,
    queryFn: () => api<CostEvent[]>(queryPath('/api/cost-events', { companyId, agentId, limit: String(pageSize), offset: String(offset) })) });
  const companyData = useQuery({ queryKey: ['budget-company', companyId], enabled, retry: false, queryFn: async () => {
    const [policies, approvals, cards] = await Promise.all([
      api<Policy[]>(queryPath('/api/budget-policies', { companyId })),
      api<Approval[]>(queryPath('/api/approvals', { companyId, status: 'pending', limit: '100' })),
      api<Card[]>(queryPath('/api/cards', { companyId, limit: '100' })),
    ]);
    return { policies, approvals, cards };
  } });
  useEffect(() => { if (companies[0]) setPolicyCompany(previous => previous || companies[0]!.id); }, [catalog.data]);
  const visibleAgents = agents.filter(agent => (!companyId || agent.companyId === companyId) && (!agentId || agent.id === agentId));
  const policies = (companyData.data?.policies ?? []).filter(policy => !agentId || !policy.agentId || policy.agentId === agentId);
  const approvals = companyData.data?.approvals ?? []; const cards = companyData.data?.cards ?? [];

  function resetPolicy() {
    setEditingId(''); setPolicyName(''); setPolicyCompany(companyId || companies[0]?.id || ''); setPolicyAgent('');
    setMonthlyLimit('10'); setCardLimit('1'); setWarn('80'); setHardStop(true); setActive(true); setWriteError(''); setToast('');
  }
  function editPolicy(policy: Policy) {
    setEditingId(policy.id); setPolicyName(policy.name); setPolicyCompany(policy.companyId); setPolicyAgent(policy.agentId ?? '');
    setMonthlyLimit(policy.monthlyLimitUsd ?? ''); setCardLimit(policy.perTaskLimitUsd ?? ''); setWarn(String(policy.warnAtPercent ?? 80));
    setHardStop(policy.hardStop !== false); setActive(policy.isActive !== false); setWriteError(''); setToast('');
  }
  async function refresh() {
    await catalog.refetch();
    if (enabled) await Promise.all([summary.refetch(), companyData.refetch(), costs.refetch()]);
  }
  async function mutate(operation: () => Promise<unknown>, message: string) {
    if (writeLock.current) return;
    writeLock.current = true; setWriting(true); setWriteError(''); setToast('');
    try { await operation(); setToast(message); await refresh(); }
    catch (error) { setWriteError(errorText(error)); }
    finally { writeLock.current = false; setWriting(false); }
  }
  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!companies.some(company => company.id === policyCompany) || !policyName.trim()) { setWriteError(text.policyUnavailable); return; }
    void mutate(async () => { const saved = await api<Policy>(editingId ? `/api/budget-policies/${editingId}` : '/api/budget-policies', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify({ companyId: policyCompany, agentId: policyAgent || null, name: policyName.trim(),
        monthlyLimitUsd: monthlyLimit === '' ? null : Number(monthlyLimit), perTaskLimitUsd: cardLimit === '' ? null : Number(cardLimit),
        warnAtPercent: Number(warn), hardStop, isActive: active }),
    }); setEditingId(saved.id); }, text.saved);
  }
  function deletePolicy(policy: Policy) {
    if (!window.confirm(`${text.deleteConfirm} "${policy.name}"?`)) return;
    void mutate(async () => { await api(`/api/budget-policies/${policy.id}`, { method: 'DELETE' }); if (editingId === policy.id) resetPolicy(); }, text.deleted);
  }
  function decideApproval(approval: Approval, status: 'approved' | 'rejected') {
    void mutate(() => api(`/api/approvals/${approval.id}`, { method: 'PUT', body: JSON.stringify({ status, decisionNote: `Board ${status} from Budget page.` }) }), text.approvalSaved);
  }
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  const cardName = (id: string) => cards.find(card => card.id === id)?.title ?? id;

  return <div className="budget-page">
    <div className="page-head"><div><h1>{text.title}</h1><p>{text.subtitle}</p></div><div className="action-row">{enabled && <a className="btn" href="#budget-policies">{text.limits}</a>}<button className="btn" onClick={() => void refresh()} disabled={catalog.isFetching || writing}><RefreshCw size={15} />{text.refresh}</button></div></div>
    {toast && <p role="status" className="status-pill">{toast}</p>}
    {writeError && <p role="alert" className="form-error">{writeError}</p>}
    {catalog.isError ? <div role="alert" className="form-error">{errorText(catalog.error)} <button className="btn" onClick={() => void catalog.refetch()}>{text.retryData}</button></div>
      : catalog.isPending ? <p>{text.loading}</p>
      : companies.length === 0 ? <section className="card section-card"><p>{text.noCompany}</p><Link className="btn btn-primary" href="/companies">{text.start}</Link></section> : <>
      <section className="card section-card budget-filters">
        <label className="field-label">{text.reportCompany}<select className="input" value={companyId} onChange={event => { setCompanyId(event.target.value); setAgentId(''); setOffset(0); }}><option value="">{text.allCompanies}</option>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field-label">{text.reportAgent}<select className="input" value={agentId} onChange={event => { setAgentId(event.target.value); setOffset(0); }}><option value="">{text.allAgents}</option>{agents.filter(agent => !companyId || agent.companyId === companyId).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label className="field-label">{text.month}<input className="input" type="month" value={month} disabled={allTime} onChange={event => { if (event.target.value) setMonth(event.target.value); }} /></label>
        <label className="check-row"><input type="checkbox" checked={allTime} onChange={event => setAllTime(event.target.checked)} />{text.allTime}</label>
      </section>
      {summary.isError ? <div role="alert" className="form-error">{errorText(summary.error)} <button className="btn" onClick={() => void summary.refetch()}>{text.retryUsage}</button></div> : summary.data ? <UsageSummary usage={summary.data} /> : <p>{text.loading}</p>}
      <section className="card section-card" aria-label={text.attempts}>
        <div className="panel-title"><h2>{text.attempts}</h2><span>{text.page} {offset / pageSize + 1}</span></div>
        {costs.isError ? <div role="alert" className="form-error">{errorText(costs.error)} <button className="btn" onClick={() => void costs.refetch()}>{text.retryData}</button></div> : costs.isPending ? <p>{text.loading}</p> : <div className="table-list budget-attempt-list" tabIndex={0} aria-label={text.attempts}>{costs.data?.length ? costs.data.map(event => {
          const status = event.costStatus ?? event.usage?.costStatus ?? (event.costUsd == null ? 'unknown' : 'estimated');
          const label = status === 'unknown' ? text.unknownCost : status === 'actual' ? text.actual : event.source === 'legacy_fixed_rate' ? text.legacyEstimate : text.estimated;
          const tokenStatus = event.usage?.tokenStatus ?? 'unknown';
          const provider = event.provider && event.provider.toLowerCase() !== 'unknown' ? event.provider : text.noProvider;
          return <article className="list-row budget-attempt" data-usage-status={status} key={event.id}>
            <div className="panel-title"><b>{status === 'unknown' ? '—' : formatUsd(event.costUsd)}</b><span className="status-pill">{label}</span></div>
            <p>{agentName(event.agentId)} · {event.cardId ? <Link href={`/kanban?cardId=${encodeURIComponent(event.cardId)}`}>{cardName(event.cardId)}</Link> : text.noCard}</p>
            <p>{provider}{event.model && event.model.toLowerCase() !== 'unknown' ? ` / ${event.model}` : ''} · {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : '—'}</p>
            <p>{tokenStatus === 'actual' ? text.tokenActual : tokenStatus === 'estimated' ? text.tokenEstimated : text.tokenUnknown}: {tokenStatus === 'unknown' ? '—' : event.usage?.totalTokens ?? '—'}</p>
          </article>;
        }) : <p>{text.none}</p>}</div>}
        <div className="action-row"><button className="btn" disabled={offset === 0 || costs.isFetching} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>{text.previous}</button><button className="btn" disabled={costs.isFetching || costs.isError || (costs.data?.length ?? 0) < pageSize} onClick={() => setOffset(value => value + pageSize)}>{text.next}</button></div>
      </section>
      <p className="usage-note">{text.scopeHint}</p><p className="usage-note">{text.enforcementHint}</p>
      {companyData.isError && <div role="alert" className="form-error">{errorText(companyData.error)} <button className="btn" onClick={() => void companyData.refetch()}>{text.retryData}</button></div>}
      <div className="data-grid" id="budget-policies">
        <form className="card section-card" onSubmit={savePolicy}>
          <div className="panel-title"><h2>{editingId ? text.editPolicy : text.newPolicy}</h2>{editingId && <button type="button" className="btn" onClick={resetPolicy} disabled={writing}><RotateCcw size={14} />{text.create}</button>}</div>
          <label className="field-label">{text.company}<select className="input" value={policyCompany} disabled={Boolean(editingId) || writing} onChange={event => { setPolicyCompany(event.target.value); setPolicyAgent(''); }}>{companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
          <label className="field-label">{text.agentScope}<select className="input" value={policyAgent} disabled={writing} onChange={event => setPolicyAgent(event.target.value)}><option value="">{text.companyScope}</option>{agents.filter(agent => agent.companyId === policyCompany).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <div className="form-grid">
            <label className="field-label field-wide">{text.name}<input className="input" value={policyName} maxLength={160} required disabled={writing} onChange={event => setPolicyName(event.target.value)} /></label>
            <label className="field-label">{text.monthlyLimit}<input className="input" type="number" min={0} step="0.00000001" value={monthlyLimit} disabled={writing} onChange={event => setMonthlyLimit(event.target.value)} /></label>
            <label className="field-label">{text.perTaskLimit}<input className="input" type="number" min={0} step="0.00000001" value={cardLimit} disabled={writing} onChange={event => setCardLimit(event.target.value)} /></label>
            <label className="field-label">{text.warn}<input className="input" type="number" min={1} max={100} step={1} required value={warn} disabled={writing} onChange={event => setWarn(event.target.value)} /></label>
            <label className="check-row"><input type="checkbox" checked={hardStop} disabled={writing} onChange={event => setHardStop(event.target.checked)} />{text.hard}</label>
            <label className="check-row"><input type="checkbox" checked={active} disabled={writing} onChange={event => setActive(event.target.checked)} />{text.active}</label>
          </div>
          <button className="btn btn-primary" disabled={writing || companyData.isError || !companies.some(company => company.id === policyCompany)}><Save size={15} />{writing ? text.saving : text.save}</button>
        </form>
        <section className="card section-card"><h2>{text.limits}</h2><div className="table-list">{!companyData.isError && policies.length ? policies.map(policy => <article className="list-row" key={policy.id}><b>{policy.name}</b>
          <p>{companies.find(company => company.id === policy.companyId)?.name} · {policy.agentId ? agentName(policy.agentId) : text.companyScope}</p>
          <p>{text.monthlyLimit}: {policy.monthlyLimitUsd == null ? text.noLimit : formatUsd(policy.monthlyLimitUsd)} · {text.perTaskLimit}: {policy.perTaskLimitUsd == null ? text.noLimit : formatUsd(policy.perTaskLimitUsd)}</p>
          <p>{text.warn}: {policy.warnAtPercent ?? 80}% · {policy.hardStop === false ? text.warningOnly : text.hardStop}{policy.isActive === false ? ` · ${text.inactive}` : ''}</p>
          <div className="action-row"><button className="btn" disabled={writing} onClick={() => editPolicy(policy)}>{text.edit}</button><button className="btn" disabled={writing} onClick={() => deletePolicy(policy)}><Trash2 size={14} />{text.delete}</button></div>
        </article>) : <p>{companyData.isPending ? text.loading : companyData.isError ? text.unavailable : text.none}</p>}</div></section>
        <section className="card section-card"><h2>{text.agentLimits}</h2><div className="table-list">{visibleAgents.map(agent => <article className="list-row" key={agent.id}><b>{agent.name}</b><p>{agent.isActive === false ? text.manualPaused : text.enabled}</p><p>{text.monthlyLimit}: {agent.budgetMonthly == null ? text.noLimit : formatUsd(agent.budgetMonthly)} · {text.perTaskLimit}: {agent.budgetPerTask == null ? text.noLimit : formatUsd(agent.budgetPerTask)}</p></article>)}</div></section>
        <section className="card section-card"><h2>{text.approvals}</h2><div className="table-list">{!companyData.isError && approvals.length ? approvals.map(approval => <article className="list-row" key={approval.id}><b>{approval.type}</b><p>{approval.cardId ? cardName(approval.cardId) : text.noCard}</p><div className="action-row"><button className="btn btn-primary" disabled={writing} onClick={() => decideApproval(approval, 'approved')}><CheckCircle2 size={14} />{text.approve}</button><button className="btn" disabled={writing} onClick={() => decideApproval(approval, 'rejected')}><XCircle size={14} />{text.reject}</button></div></article>) : <p>{companyData.isPending ? text.loading : companyData.isError ? text.unavailable : text.none}</p>}</div></section>
      </div>
    </>}
  </div>;
}
