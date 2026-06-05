'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Loader2, Pause, Plus, RotateCcw, Trash2, Wifi } from 'lucide-react';
import { api } from '@/lib/api';

type Agent = {
  id: string;
  name: string;
  slug: string;
  role: string;
  title?: string;
  hermesProfile?: string;
  adapterType?: string;
  bossId?: string | null;
  isBusy?: boolean;
  isActive?: boolean;
  budgetMonthly?: string;
  spentThisMonth?: string;
  currentSessionId?: string | null;
};

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 18px', borderRadius: 8, background: type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontSize: 14, zIndex: 200 }}>
    {message}
  </motion.div>;
}

export function OrgChart() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [profile, setProfile] = useState('local-debug');
  const [role, setRole] = useState('worker');
  const [bossId, setBossId] = useState('');
  const [adapterType, setAdapterType] = useState('mock');
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await api<Agent[]>('/api/agents');
      setAgents(rows);
      if (selected) setSelected(rows.find((agent) => agent.id === selected.id) ?? null);
    } catch {
      setToast({ message: 'Failed to load agents', type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }, [name]);

  async function create() {
    if (!name.trim() || !slug.trim()) { setToast({ message: 'Name and slug are required', type: 'error' }); return; }
    setCreating(true);
    try {
      const agent = await api<Agent>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), role, title: role === 'ceo' ? 'CEO Agent' : 'Hermes Agent', adapterType, hermesProfile: profile, bossId: bossId || null }),
      });
      setAgents([...agents, agent]);
      setName('');
      setSlug('');
      setBossId('');
      setToast({ message: `Agent "${agent.name}" created`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create agent', type: 'error' });
    } finally {
      setCreating(false);
    }
  }

  async function agentAction(agentId: string, path: string, message: string) {
    setTesting(agentId);
    try {
      const result = await api<Agent | { ok: true }>(path, { method: 'POST' });
      if ('id' in result) setAgents(agents.map((agent) => (agent.id === result.id ? result : agent)));
      setToast({ message, type: 'success' });
      await refresh();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Action failed', type: 'error' });
    } finally {
      setTesting(null);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    try {
      await api(`/api/agents/${agentId}`, { method: 'DELETE' });
      setAgents(agents.filter((agent) => agent.id !== agentId));
      setSelected(null);
      setToast({ message: `Agent "${agentName}" deleted`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to delete', type: 'error' });
    }
  }

  const roots = agents.filter((agent) => !agent.bossId);

  return <>
    <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(6, minmax(120px, 1fr)) auto', gap: 8, marginBottom: 16, alignItems: 'center' }}>
      <input className="input" placeholder="Agent Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input" placeholder="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <input className="input" placeholder="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="worker">Worker</option><option value="reviewer">Reviewer</option><option value="ceo">CEO</option></select>
      <select className="input" value={bossId} onChange={(e) => setBossId(e.target.value)}><option value="">Boss</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
      <select className="input" value={adapterType} onChange={(e) => setAdapterType(e.target.value)}>
        <option value="mock">Mock</option>
        <option value="hermes">Hermes Portainer</option>
        <option value="hermes-gateway">Hermes HTTP API</option>
        <option value="webhook">Webhook</option>
      </select>
      <button className="btn btn-primary" onClick={create} disabled={creating}>{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} New</button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'start', flexWrap: 'wrap' }}>
          <AnimatePresence>
            {(roots.length ? roots : agents).map((agent) => <AgentNode key={agent.id} agent={agent} agents={agents} selectedId={selected?.id} onSelect={setSelected} />)}
          </AnimatePresence>
        </div>
        {selected && (
          <motion.section className="card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div className="panel-title">
              <div><h2>{selected.name}</h2><span className="status-pill">{selected.isBusy ? 'busy' : selected.isActive ? 'idle' : 'offline'}</span></div>
              <button className="btn" onClick={() => setSelected(null)}>Close</button>
            </div>
            <div className="meta-grid">
              <span>Role <b>{selected.role}</b></span>
              <span>Adapter <b>{selected.adapterType ?? 'hermes'}</b></span>
              <span>Profile <b>{selected.hermesProfile ?? 'none'}</b></span>
              <span>Session <b>{selected.currentSessionId ?? 'none'}</b></span>
              <span>Budget <b>${selected.spentThisMonth ?? '0'} / ${selected.budgetMonthly ?? 'none'}</b></span>
            </div>
            <div className="action-row">
              <button className="btn" disabled={testing === selected.id} onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/test-connection`, 'Connection successful')}><Wifi size={14} /> Test</button>
              {selected.isActive ? <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/pause`, 'Agent paused')}><Pause size={14} /> Pause</button> : <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/resume`, 'Agent resumed')}><CheckCircle2 size={14} /> Resume</button>}
              <button className="btn" onClick={() => agentAction(selected.id, `/api/agents/${selected.id}/reset-session`, 'Session reset')}><RotateCcw size={14} /> Reset Session</button>
              <button className="btn" onClick={() => deleteAgent(selected.id, selected.name)} style={{ color: '#dc2626' }}><Trash2 size={14} /> Fire</button>
            </div>
          </motion.section>
        )}
      </div>
    )}

    <AnimatePresence>{toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}</AnimatePresence>
  </>;
}

function AgentNode({ agent, agents, selectedId, onSelect }: { agent: Agent; agents: Agent[]; selectedId?: string; onSelect: (agent: Agent) => void }) {
  const children = agents.filter((item) => item.bossId === agent.id);
  return <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} style={{ display: 'grid', gap: 10 }}>
    <button className="card" onClick={() => onSelect(agent)} style={{ padding: 14, minWidth: 250, textAlign: 'left', borderColor: selectedId === agent.id ? 'var(--primary)' : 'var(--border)', cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: agent.isBusy ? '#16a34a' : agent.isActive ? '#3b82f6' : '#94a3b8' }} />
        <b>{agent.name}</b>
        {!agent.isActive && <Ban size={14} style={{ marginLeft: 'auto', color: '#dc2626' }} />}
      </div>
      <div style={{ fontSize: 13, opacity: 0.72, display: 'grid', gap: 4 }}>
        <span>{agent.role} / {agent.adapterType ?? 'hermes'}</span>
        <span>{agent.hermesProfile ?? 'no-profile'}</span>
      </div>
    </button>
    {children.length > 0 && <div style={{ marginLeft: 28, paddingLeft: 16, borderLeft: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {children.map((child) => <AgentNode key={child.id} agent={child} agents={agents} selectedId={selectedId} onSelect={onSelect} />)}
    </div>}
  </motion.div>;
}
