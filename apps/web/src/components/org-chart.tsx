'use client';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Agent = { id: string; name: string; role: string; title?: string; hermesProfile?: string; adapterType?: string; bossId?: string; isBusy?: boolean; isActive?: boolean; budgetMonthly?: string; spentThisMonth?: string };

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
    style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 12, background: type === 'error' ? '#ef4444' : '#22c55e', color: '#fff', fontSize: 14, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
    {message}
  </motion.div>;
}

export function OrgChart() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [profile, setProfile] = useState('alice');
  const [adapterType, setAdapterType] = useState('hermes');
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Agent[]>('/api/agents').then(setAgents).catch(() => setToast({ message: 'Failed to load agents', type: 'error' })).finally(() => setLoading(false));
  }, []);

  // Auto-generate slug from name
  useEffect(() => {
    setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }, [name]);

  async function create() {
    if (!name.trim()) { setToast({ message: 'Agent name is required', type: 'error' }); return; }
    if (!slug.trim()) { setToast({ message: 'Slug is required', type: 'error' }); return; }
    setCreating(true);
    try {
      const a = await api<Agent>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), role: 'worker', title: 'Hermes Agent', adapterType, hermesProfile: profile }),
      });
      setAgents([...agents, a]);
      setName('');
      setSlug('');
      setToast({ message: `Agent "${a.name}" created!`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to create agent', type: 'error' });
    } finally {
      setCreating(false);
    }
  }

  async function testConnection(agentId: string) {
    setTesting(agentId);
    try {
      await api(`/api/agents/${agentId}/test-connection`, { method: 'POST' });
      setToast({ message: 'Connection successful!', type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Connection failed', type: 'error' });
    } finally {
      setTesting(null);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    try {
      await api(`/api/agents/${agentId}`, { method: 'DELETE' });
      setAgents(agents.filter((a) => a.id !== agentId));
      setToast({ message: `Agent "${agentName}" deleted`, type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Failed to delete', type: 'error' });
    }
  }

  return <>
    {/* Create Agent Form */}
    <div className="card" style={{ padding: 16, display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <input className="input" placeholder="Agent Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
      <input className="input" placeholder="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: 1, minWidth: 100 }} />
      <input className="input" placeholder="Hermes Profile" value={profile} onChange={(e) => setProfile(e.target.value)} style={{ flex: 1, minWidth: 100 }} />
      <select className="input" value={adapterType} onChange={(e) => setAdapterType(e.target.value)} style={{ minWidth: 140 }}>
        <option value="hermes">Hermes (Portainer)</option>
        <option value="hermes-gateway">Hermes (HTTP API)</option>
      </select>
      <button className="btn btn-primary" onClick={create} disabled={creating} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} New Agent
      </button>
    </div>

    {loading ? <p style={{ textAlign: 'center', opacity: 0.5 }}>Loading...</p> : (
      <div style={{ display: 'flex', gap: 20, alignItems: 'start', flexWrap: 'wrap' }}>
        <AnimatePresence>
          {agents.map((a, i) => (
            <motion.div className="card" key={a.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ delay: i * 0.05, duration: 0.3 }}
              style={{ padding: 16, minWidth: 240, borderRadius: 12, position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 99, background: a.isBusy ? '#22c55e' : a.isActive ? '#60a5fa' : '#94a3b8' }} />
                <b style={{ fontSize: 16 }}>{a.name}</b>
              </div>
              <div style={{ fontSize: 13, opacity: 0.7, display: 'grid', gap: 4 }}>
                <p>Role: {a.role}</p>
                <p>Profile: {a.hermesProfile ?? 'none'}</p>
                <p>Adapter: {a.adapterType ?? 'hermes'}</p>
                {a.budgetMonthly && <p>Budget: ${a.spentThisMonth ?? '0'} / ${a.budgetMonthly}</p>}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => testConnection(a.id)} disabled={testing === a.id} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 12 }}>
                  {testing === a.id ? <Loader2 size={12} /> : <Wifi size={12} />} Test
                </button>
                <button className="btn" onClick={() => deleteAgent(a.id, a.name)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#ef4444' }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    )}

    <AnimatePresence>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </AnimatePresence>
  </>;
}
