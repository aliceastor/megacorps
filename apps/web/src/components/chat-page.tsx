'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Circle, Loader2, MessageSquare, Plus, Send } from 'lucide-react';
import { ApiError, api } from '@/lib/api';

type Company = { id: string; name: string; slug: string };
type Agent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  adapterType?: string | null;
  isActive?: boolean | null;
  isBusy?: boolean | null;
};
type ChatSession = {
  id: string;
  companyId: string;
  agentId: string;
  title: string;
  status: string;
  agentSessionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
type ChatMessage = {
  id: string;
  sessionId: string;
  companyId: string;
  agentId: string;
  userId?: string | null;
  authorType: 'user' | 'agent' | 'system';
  body: string;
  metadata?: Record<string, unknown>;
  costUsd?: string | null;
  durationSeconds?: number | null;
  createdAt?: string;
};

type ChatSendResult = {
  session?: ChatSession;
  userMessage?: ChatMessage;
  agentMessage?: ChatMessage;
  systemMessage?: ChatMessage;
};

function shortTime(value?: string): string {
  return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function agentStatus(agent?: Agent | null): { label: string; color: string } {
  if (!agent) return { label: 'No agent', color: 'var(--muted)' };
  if (agent.isActive === false) return { label: 'Paused', color: 'var(--danger)' };
  if (agent.isBusy) return { label: 'Busy', color: 'var(--success)' };
  return { label: 'Idle', color: 'var(--primary)' };
}

export function ChatPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const messageEndRef = useRef<HTMLDivElement>(null);

  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? null;
  const status = agentStatus(selectedAgent);

  async function refreshBase() {
    setLoading(true);
    setError('');
    try {
      const [companyRows, agentRows] = await Promise.all([
        api<Company[]>('/api/companies'),
        api<Agent[]>('/api/agents'),
      ]);
      setCompanies(companyRows);
      setAgents(agentRows);
      const nextCompany = companyRows.find((company) => company.id === companyId) ?? companyRows[0];
      const nextAgent = nextCompany ? agentRows.find((agent) => agent.companyId === nextCompany.id && agent.id === agentId) ?? agentRows.find((agent) => agent.companyId === nextCompany.id) : undefined;
      setCompanyId(nextCompany?.id ?? '');
      setAgentId(nextAgent?.id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chat data');
    } finally {
      setLoading(false);
    }
  }

  async function loadSessions(nextAgentId = agentId, nextCompanyId = companyId) {
    if (!nextAgentId || !nextCompanyId) {
      setSessions([]);
      setSessionId('');
      setMessages([]);
      return;
    }
    const rows = await api<ChatSession[]>(`/api/chat/sessions?companyId=${nextCompanyId}&agentId=${nextAgentId}`);
    setSessions(rows);
    const nextSession = rows.find((session) => session.id === sessionId) ?? rows[0];
    setSessionId(nextSession?.id ?? '');
    if (!nextSession) setMessages([]);
  }

  async function loadMessages(nextSessionId = sessionId) {
    if (!nextSessionId) {
      setMessages([]);
      return;
    }
    const rows = await api<ChatMessage[]>(`/api/chat/sessions/${nextSessionId}/messages`);
    setMessages(rows);
  }

  useEffect(() => { void refreshBase(); }, []);
  useEffect(() => {
    if (!companyId) return;
    if (!companyAgents.some((agent) => agent.id === agentId)) {
      setAgentId(companyAgents[0]?.id ?? '');
      setSessionId('');
      setMessages([]);
    }
  }, [companyId, companyAgents, agentId]);
  useEffect(() => { void loadSessions(); }, [agentId, companyId]);
  useEffect(() => { void loadMessages(); }, [sessionId]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length]);

  async function createSession(select = true): Promise<ChatSession | null> {
    if (!companyId || !agentId || !selectedAgent) return null;
    setError('');
    const session = await api<ChatSession>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ companyId, agentId, title: `Chat with ${selectedAgent.name}` }),
    });
    setSessions((current) => [session, ...current]);
    if (select) {
      setSessionId(session.id);
      setMessages([]);
    }
    return session;
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || sending || !agentId) return;
    setSending(true);
    setError('');
    setDraft('');
    try {
      const target = selectedSession ?? await createSession(false);
      if (!target) throw new Error('No chat session available');
      setSessionId(target.id);
      const result = await api<ChatSendResult>(`/api/chat/sessions/${target.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      const nextMessages = [result.userMessage, result.agentMessage, result.systemMessage].filter(Boolean) as ChatMessage[];
      setMessages((current) => [...current, ...nextMessages]);
      if (result.session) setSessions((current) => current.map((session) => session.id === result.session?.id ? result.session : session));
      await loadSessions(agentId, companyId);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const data = apiError?.data as Partial<ChatSendResult> | undefined;
      const nextMessages = [data?.userMessage, data?.agentMessage, data?.systemMessage].filter(Boolean) as ChatMessage[];
      if (nextMessages.length) setMessages((current) => [...current, ...nextMessages]);
      setError(err instanceof Error ? err.message : 'Message failed');
    } finally {
      setSending(false);
    }
  }

  return <div className="chat-page">
    <div className="page-head">
      <div><h1>Direct Chat</h1><p>{selectedCompany ? selectedCompany.name : 'Company'} / {selectedAgent ? selectedAgent.name : 'Agent sessions'}</p></div>
      <button className="btn" onClick={() => void refreshBase()} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <MessageSquare size={14} />} Refresh</button>
    </div>

    {error && <p className="form-error">{error}</p>}

    <section className="card chat-shell">
      <aside className="chat-rail company-rail">
        <div className="chat-rail-head"><Building2 size={16} /><b>Companies</b></div>
        <div className="chat-list">
          {companies.map((company) => <button className={`chat-list-item ${company.id === companyId ? 'active' : ''}`} key={company.id} onClick={() => { setCompanyId(company.id); setSessionId(''); setMessages([]); }}>
            <b>{company.name}</b>
            <span>{agents.filter((agent) => agent.companyId === company.id).length} agents</span>
          </button>)}
        </div>
        <div className="chat-rail-head"><MessageSquare size={16} /><b>Agents</b></div>
        <div className="chat-list">
          {companyAgents.map((agent) => {
            const itemStatus = agentStatus(agent);
            return <button className={`chat-list-item agent ${agent.id === agentId ? 'active' : ''}`} key={agent.id} onClick={() => { setAgentId(agent.id); setSessionId(''); setMessages([]); }}>
              <span className="chat-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
              <span><b>{agent.name}</b><small>{agent.role}</small></span>
              <Circle size={10} fill={itemStatus.color} color={itemStatus.color} />
            </button>;
          })}
          {!companyAgents.length && <p className="chat-empty">No agents</p>}
        </div>
      </aside>

      <aside className="chat-rail session-rail">
        <div className="chat-rail-head">
          <div><b>Sessions</b><span>{selectedAgent?.adapterType ?? 'adapter'}</span></div>
          <button className="btn icon-btn" aria-label="New session" onClick={() => void createSession()} disabled={!agentId}><Plus size={15} /></button>
        </div>
        <div className="chat-agent-card">
          <span className="chat-avatar large">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
          <div><b>{selectedAgent?.name ?? 'No agent'}</b><span>{selectedAgent?.title || selectedAgent?.role || 'No identity'}</span></div>
          <em style={{ color: status.color }}>{status.label}</em>
        </div>
        <div className="chat-list">
          {sessions.map((session) => <button className={`chat-list-item ${session.id === sessionId ? 'active' : ''}`} key={session.id} onClick={() => setSessionId(session.id)}>
            <b>{session.title}</b>
            <span>{shortTime(session.updatedAt)} / {session.agentSessionId ? 'resumable' : 'new'}</span>
          </button>)}
          {!sessions.length && <p className="chat-empty">No sessions</p>}
        </div>
      </aside>

      <section className="chat-thread">
        <header className="chat-thread-head">
          <div className="chat-agent-card compact-card">
            <span className="chat-avatar">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
            <div><b>{selectedAgent?.name ?? 'Select an agent'}</b><span>{selectedSession?.title ?? 'New session'}</span></div>
          </div>
          <span className="status-pill" style={{ color: status.color }}>{status.label}</span>
        </header>
        <div className="chat-messages">
          {messages.map((message) => <article className={`chat-bubble ${message.authorType}`} key={message.id}>
            <div>{message.body}</div>
            <span>{message.authorType} / {shortTime(message.createdAt)}{message.costUsd ? ` / $${message.costUsd}` : ''}</span>
          </article>)}
          {!messages.length && <div className="chat-empty-state">
            <MessageSquare size={24} />
            <b>{selectedAgent ? selectedAgent.name : 'Direct chat'}</b>
            <span>{selectedSession ? selectedSession.title : 'New session'}</span>
          </div>}
          <div ref={messageEndRef} />
        </div>
        <footer className="chat-composer">
          <textarea className="input" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void sendMessage();
          }} placeholder="Message" />
          <button className="btn btn-primary icon-btn" aria-label="Send message" onClick={() => void sendMessage()} disabled={sending || !draft.trim() || !agentId}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </footer>
      </section>
    </section>
  </div>;
}
