'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Save, XCircle } from 'lucide-react';
import { api } from '@/lib/api';

type Agent = { id: string; companyId?: string; name: string; isActive?: boolean; budgetMonthly?: string; spentThisMonth?: string; adapterType?: string };
type Card = { id: string; title: string; columnStatus?: string; costUsd?: string | null; assigneeId?: string | null };
type Company = { id: string; name: string };
type DashboardData = { stats: Record<string, number> };
type CostEvent = { id: string; agentId: string; cardId?: string | null; provider?: string; model?: string; costUsd: string; occurredAt?: string };
type BudgetPolicy = { id: string; companyId: string; agentId?: string | null; name: string; monthlyLimitUsd?: string | null; perTaskLimitUsd?: string | null; warnAtPercent?: number; hardStop?: boolean; isActive?: boolean };
type Approval = { id: string; cardId?: string | null; type: string; status: string; payload?: unknown; createdAt?: string };

export function BudgetPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [costs, setCosts] = useState<CostEvent[]>([]);
  const [policies, setPolicies] = useState<BudgetPolicy[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [policyName, setPolicyName] = useState('Default hard stop');
  const [policyCompany, setPolicyCompany] = useState('');
  const [policyAgent, setPolicyAgent] = useState('');
  const [monthlyLimit, setMonthlyLimit] = useState('10');
  const [perTaskLimit, setPerTaskLimit] = useState('1');
  const [toast, setToast] = useState('');

  async function refresh() {
    const [a, c, co, d, ce, bp, ap] = await Promise.all([
      api<Agent[]>('/api/agents'),
      api<Card[]>('/api/cards'),
      api<Company[]>('/api/companies'),
      api<DashboardData>('/api/dashboard'),
      api<CostEvent[]>('/api/cost-events?limit=100'),
      api<BudgetPolicy[]>('/api/budget-policies'),
      api<Approval[]>('/api/approvals?status=pending&limit=100'),
    ]);
    setAgents(a);
    setCards(c);
    setCompanies(co);
    setDashboard(d);
    setCosts(ce);
    setPolicies(bp);
    setApprovals(ap);
    if (!policyCompany && co[0]) setPolicyCompany(co[0].id);
  }

  useEffect(() => { void refresh(); }, []);

  async function savePolicy() {
    if (!policyCompany || !policyName.trim()) return;
    await api<BudgetPolicy>('/api/budget-policies', {
      method: 'POST',
      body: JSON.stringify({
        companyId: policyCompany,
        agentId: policyAgent || null,
        name: policyName.trim(),
        monthlyLimitUsd: monthlyLimit ? Number(monthlyLimit) : null,
        perTaskLimitUsd: perTaskLimit ? Number(perTaskLimit) : null,
        warnAtPercent: 80,
        hardStop: true,
        isActive: true,
      }),
    });
    setToast('Budget policy saved');
    await refresh();
  }

  async function decideApproval(approval: Approval, status: 'approved' | 'rejected') {
    await api(`/api/approvals/${approval.id}`, { method: 'PUT', body: JSON.stringify({ status, decisionNote: `Board ${status} from Budget page.` }) });
    setToast(`Approval ${status}`);
    await refresh();
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Budget</h1><p>Cost events, budget policies, hard stops, and approval queue.</p></div></div>
    {toast && <p className="status-pill">{toast}</p>}
    <div className="stat-grid">
      <section className="card stat-card"><span>Total recorded cost</span><b>${dashboard?.stats.monthlyCost ?? 0}</b></section>
      <section className="card stat-card"><span>Policies</span><b>{policies.length}</b></section>
      <section className="card stat-card"><span>Pending approvals</span><b>{approvals.length}</b></section>
      <section className="card stat-card"><span>Cost events</span><b>{costs.length}</b></section>
    </div>
    <div className="data-grid">
      <section className="card section-card">
        <h2>New budget policy</h2>
        <label className="field-label">Company<select className="input" value={policyCompany} onChange={(event) => setPolicyCompany(event.target.value)}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field-label">Agent scope<select className="input" value={policyAgent} onChange={(event) => setPolicyAgent(event.target.value)}><option value="">All agents in company</option>{agents.filter((agent) => !policyCompany || agent.companyId === policyCompany).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <div className="form-grid">
          <label className="field-label">Name<input className="input" value={policyName} onChange={(event) => setPolicyName(event.target.value)} /></label>
          <label className="field-label">Monthly limit USD<input className="input" type="number" min={0} step="0.01" value={monthlyLimit} onChange={(event) => setMonthlyLimit(event.target.value)} /></label>
          <label className="field-label">Per-task limit USD<input className="input" type="number" min={0} step="0.01" value={perTaskLimit} onChange={(event) => setPerTaskLimit(event.target.value)} /></label>
        </div>
        <button className="btn btn-primary" onClick={savePolicy}><Save size={15} /> Save policy</button>
      </section>
      <section className="card section-card">
        <h2>Agent budgets</h2>
        <div className="table-list">
          {agents.map((agent) => {
            const spent = Number(agent.spentThisMonth ?? 0);
            const budget = Number(agent.budgetMonthly ?? 0);
            const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
            return <div className="list-row" key={agent.id}>
              <b>{agent.name}</b><p>{agent.adapterType ?? 'mock'} / ${spent.toFixed(4)} {budget ? `/ $${budget.toFixed(2)} (${pct}%)` : '/ no monthly cap'} / {agent.isActive === false ? 'paused' : 'active'}</p>
              <div style={{ height: 8, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--accent)' : 'var(--primary)' }} /></div>
            </div>;
          })}
        </div>
      </section>
      <section className="card section-card">
        <h2>Active policies</h2>
        <div className="table-list">{policies.map((policy) => <div className="list-row" key={policy.id}><b>{policy.name}</b><p>{policy.agentId ? agents.find((agent) => agent.id === policy.agentId)?.name ?? 'Agent scope' : 'Company scope'} / monthly ${policy.monthlyLimitUsd ?? 'none'} / task ${policy.perTaskLimitUsd ?? 'none'} / {policy.hardStop === false ? 'warning only' : 'hard stop'}</p></div>)}</div>
      </section>
      <section className="card section-card">
        <h2>Pending approvals</h2>
        <div className="table-list">{approvals.map((approval) => <div className="list-row" key={approval.id}>
          <b>{approval.type}</b><p>{approval.cardId ? cards.find((card) => card.id === approval.cardId)?.title ?? approval.cardId : 'No card'} / {approval.createdAt ? new Date(approval.createdAt).toLocaleString() : ''}</p>
          <div className="action-row"><button className="btn btn-primary" onClick={() => decideApproval(approval, 'approved')}><CheckCircle2 size={14} /> Approve</button><button className="btn" style={{ color: 'var(--danger)' }} onClick={() => decideApproval(approval, 'rejected')}><XCircle size={14} /> Reject</button></div>
        </div>)}</div>
      </section>
      <section className="card section-card">
        <h2>Recent cost events</h2>
        <div className="table-list">{costs.map((event) => <div className="list-row" key={event.id}><b>${event.costUsd} / {event.provider ?? 'unknown'}</b><p>{agents.find((agent) => agent.id === event.agentId)?.name ?? event.agentId} / {event.cardId ? cards.find((card) => card.id === event.cardId)?.title ?? event.cardId : 'no task'} / {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : ''}</p></div>)}</div>
      </section>
      <section className="card section-card">
        <h2>Recent task costs</h2>
        <div className="table-list">{cards.filter((card) => card.costUsd).slice(0, 30).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus} / ${card.costUsd}</p></div>)}</div>
      </section>
    </div>
  </div>;
}
