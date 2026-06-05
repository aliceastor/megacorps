'use client';
import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
type KnowledgeDoc = { id: string; companyId: string; title: string; tags: string[]; body: string; updatedAt?: string };

export function KnowledgePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [selected, setSelected] = useState<KnowledgeDoc | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [body, setBody] = useState('');

  async function refresh(nextCompanyId = companyId) {
    const companyRows = await api<Company[]>('/api/companies');
    setCompanies(companyRows);
    const activeCompanyId = nextCompanyId || companyRows[0]?.id || '';
    setCompanyId(activeCompanyId);
    if (activeCompanyId) setDocs(await api<KnowledgeDoc[]>(`/api/knowledge-docs?companyId=${activeCompanyId}`));
  }

  useEffect(() => { void refresh(); }, []);

  function reset() { setSelected(null); setTitle(''); setTags(''); setBody(''); }
  function edit(doc: KnowledgeDoc) { setSelected(doc); setTitle(doc.title); setTags((doc.tags ?? []).join(', ')); setBody(doc.body); }

  async function save() {
    const payload = { companyId, title, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), body };
    if (selected) await api<KnowledgeDoc>(`/api/knowledge-docs/${selected.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api<KnowledgeDoc>('/api/knowledge-docs', { method: 'POST', body: JSON.stringify(payload) });
    reset();
    await refresh(companyId);
  }

  async function remove(doc: KnowledgeDoc) {
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    await api(`/api/knowledge-docs/${doc.id}`, { method: 'DELETE' });
    if (selected?.id === doc.id) reset();
    await refresh(companyId);
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head"><div><h1>Knowledge</h1><p>Markdown docs injected into agent prompts by company and tags.</p></div><button className="btn" onClick={reset}><Plus size={15} /> New doc</button></div>
    <div className="data-grid">
      <section className="card section-card">
        <label className="field-label">Company<select className="input" value={companyId} onChange={(event) => { setCompanyId(event.target.value); void refresh(event.target.value); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field-label">Title<input className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-label">Tags<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="api, backend, policy" /></label>
        <label className="field-label">Markdown<textarea className="input" rows={12} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={!title || !body || !companyId} onClick={save}><Save size={15} /> Save knowledge doc</button>
      </section>
      <section className="card section-card">
        <h2>Company docs</h2>
        <div className="table-list">
          {docs.map((doc) => <div className="list-row" key={doc.id}>
            <b>{doc.title}</b><p>{(doc.tags ?? []).join(', ') || 'general'} / {doc.updatedAt ? new Date(doc.updatedAt).toLocaleString() : ''}</p>
            <div className="action-row"><button className="btn" onClick={() => edit(doc)}>Edit</button><button className="btn" style={{ color: 'var(--danger)' }} onClick={() => remove(doc)}><Trash2 size={14} /> Delete</button></div>
          </div>)}
        </div>
      </section>
    </div>
  </div>;
}
