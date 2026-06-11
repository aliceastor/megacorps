'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BriefcaseBusiness, Building2, Circle, Loader2, MessageSquare, Plus, Send } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';
import { Markdown } from './markdown';

type Company = { id: string; name: string; slug: string };
type Project = { id: string; companyId: string; name: string; description?: string | null };
type Agent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  adapterType?: string | null;
  isActive?: boolean | null;
  isBusy?: boolean | null;
};
type ChatSession = {
  id: string;
  companyId: string;
  agentId: string;
  projectId?: string | null;
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

type LiveEvent = {
  type: string;
  sessionId?: string | null;
  data?: Record<string, unknown>;
};

function pendingUserMessage(session: ChatSession, body: string): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: session.id,
    companyId: session.companyId,
    agentId: session.agentId,
    authorType: 'user',
    body,
    metadata: { pending: true },
    createdAt: new Date().toISOString(),
  };
}

function mergeMessages(current: ChatMessage[], nextMessages: ChatMessage[], replaceId?: string): ChatMessage[] {
  const nextIds = new Set(nextMessages.map((message) => message.id));
  const confirmedKeys = new Set([...current, ...nextMessages]
    .filter((message) => !message.metadata?.pending)
    .map((message) => `${message.sessionId}:${message.authorType}:${message.body}`));
  const isMatchedPending = (message: ChatMessage) => Boolean(message.metadata?.pending && confirmedKeys.has(`${message.sessionId}:${message.authorType}:${message.body}`));
  return [
    ...current.filter((message) => message.id !== replaceId && !nextIds.has(message.id) && !isMatchedPending(message)),
    ...nextMessages.filter((message) => !isMatchedPending(message)),
  ];
}

