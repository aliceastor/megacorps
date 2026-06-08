'use client';
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Copy, ExternalLink, Search } from 'lucide-react';
import { api, API_URL } from '@/lib/api';

type ApiEndpoint = {
  method: string;
  path: string;
  group: string;
  auth: 'none' | 'session';
  requiredRole?: string;
  summary: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  response?: string;
  responseSchema?: unknown;
  responseExample?: unknown;
  rateLimit?: string;
  notes?: string[];
};

type ArchitectureSurface = {
  name: string;
  route: string;
  purpose: string;
  primaryApi: string[];
};

type ApiHelp = {
  service: string;
  help: { json: string; markdown: string; ui: string };
  architecture?: {
    model: string;
    sourceOfTruth: string[];
    surfaces: ArchitectureSurface[];
    multiAgentNotes: string[];
    remainingGaps?: string[];
  };
  auth: { mode: string; login: string; signup: string; bootstrap?: string; admin?: string };
  rateLimits?: { enforced: boolean; summary: string; productionRecommendation: string };
  kanban: { stages: string[]; legacyAliases: Record<string, string>; note: string };
  adapters: string[];
  endpoints: ApiEndpoint[];
};

function CodeBlock({ value }: { value: unknown }) {
  return <pre className="log-block">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  return <article className="list-row help-endpoint">
    <div className="help-endpoint-head">
      <span className={`method-pill method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
      <code>{endpoint.path}</code>
      <span className="status-pill">{endpoint.auth}</span>
      <span className="status-pill">{endpoint.requiredRole ?? 'none'}</span>
    </div>
    <p>{endpoint.summary}</p>
    {endpoint.params && <><b>Params</b><CodeBlock value={endpoint.params} /></>}
    {endpoint.query && <><b>Query</b><CodeBlock value={endpoint.query} /></>}
    {endpoint.body !== undefined && <><b>Body</b><CodeBlock value={endpoint.body} /></>}
    {endpoint.response && <><b>Response</b><p>{endpoint.response}</p></>}
    {endpoint.responseSchema !== undefined && <><b>Response schema</b><CodeBlock value={endpoint.responseSchema} /></>}
    {endpoint.responseExample !== undefined && <><b>Response example</b><CodeBlock value={endpoint.responseExample} /></>}
    {endpoint.rateLimit && <><b>Rate limit</b><p>{endpoint.rateLimit}</p></>}
    {endpoint.notes?.map((note) => <p key={note}>{note}</p>)}
  </article>;
}

export function HelpPage() {
  const [help, setHelp] = useState<ApiHelp | null>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<ApiHelp>('/api/help')
      .then(setHelp)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load API help'));
  }, []);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase();
    if (!help) return [];
    if (!terms) return help.endpoints;
    return help.endpoints.filter((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.group} ${endpoint.summary}`.toLowerCase().includes(terms));
  }, [help, query]);

  const groups = useMemo(() => Array.from(new Set(filtered.map((endpoint) => endpoint.group))), [filtered]);
  const markdownUrl = `${API_URL}/api/help?format=markdown`;
  const jsonUrl = `${API_URL}/api/help`;

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1600);
  }

  if (error) return <p className="form-error">{error}</p>;
  if (!help) return <p style={{ color: 'var(--muted)' }}>Loading API help...</p>;

  return <div style={{ display: 'grid', gap: 16 }}>
    <div className="page-head">
      <div>
        <h1>Help</h1>
        <p>API catalog, Kanban stages, adapter types, and agent-facing integration notes.</p>
      </div>
      <a className="btn btn-primary" href={markdownUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Markdown API</a>
    </div>

    {copied && <p className="status-pill">{copied} copied</p>}

    <div className="stat-grid">
      <section className="card stat-card"><span>Endpoints</span><b>{help.endpoints.length}</b></section>
      <section className="card stat-card"><span>Kanban stages</span><b>{help.kanban.stages.length}</b></section>
      <section className="card stat-card"><span>Adapters</span><b>{help.adapters.length}</b></section>
      <section className="card stat-card"><span>Surfaces</span><b>{help.architecture?.surfaces.length ?? 0}</b></section>
    </div>

    {help.architecture && <section className="card section-card">
      <div className="panel-title">
        <div><h2>Current Architecture</h2><p style={{ margin: 0, color: 'var(--muted)' }}>{help.architecture.model}</p></div>
        <BookOpen size={18} />
      </div>
      <div className="help-architecture-grid">
        {help.architecture.surfaces.map((surface) => <article className="list-row help-surface" key={surface.name}>
          <div className="help-surface-head"><b>{surface.name}</b><code>{surface.route}</code></div>
          <p>{surface.purpose}</p>
          <div className="help-api-list">{surface.primaryApi.map((item) => <code key={item}>{item}</code>)}</div>
        </article>)}
      </div>
      <div className="data-grid">
        <div className="list-row">
          <b>Source of truth</b>
          <ul className="help-note-list">{help.architecture.sourceOfTruth.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div className="list-row">
          <b>Multi-agent notes</b>
          <ul className="help-note-list">{help.architecture.multiAgentNotes.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      {help.architecture.remainingGaps?.length ? <div className="list-row">
        <b>Remaining production gaps</b>
        <ul className="help-note-list">{help.architecture.remainingGaps.map((item) => <li key={item}>{item}</li>)}</ul>
      </div> : null}
    </section>}

    <section className="card section-card">
      <div className="panel-title">
        <div><h2>Agent API entrypoint</h2><p style={{ margin: 0, color: 'var(--muted)' }}>Agents can start here to discover every MegaCorps API route.</p></div>
        <BookOpen size={18} />
      </div>
      <div className="form-grid">
        <div className="list-row">
          <b>JSON catalog</b>
          <p><code>{jsonUrl}</code></p>
          <button className="btn" onClick={() => copy(jsonUrl, 'JSON catalog')}><Copy size={14} /> Copy</button>
        </div>
        <div className="list-row">
          <b>Markdown catalog</b>
          <p><code>{markdownUrl}</code></p>
          <button className="btn" onClick={() => copy(markdownUrl, 'Markdown catalog')}><Copy size={14} /> Copy</button>
        </div>
      </div>
      <div className="meta-grid">
        <span>Auth <b>{help.auth.mode}</b></span>
        <span>Stages <b>{help.kanban.stages.join(', ')}</b></span>
        <span>Legacy alias <b>{Object.entries(help.kanban.legacyAliases).map(([from, to]) => `${from} -> ${to}`).join(', ')}</b></span>
        <span>Adapters <b>{help.adapters.join(', ')}</b></span>
        <span>Rate limits <b>{help.rateLimits?.enforced ? 'enabled' : 'not enforced in app'}</b></span>
      </div>
      {help.rateLimits && <p style={{ color: 'var(--muted)', margin: 0 }}>{help.rateLimits.summary}</p>}
    </section>

    <div className="kanban-toolbar">
      <div className="input-wrap" style={{ flex: '1 1 280px' }}><Search size={15} /><input placeholder="Search APIs" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    </div>

    {groups.map((group) => <section className="card section-card" key={group}>
      <div className="panel-title"><h2>{group}</h2><span className="status-pill">{filtered.filter((endpoint) => endpoint.group === group).length} endpoints</span></div>
      <div className="table-list">
        {filtered.filter((endpoint) => endpoint.group === group).map((endpoint) => <EndpointCard endpoint={endpoint} key={`${endpoint.method} ${endpoint.path}`} />)}
      </div>
    </section>)}
  </div>;
}
