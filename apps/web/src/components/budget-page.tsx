'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Agent = { id: string; name: string; isActive?: boolean; budgetMonthly?: string; spentThisMonth?: string; adapterType?: string };
type Card = { id: string; title: string; columnStatus?: string; costUsd?: string | null; assigneeId?: string | null };
type DashboardData = { stats: Record<string, number> };

export function BudgetPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);

  useEffect(() => {
    void Promise.all([api<Agent[]>('/api/agents'), api<Card[]>('/api/cards'), api<DashboardData>('/api/dashboard')]).then(([a, c, d]) => { setAgents(a); setCards(c); setDashboard(d); });
  }, []);

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Budget</h1><p>Agent spend, monthly caps, and task cost visibility.</p></div></div>
    <div className="stat-grid">
      <section className="card stat-card"><span>Total recorded cost</span><b>${dashboard?.stats.monthlyCost ?? 0}</b></section>
      <section className="card stat-card"><span>Agents with budget</span><b>{agents.filter((agent) => agent.budgetMonthly).length}</b></section>
      <section className="card stat-card"><span>Costed tasks</span><b>{cards.filter((card) => card.costUsd).length}</b></section>
    </div>
    <div className="data-grid">
      <section className="card section-card">
        <h2>Agent budgets</h2>
        <div className="table-list">
          {agents.map((agent) => {
            const spent = Number(agent.spentThisMonth ?? 0);
            const budget = Number(agent.budgetMonthly ?? 0);
            const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
            return <div className="list-row" key={agent.id}>
              <b>{agent.name}</b><p>{agent.adapterType ?? 'mock'} / ${spent.toFixed(4)} {budget ? `/ $${budget.toFixed(2)} (${pct}%)` : '/ no monthly cap'}</p>
              <div style={{ height: 8, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--accent)' : 'var(--primary)' }} /></div>
            </div>;
          })}
        </div>
      </section>
      <section className="card section-card">
        <h2>Recent task costs</h2>
        <div className="table-list">{cards.filter((card) => card.costUsd).slice(0, 30).map((card) => <div className="list-row" key={card.id}><b>{card.title}</b><p>{card.columnStatus} / ${card.costUsd}</p></div>)}</div>
      </section>
    </div>
  </div>;
}