function shortTime(value?: string): string {
  return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function agentStatus(agent?: Agent | null): { label: string; color: string } {
  if (!agent) return { label: 'No agent', color: 'var(--muted)' };
  if (agent.isActive === false) return { label: 'Paused', color: 'var(--danger)' };
  if (agent.isBusy) return { label: 'Busy', color: 'var(--success)' };
  return { label: 'Idle', color: 'var(--primary)' };
}

function fetchCompanies(): Promise<Company[]> {
  return api<Company[]>('/api/companies');
}

function fetchAgents(): Promise<Agent[]> {
  return api<Agent[]>('/api/agents');
}

function fetchProjects(): Promise<Project[]> {
  return api<Project[]>('/api/projects');
}

async function fetchChatSessions(companyId: string, agentId: string, projectFilter: string): Promise<ChatSession[]> {
  const projectQuery = projectFilter === 'all' ? '' : `&projectId=${projectFilter === '__none' ? 'none' : projectFilter}`;
  return api<ChatSession[]>(`/api/chat/sessions?companyId=${companyId}&agentId=${agentId}${projectQuery}`);
}

async function fetchChatMessages(sessionId: string): Promise<ChatMessage[]> {
  return api<ChatMessage[]>(`/api/chat/sessions/${sessionId}/messages`);
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const { t } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sessionId, setSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [replyingSessionId, setReplyingSessionId] = useState<string | null>(null);
  const [partialReply, setPartialReply] = useState('');
  const [error, setError] = useState('');
  const messageEndRef = useRef<HTMLDivElement>(null);
  const companiesQuery = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: fetchAgents });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const sessionsQuery = useQuery({
    queryKey: ['chatSessions', companyId, agentId, projectFilter],
    queryFn: () => fetchChatSessions(companyId, agentId, projectFilter),
    enabled: Boolean(companyId && agentId),
  });
  const messagesQuery = useQuery({
    queryKey: ['chatMessages', sessionId],
    queryFn: () => fetchChatMessages(sessionId),
    enabled: Boolean(sessionId),
  });

  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const companyProjects = useMemo(() => projects.filter((project) => project.companyId === companyId), [projects, companyId]);
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const selectedProject = projectFilter !== 'all' && projectFilter !== '__none' ? projects.find((project) => project.id === projectFilter) ?? null : null;
  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? null;
  const status = agentStatus(selectedAgent);

  async function refreshBase() {
    setLoading(true);
    setError('');
    try {
      const [companyRows, agentRows, projectRows] = await Promise.all([
        queryClient.fetchQuery({ queryKey: ['companies'], queryFn: fetchCompanies }),
        queryClient.fetchQuery({ queryKey: ['agents'], queryFn: fetchAgents }),
        queryClient.fetchQuery({ queryKey: ['projects'], queryFn: fetchProjects }),
      ]);
      setCompanies(companyRows);
      setProjects(projectRows);
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

  async function loadSessions(nextAgentId = agentId, nextCompanyId = companyId, nextProjectFilter = projectFilter) {
    if (!nextAgentId || !nextCompanyId) {
      setSessions([]);
      setSessionId('');
      setMessages([]);
      return;
    }
    const rows = await queryClient.fetchQuery({
      queryKey: ['chatSessions', nextCompanyId, nextAgentId, nextProjectFilter],
      queryFn: () => fetchChatSessions(nextCompanyId, nextAgentId, nextProjectFilter),
    });
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
    const rows = await queryClient.fetchQuery({ queryKey: ['chatMessages', nextSessionId], queryFn: () => fetchChatMessages(nextSessionId) });
    setMessages((current) => {
      const pending = current.filter((message) => message.sessionId === nextSessionId && message.metadata?.pending);
      return mergeMessages(rows, pending);
    });
  }

  useEffect(() => {
    if (!companiesQuery.data || !agentsQuery.data || !projectsQuery.data) return;
    const companyRows = companiesQuery.data;
    const agentRows = agentsQuery.data;
    setCompanies(companyRows);
    setProjects(projectsQuery.data);
    setAgents(agentRows);
    const nextCompany = companyRows.find((company) => company.id === companyId) ?? companyRows[0];
    const nextAgent = nextCompany ? agentRows.find((agent) => agent.companyId === nextCompany.id && agent.id === agentId) ?? agentRows.find((agent) => agent.companyId === nextCompany.id) : undefined;
    setCompanyId(nextCompany?.id ?? '');
    setAgentId(nextAgent?.id ?? '');
    setLoading(false);
  }, [companiesQuery.data, agentsQuery.data, projectsQuery.data]);
  useEffect(() => {
    const baseError = companiesQuery.error ?? agentsQuery.error ?? projectsQuery.error;
    if (baseError) {
      setError(baseError instanceof Error ? baseError.message : 'Failed to load chat data');
      setLoading(false);
    }
  }, [companiesQuery.error, agentsQuery.error, projectsQuery.error]);
  useEffect(() => {
    if (!sessionsQuery.data) return;
    setSessions(sessionsQuery.data);
    const nextSession = sessionsQuery.data.find((session) => session.id === sessionId) ?? sessionsQuery.data[0];
    setSessionId(nextSession?.id ?? '');
    if (!nextSession) setMessages([]);
  }, [sessionsQuery.data]);
  useEffect(() => {
    if (!messagesQuery.data || !sessionId) return;
    setMessages((current) => {
      const pending = current.filter((message) => message.sessionId === sessionId && message.metadata?.pending);
      return mergeMessages(messagesQuery.data, pending);
    });
  }, [messagesQuery.data, sessionId]);
  useEffect(() => {
    if (!companyId) return;
    if (!companyAgents.some((agent) => agent.id === agentId)) {
      setAgentId(companyAgents[0]?.id ?? '');
      setSessionId('');
      setMessages([]);
    }
  }, [companyId, companyAgents, agentId]);
  useEffect(() => {
    if (projectFilter !== 'all' && projectFilter !== '__none' && !companyProjects.some((project) => project.id === projectFilter)) setProjectFilter('all');
  }, [companyProjects, projectFilter]);
  useEffect(() => { void loadSessions(); }, [agentId, companyId, projectFilter]);
  useEffect(() => { void loadMessages(); }, [sessionId]);
  useEffect(() => {
    if (selectedSession && selectedAgent?.isBusy) setReplyingSessionId(selectedSession.id);
  }, [selectedAgent?.isBusy, selectedSession?.id]);
  useEffect(() => {
    function onLive(event: Event) {
      const detail = (event as CustomEvent<LiveEvent>).detail;
      if (!detail?.type.startsWith('chat.')) return;
      if (detail.type === 'chat.reply.started' && detail.sessionId === sessionId) { setReplyingSessionId(sessionId); setPartialReply(''); }
      if (detail.type === 'chat.reply.partial' && detail.sessionId === sessionId) {
        const text = typeof detail.data?.text === 'string' ? detail.data.text : '';
        if (text) setPartialReply(text);
        return;
      }
      if (detail.type === 'chat.reply.finished' && detail.sessionId === sessionId) { setReplyingSessionId(null); setPartialReply(''); }
      if (detail.type === 'chat.message.created' && detail.sessionId === sessionId) setPartialReply('');
      if (detail.sessionId === sessionId) void loadMessages(detail.sessionId);
      void loadSessions(agentId, companyId, projectFilter);
    }
    window.addEventListener('megacorps-live', onLive);
    return () => window.removeEventListener('megacorps-live', onLive);
  }, [agentId, companyId, projectFilter, sessionId]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, replyingSessionId]);

  async function createSession(select = true): Promise<ChatSession | null> {
    if (!companyId || !agentId || !selectedAgent) return null;
    setError('');
    const session = await api<ChatSession>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ companyId, agentId, projectId: selectedProject?.id ?? null, title: `Chat with ${selectedAgent.name}` }),
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
    let optimisticId: string | undefined;
    try {
      const target = selectedSession ?? await createSession(false);
      if (!target) throw new Error('No chat session available');
      setSessionId(target.id);
      const optimistic = pendingUserMessage(target, body);
      optimisticId = optimistic.id;
      setMessages((current) => mergeMessages(current, [optimistic]));
      setReplyingSessionId(target.id);
      const result = await api<ChatSendResult>(`/api/chat/sessions/${target.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      const nextMessages = [result.userMessage, result.agentMessage, result.systemMessage].filter(Boolean) as ChatMessage[];
      setMessages((current) => mergeMessages(current, nextMessages, optimisticId));
      if (result.session) setSessions((current) => current.map((session) => session.id === result.session?.id ? result.session : session));
      void queryClient.invalidateQueries({ queryKey: ['chatMessages', target.id] });
      void queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      await loadSessions(agentId, companyId, projectFilter);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const data = apiError?.data as Partial<ChatSendResult> | undefined;
      const nextMessages = [data?.userMessage, data?.agentMessage, data?.systemMessage].filter(Boolean) as ChatMessage[];
      if (nextMessages.length) setMessages((current) => mergeMessages(current, nextMessages, optimisticId));
      if (selectedSession) void queryClient.invalidateQueries({ queryKey: ['chatMessages', selectedSession.id] });
      setError(err instanceof Error ? err.message : 'Message failed');
    } finally {
      setSending(false);
      setReplyingSessionId(null);
    }
  }

  return <div className="chat-page">
    <div className="page-head">
      <div><h1>Direct Chat</h1><p>{selectedCompany ? selectedCompany.name : 'Company'} / {selectedProject?.name ?? (projectFilter === '__none' ? 'No project' : 'All projects')} / {selectedAgent ? selectedAgent.name : 'Agent sessions'}</p></div>
      <button className="btn" onClick={() => void refreshBase()} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <MessageSquare size={14} />} Refresh</button>
    </div>

    {error && <p className="form-error">{error}</p>}

    <section className="card chat-shell">
      <aside className="chat-rail company-rail">
        <div className="chat-rail-head"><Building2 size={16} /><b>Companies</b></div>
        <div className="chat-list">
          {companies.map((company) => <button className={`chat-list-item ${company.id === companyId ? 'active' : ''}`} key={company.id} onClick={() => { setCompanyId(company.id); setProjectFilter('all'); setSessionId(''); setMessages([]); }}>
            <b>{company.name}</b>
            <span>{agents.filter((agent) => agent.companyId === company.id).length} agents</span>
          </button>)}
        </div>
        <div className="chat-rail-head"><BriefcaseBusiness size={16} /><b>Projects</b></div>
        <div className="chat-list">
          <button className={`chat-list-item ${projectFilter === 'all' ? 'active' : ''}`} onClick={() => { setProjectFilter('all'); setSessionId(''); setMessages([]); }}><b>All projects</b><span>{sessions.length} sessions</span></button>
          <button className={`chat-list-item ${projectFilter === '__none' ? 'active' : ''}`} onClick={() => { setProjectFilter('__none'); setSessionId(''); setMessages([]); }}><b>No project</b><span>General chat</span></button>
          {companyProjects.map((project) => <button className={`chat-list-item ${project.id === projectFilter ? 'active' : ''}`} key={project.id} onClick={() => { setProjectFilter(project.id); setSessionId(''); setMessages([]); }}>
            <b>{project.name}</b>
            <span>{project.description || 'Project chat'}</span>
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
          {!companyAgents.length && <p className="chat-empty">{t('chat.noAgents')}</p>}
        </div>
      </aside>

      <aside className="chat-rail session-rail">
        <div className="chat-rail-head">
          <div><b>Sessions</b><span>{selectedAgent?.adapterType ?? 'adapter'}</span></div>
          <button className="btn icon-btn" aria-label="New session" onClick={() => void createSession()} disabled={!agentId}><Plus size={15} /></button>
        </div>
        <div className="chat-agent-card">
          <span className="chat-avatar large">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
          <div><b>{selectedAgent?.name ?? 'No agent'}</b><span>{selectedAgent?.role || 'No identity'}</span></div>
          <em style={{ color: status.color }}>{status.label}</em>
        </div>
        <div className="chat-list">
          {sessions.map((session) => <button className={`chat-list-item ${session.id === sessionId ? 'active' : ''}`} key={session.id} onClick={() => setSessionId(session.id)}>
            <b>{session.title}</b>
            <span>{shortTime(session.updatedAt)} / {session.projectId ? projects.find((project) => project.id === session.projectId)?.name ?? 'project' : 'no project'} / {session.agentSessionId ? 'resumable' : 'new'}</span>
          </button>)}
          {!sessions.length && <p className="chat-empty">{t('chat.noSessions')}</p>}
        </div>
      </aside>

      <section className="chat-thread">
        <header className="chat-thread-head">
          <div className="chat-agent-card compact-card">
            <span className="chat-avatar">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
            <div><b>{selectedAgent?.name ?? t('chat.selectAgent')}</b><span>{selectedSession?.title ?? t('chat.newSession')}</span></div>
          </div>
          <span className="status-pill" style={{ color: status.color }}>{status.label}</span>
        </header>
        <div className="chat-messages">
          {messages.map((message) => <article className={`chat-bubble ${message.authorType}`} key={message.id}>
            {message.authorType === 'user' ? <div>{message.body}</div> : <Markdown text={message.body} />}
            <span>{message.authorType} / {message.metadata?.pending ? 'sending' : shortTime(message.createdAt)}{message.costUsd ? ` / $${message.costUsd}` : ''}</span>
          </article>)}
          {replyingSessionId === sessionId && <article className="chat-bubble agent typing-bubble" aria-live="polite">
            {partialReply && <div className="chat-partial-text"><Markdown text={partialReply} /></div>}
            <div className="typing-dots" aria-label={`${selectedAgent?.name ?? 'Agent'} ${t('chat.replying')}`}>
              <i /><i /><i />
            </div>
            <span>{selectedAgent?.name ?? 'Agent'} {t('chat.replying')}</span>
          </article>}
          {!messages.length && replyingSessionId !== sessionId && <div className="chat-empty-state">
            <MessageSquare size={24} />
            <b>{selectedAgent ? selectedAgent.name : 'Direct chat'}</b>
            <span>{selectedSession ? selectedSession.title : 'New session'}</span>
          </div>}
          <div ref={messageEndRef} />
        </div>
        <footer className="chat-composer">
          <textarea className="input" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void sendMessage();
          }} placeholder={t('chat.messagePlaceholder')} />
          <button className="btn btn-primary icon-btn" aria-label="Send message" onClick={() => void sendMessage()} disabled={sending || !draft.trim() || !agentId}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </footer>
      </section>
    </section>
  </div>;
}
