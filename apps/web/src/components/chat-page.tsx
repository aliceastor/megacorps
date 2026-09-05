'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, FileText, Loader2, MessageSquare, Plus, Send } from 'lucide-react';
import Link from 'next/link';
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

type NewSessionScope = {
  companyId: string;
  agentId: string;
  projectId: string | null;
  agentName: string;
  originIdentity: string;
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

function agentStatus(agent: Agent | null | undefined, t: (key: string) => string): { label: string; color: string } {
  if (!agent) return { label: t('chat.statusNoAgent'), color: 'var(--muted)' };
  if (agent.isActive === false) return { label: t('chat.statusPaused'), color: 'var(--danger)' };
  if (agent.isBusy) return { label: t('chat.statusBusy'), color: 'var(--success)' };
  return { label: t('chat.statusIdle'), color: 'var(--primary)' };
}

function draftKey(companyId: string, agentId: string, projectFilter: string, sessionId: string): string {
  return sessionId ? `session:${sessionId}` : `new:${companyId}:${agentId}:${projectFilter}`;
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
  const { t, tf } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [companyId, setCompanyId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sessionId, setSessionId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mobilePane, setMobilePane] = useState<'sessions' | 'conversation'>('sessions');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [replyingSessionId, setReplyingSessionId] = useState<string | null>(null);
  const [partialReply, setPartialReply] = useState('');
  const [error, setError] = useState('');
  const messageEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeIdentityRef = useRef('');
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
  const status = agentStatus(selectedAgent, t);
  const activeDraftKey = draftKey(companyId, agentId, projectFilter, sessionId);
  activeIdentityRef.current = activeDraftKey;
  const draft = drafts[activeDraftKey] ?? '';
  const messages = sessionId ? messagesBySession[sessionId] ?? [] : [];
  const sessionProject = selectedSession?.projectId ? projects.find((project) => project.id === selectedSession.projectId) ?? null : null;
  const headerProjectName = sessionProject?.name ?? selectedProject?.name ?? (projectFilter === '__none' ? t('chat.noProject') : t('chat.allProjects'));

  function updateSessionMessages(targetSessionId: string, update: (current: ChatMessage[]) => ChatMessage[]) {
    setMessagesBySession((current) => ({
      ...current,
      [targetSessionId]: update(current[targetSessionId] ?? []),
    }));
  }

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
      setError(err instanceof Error ? err.message : t('chat.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(nextSessionId = sessionId) {
    if (!nextSessionId) {
      return;
    }
    const rows = await queryClient.fetchQuery({ queryKey: ['chatMessages', nextSessionId], queryFn: () => fetchChatMessages(nextSessionId) });
    updateSessionMessages(nextSessionId, (current) => mergeMessages(current, rows));
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
      setError(baseError instanceof Error ? baseError.message : t('chat.loadFailed'));
      setLoading(false);
    }
  }, [companiesQuery.error, agentsQuery.error, projectsQuery.error]);
  useEffect(() => {
    if (!sessionsQuery.data) return;
    setSessions(sessionsQuery.data);
    const nextSession = sessionsQuery.data.find((session) => session.id === sessionId) ?? sessionsQuery.data[0];
    setSessionId(nextSession?.id ?? '');
  }, [sessionsQuery.data]);
  useEffect(() => {
    if (!messagesQuery.data || !sessionId) return;
    updateSessionMessages(sessionId, (current) => mergeMessages(current, messagesQuery.data));
  }, [messagesQuery.data, sessionId]);
  useEffect(() => {
    if (!companyId) return;
    if (!companyAgents.some((agent) => agent.id === agentId)) {
      setAgentId(companyAgents[0]?.id ?? '');
      setSessionId('');
    }
  }, [companyId, companyAgents, agentId]);
  useEffect(() => {
    if (projectFilter !== 'all' && projectFilter !== '__none' && !companyProjects.some((project) => project.id === projectFilter)) setProjectFilter('all');
  }, [companyProjects, projectFilter]);
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
      if (detail.sessionId === sessionId) {
        void queryClient.invalidateQueries({ queryKey: ['chatMessages', detail.sessionId] })
          .then(() => loadMessages(detail.sessionId!));
      }
      void queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    }
    window.addEventListener('megacorps-live', onLive);
    return () => window.removeEventListener('megacorps-live', onLive);
  }, [agentId, companyId, projectFilter, sessionId]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, replyingSessionId]);
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(composer.scrollHeight, 180)}px`;
  }, [draft]);

  async function createSession(select = true, requestedScope?: NewSessionScope): Promise<ChatSession | null> {
    const scope = requestedScope ?? (selectedAgent ? {
      companyId,
      agentId,
      projectId: selectedProject?.id ?? null,
      agentName: selectedAgent.name,
      originIdentity: activeIdentityRef.current,
    } : null);
    if (!scope || !scope.companyId || !scope.agentId || selectedAgent?.isActive === false) return null;
    setError('');
    const session = await api<ChatSession>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId, projectId: scope.projectId, title: tf('chat.sessionTitle', { name: scope.agentName }) }),
    });
    if (activeIdentityRef.current === scope.originIdentity) {
      setSessions((current) => [session, ...current.filter((row) => row.id !== session.id)]);
      if (select) {
        setSessionId(session.id);
        setMobilePane('conversation');
      }
    }
    return session;
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || sending || !agentId || selectedAgent?.isActive === false) return;
    const submittedDraftKey = activeDraftKey;
    const submittedScope: NewSessionScope | null = selectedAgent ? {
      companyId,
      agentId,
      projectId: selectedProject?.id ?? null,
      agentName: selectedAgent.name,
      originIdentity: submittedDraftKey,
    } : null;
    const existingTarget = selectedSession;
    setSending(true);
    setError('');
    let optimisticId: string | undefined;
    let targetSessionId: string | undefined;
    let targetDraftKey: string | undefined;
    try {
      const target = existingTarget ?? (submittedScope ? await createSession(false, submittedScope) : null);
      if (!target) throw new Error(t('chat.noSessionAvailable'));
      targetSessionId = target.id;
      targetDraftKey = draftKey(target.companyId, target.agentId, projectFilter, target.id);
      if (!existingTarget && activeIdentityRef.current === submittedDraftKey) {
        setDrafts((current) => ({ ...current, [targetDraftKey!]: current[submittedDraftKey] ?? body }));
        setSessionId(target.id);
        setMobilePane('conversation');
      }
      const optimistic = pendingUserMessage(target, body);
      optimisticId = optimistic.id;
      updateSessionMessages(target.id, (current) => mergeMessages(current, [optimistic]));
      setReplyingSessionId(target.id);
      const result = await api<ChatSendResult>(`/api/chat/sessions/${target.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      const nextMessages = [result.userMessage, result.agentMessage, result.systemMessage].filter(Boolean) as ChatMessage[];
      updateSessionMessages(target.id, (current) => mergeMessages(current, nextMessages, optimisticId));
      if (result.session) setSessions((current) => current.map((session) => session.id === result.session?.id ? result.session : session));
      setDrafts((current) => {
        const next = { ...current };
        if (next[submittedDraftKey]?.trim() === body) next[submittedDraftKey] = '';
        if (targetDraftKey && next[targetDraftKey]?.trim() === body) next[targetDraftKey] = '';
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['chatMessages', target.id] });
      void queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const data = apiError?.data as Partial<ChatSendResult> | undefined;
      const nextMessages = [data?.userMessage, data?.agentMessage, data?.systemMessage].filter(Boolean) as ChatMessage[];
      if (nextMessages.length) updateSessionMessages(targetSessionId ?? sessionId, (current) => mergeMessages(current, nextMessages, optimisticId));
      else if (targetSessionId && optimisticId) updateSessionMessages(targetSessionId, (current) => current.filter((message) => message.id !== optimisticId));
      if (selectedSession) void queryClient.invalidateQueries({ queryKey: ['chatMessages', selectedSession.id] });
      if (activeIdentityRef.current === submittedDraftKey || activeIdentityRef.current === targetDraftKey) {
        setError(err instanceof Error ? err.message : t('chat.messageFailed'));
      }
    } finally {
      setSending(false);
      setReplyingSessionId(null);
    }
  }

  return <div className="chat-page">
    <div className="page-head">
      <div><h1>{t('chat.title')}</h1><p>{selectedCompany ? selectedCompany.name : t('chat.company')} / {selectedProject?.name ?? (projectFilter === '__none' ? t('chat.noProject') : t('chat.allProjects'))} / {selectedAgent ? selectedAgent.name : t('chat.agentSessions')}</p></div>
      <div className="page-head-actions">
        <Link className="btn" href={selectedAgent ? `/logs?agentId=${selectedAgent.id}&surface=chat` : '/logs?surface=chat'} title={t('chat.injectedContextTitle')}>
          <FileText size={14} /> {t('chat.injectedContext')}
        </Link>
        <button className="btn" onClick={() => void refreshBase()} disabled={loading}>{loading ? <Loader2 size={14} className="spin" /> : <MessageSquare size={14} />} {t('chat.refresh')}</button>
      </div>
    </div>

    {error && <div className="chat-error-row" role="alert"><p className="form-error">{error}</p>{draft.trim() && selectedAgent?.isActive !== false && <button className="btn" onClick={() => void sendMessage()} disabled={sending}>{t('chat.retry')}</button>}</div>}

    <section className="card chat-scope-controls" aria-label={t('chat.scope')}>
      <label className="chat-scope-field">
        <span>{t('chat.company')}</span>
        <select className="input" aria-label={t('chat.company')} value={companyId} onChange={(event) => {
          const nextCompanyId = event.target.value;
          const nextAgent = agents.find((agent) => agent.companyId === nextCompanyId);
          setCompanyId(nextCompanyId);
          setProjectFilter('all');
          setAgentId(nextAgent?.id ?? '');
          setSessionId('');
          setMobilePane('sessions');
          setError('');
        }}>
          {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
        </select>
      </label>
      <label className="chat-scope-field">
        <span>{t('chat.project')}</span>
        <select className="input" aria-label={t('chat.project')} value={projectFilter} onChange={(event) => {
          setProjectFilter(event.target.value);
          setSessionId('');
          setMobilePane('sessions');
          setError('');
        }}>
          <option value="all">{t('chat.allProjects')}</option>
          <option value="__none">{t('chat.noProject')}</option>
          {companyProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </label>
      <label className="chat-scope-field">
        <span>{t('chat.agent')}</span>
        <select className="input" aria-label={t('chat.agent')} value={agentId} onChange={(event) => {
          setAgentId(event.target.value);
          setSessionId('');
          setMobilePane('sessions');
          setError('');
        }} disabled={!companyAgents.length}>
          {companyAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} — {agent.role}</option>)}
        </select>
      </label>
    </section>

    <section className={`card chat-shell chat-workspace chat-mobile-${mobilePane}`}>
      <aside className="chat-rail session-rail">
        <div className="chat-rail-head">
          <div><b>{t('chat.sessions')}</b><span>{selectedAgent?.adapterType ?? t('chat.adapter')}</span></div>
          <button className="btn icon-btn" aria-label={t('chat.newSession')} onClick={() => void createSession()} disabled={!agentId || selectedAgent?.isActive === false}><Plus size={15} /></button>
        </div>
        <div className="chat-agent-card">
          <span className="chat-avatar large">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
          <div><b>{selectedAgent?.name ?? t('chat.statusNoAgent')}</b><span>{selectedAgent?.role || t('chat.noIdentity')}</span></div>
          <em style={{ color: status.color }}>{status.label}</em>
        </div>
        <div className="chat-list">
          {sessions.map((session) => <button className={`chat-list-item ${session.id === sessionId ? 'active' : ''}`} key={session.id} onClick={() => { setSessionId(session.id); setMobilePane('conversation'); setError(''); }}>
            <b>{session.title}</b>
            <span>{shortTime(session.updatedAt)} / {session.projectId ? projects.find((project) => project.id === session.projectId)?.name ?? t('chat.project') : t('chat.noProject')} / {session.agentSessionId ? t('chat.resumable') : t('common.new')}</span>
          </button>)}
          {!sessions.length && <p className="chat-empty">{t('chat.noSessions')}</p>}
        </div>
      </aside>

      <section className="chat-thread">
        <header className="chat-thread-head">
          <button className="btn chat-mobile-sessions-btn" onClick={() => setMobilePane('sessions')}>{t('chat.sessions')}</button>
          <div className="chat-agent-card compact-card">
            <span className="chat-avatar">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
            <div><b>{selectedAgent?.name ?? t('chat.selectAgent')}</b><span>{selectedSession?.title ?? t('chat.newSession')} · {headerProjectName}</span></div>
          </div>
          <span className="status-pill" style={{ color: status.color }}>{status.label}</span>
        </header>
        <div className="chat-messages">
          {messages.map((message) => <article className={`chat-bubble ${message.authorType}`} key={message.id}>
            {message.authorType === 'user' ? <div>{message.body}</div> : <Markdown text={message.body} />}
            <span>{t(`common.${message.authorType}`)} / {message.metadata?.pending ? t('chat.sending') : shortTime(message.createdAt)}{message.costUsd ? ` / $${message.costUsd}` : ''}</span>
          </article>)}
          {replyingSessionId === sessionId && <article className="chat-bubble agent typing-bubble" aria-live="polite">
            {partialReply && <div className="chat-partial-text"><Markdown text={partialReply} /></div>}
            <div className="typing-dots" aria-label={`${selectedAgent?.name ?? t('chat.agent')} ${t('chat.replying')}`}>
              <i /><i /><i />
            </div>
            <span>{selectedAgent?.name ?? t('chat.agent')} {t('chat.replying')}</span>
          </article>}
          {!messages.length && replyingSessionId !== sessionId && selectedAgent?.isActive !== false && <div className="chat-empty-state">
            <MessageSquare size={24} />
            <b>{selectedAgent ? selectedAgent.name : t('chat.title')}</b>
            <span>{selectedSession ? selectedSession.title : t('chat.newSession')}</span>
          </div>}
          {selectedAgent?.isActive === false && <div className="chat-paused-state"><b>{t('chat.pausedMessage')}</b><Link className="btn" href="/agents">{t('chat.manageAgents')}</Link></div>}
          <div ref={messageEndRef} />
        </div>
        <footer className="chat-composer">
          <textarea ref={composerRef} className="input" rows={2} value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [activeDraftKey]: event.target.value }))} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendMessage();
            }
          }} placeholder={t('chat.messagePlaceholder')} aria-label={t('chat.messagePlaceholder')} disabled={!selectedAgent || selectedAgent.isActive === false} />
          <button className="btn btn-primary icon-btn" aria-label={t('chat.send')} onClick={() => void sendMessage()} disabled={sending || !draft.trim() || !agentId || selectedAgent?.isActive === false}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </footer>
      </section>
    </section>
  </div>;
}
