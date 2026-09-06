'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

type Company = { id: string; name: string };
type KnowledgeDoc = { id: string; companyId: string; title: string; tags: string[]; body: string; updatedAt?: string };

function formatTimestamp(value?: string): string {
  if (!value) return 'not updated';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'not updated';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function KnowledgePage() {
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: () => api<Company[]>('/api/companies'), retry: false });
  const companies = companiesQuery.data ?? [];
  const [requestedCompanyId, setCompanyId] = useState('');
  const companyId = companies.some(company => company.id === requestedCompanyId) ? requestedCompanyId : companies[0]?.id ?? '';
  const docsQuery = useQuery({ queryKey: ['knowledge-docs', companyId], queryFn: ({ signal }) => api<KnowledgeDoc[]>(`/api/knowledge-docs?companyId=${companyId}`, { signal }), enabled: Boolean(companyId), retry: false });
  const docs = docsQuery.data ?? [];
  const [selected, setSelected] = useState<KnowledgeDoc | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const readError = companiesQuery.error ?? docsQuery.error;
  const loading = companiesQuery.isPending || Boolean(companyId && docsQuery.isPending);

  useEffect(() => { reset(); setWriteError(''); }, [companyId]);

  function reset() { setSelected(null); setTitle(''); setTags(''); setBody(''); }
  function edit(doc: KnowledgeDoc) { setSelected(doc); setTitle(doc.title); setTags((doc.tags ?? []).join(', ')); setBody(doc.body); }

  async function save() {
    if (busy || !companyId || (selected && selected.companyId !== companyId)) return;
    setBusy(true); setWriteError('');
    const payload = { companyId, title, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), body };
    try {
      if (selected) await api<KnowledgeDoc>(`/api/knowledge-docs/${selected.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api<KnowledgeDoc>('/api/knowledge-docs', { method: 'POST', body: JSON.stringify(payload) });
      reset();
      await docsQuery.refetch();
    } catch (error) { setWriteError(error instanceof Error ? error.message : 'Unable to save document.'); }
    finally { setBusy(false); }
  }

  async function remove(doc: KnowledgeDoc) {
    if (busy || doc.companyId !== companyId) return;
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    setBusy(true); setWriteError('');
    try {
      await api(`/api/knowledge-docs/${doc.id}`, { method: 'DELETE' });
      if (selected?.id === doc.id) reset();
      await docsQuery.refetch();
    } catch (error) { setWriteError(error instanceof Error ? error.message : 'Unable to delete document.'); }
    finally { setBusy(false); }
  }

  return <div className="page-stack knowledge-page">
    <div className="page-head"><div><h1>Knowledge</h1><p>Markdown docs injected into agent prompts by company and tags.</p></div><button className="btn" disabled={busy} onClick={() => { reset(); setWriteError(''); }}><Plus size={15} /> New doc</button></div>
    {readError && <div role="alert" className="form-error">{readError.message} <button className="btn" onClick={() => { if (companiesQuery.error) void companiesQuery.refetch(); else void docsQuery.refetch(); }}>Retry</button></div>}
    {writeError && <p role="alert" className="form-error">{writeError}</p>}
    {loading && <p role="status">Loading company docs...</p>}
    {!companiesQuery.isPending && !companiesQuery.error && companies.length === 0 && <p>Create a company to add shared guidance.</p>}
    <div className="data-grid">
      <section className="card section-card">
        <label className="field-label">Company<select className="input" value={companyId} disabled={busy} onChange={(event) => { reset(); setWriteError(''); setCompanyId(event.target.value); }}>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        <label className="field-label">Title<input className="input" disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-label">Tags<input className="input" disabled={busy} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="api, backend, policy" /></label>
        <label className="field-label">Markdown<textarea className="input" disabled={busy} rows={12} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || loading || Boolean(readError) || !title.trim() || !body.trim() || !companyId} onClick={save}><Save size={15} /> Save knowledge doc</button>
      </section>
      <section className="card section-card">
        <h2>Company docs</h2>
        <div className="table-list">
          {docs.map((doc) => <div className="list-row knowledge-doc-row" key={doc.id}>
            <b>{doc.title}</b>
            <div className="knowledge-doc-meta">
              {(doc.tags?.length ? doc.tags : ['general']).map((tag) => <span className="badge" key={tag}>{tag}</span>)}
              <span>Updated {formatTimestamp(doc.updatedAt)}</span>
            </div>
            <div className="action-row"><button className="btn" disabled={busy || Boolean(readError)} onClick={() => { edit(doc); setWriteError(''); }}>Edit</button><button className="btn" disabled={busy || Boolean(readError)} style={{ color: 'var(--danger)' }} onClick={() => remove(doc)}><Trash2 size={14} /> Delete</button></div>
          </div>)}
        </div>
      </section>
    </div>
  </div>;
}
