'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, FileText, Loader2, MessageSquare, Plus, Send } from 'lucide-react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api';
import { projectChatMessage } from '@/lib/chat-display';
import {
  chatJobPollInterval,
  chatPollRetryDelay,
  shouldRetryChatPoll,
  shouldRetryChatTranscript,
} from '@/lib/chat-poll';
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

type ChatJob = { id: string; sessionId: string; userMessageId: string; status: 'queued' | 'running' | 'completed' | 'failed'; error?: string | null };
const pendingChatJob = (job: ChatJob) => job.status === 'queued' || job.status === 'running';

type ChatSendResult = {
  job?: ChatJob;
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
  projectFilter: string;
};

function sessionMatchesScope(session: ChatSession, companyId: string, agentId: string, projectFilter: string): boolean {
  return Boolean(companyId && agentId) && session.companyId === companyId && session.agentId === agentId
    && (projectFilter === 'all' || (projectFilter === '__none' ? !session.projectId : session.projectId === projectFilter));
}

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
  const { locale, t, tf } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  const [companyId, setCompanyId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sessionId, setSessionId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mobilePane, setMobilePane] = useState<'sessions' | 'conversation'>('sessions');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [repliesBySession, setRepliesBySession] = useState<Record<string, { pending: boolean; partial: string }>>({});
  const [error, setError] = useState('');
  const [creationErrors, setCreationErrors] = useState<Record<string, string>>({});
  const [creatingScopes, setCreatingScopes] = useState<Record<string, boolean>>({});
  const [sessionReadErrors, setSessionReadErrors] = useState<Record<string, string>>({});
  const [messageReadErrors, setMessageReadErrors] = useState<Record<string, string>>({});
  const creationPendingRef = useRef(new Set<string>());
  const selectionGenerationRef = useRef(0);
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
  const sessions = useMemo(() => (sessionsQuery.data ?? []).filter((session) => sessionMatchesScope(session, companyId, agentId, projectFilter)), [sessionsQuery.data, companyId, agentId, projectFilter]);

  const companyAgents = useMemo(() => agents.filter((agent) => agent.companyId === companyId), [agents, companyId]);
  const companyProjects = useMemo(() => projects.filter((project) => project.companyId === companyId), [projects, companyId]);
  const selectedCompany = companies.find((company) => company.id === companyId) ?? null;
  const selectedProject = projectFilter !== 'all' && projectFilter !== '__none' ? projects.find((project) => project.id === projectFilter) ?? null : null;
  const selectedAgent = companyAgents.find((agent) => agent.id === agentId) ?? null;
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? null;
  const jobsQuery = useQuery({
    queryKey: ['chatJobs', selectedSession?.id],
    queryFn: () => api<ChatJob[]>(`/api/chat/sessions/${selectedSession!.id}/jobs`, { signal: AbortSignal.timeout(15_000) }),
    enabled: Boolean(selectedSession && selectedAgent?.adapterType === 'a2a'),
    refetchInterval: query => chatJobPollInterval(query.state.data),
    retry: shouldRetryChatPoll,
    retryDelay: chatPollRetryDelay,
  });
  const jobPending = Boolean(jobsQuery.data?.some(pendingChatJob));
  const jobReadError = jobsQuery.error instanceof Error ? jobsQuery.error.message : '';
  const checkingJob = Boolean(selectedSession && selectedAgent?.adapterType === 'a2a' && (jobsQuery.isLoading || jobReadError));
  useEffect(() => {
    if (!selectedSession || !jobsQuery.data) return;
    if (jobsQuery.data.some((job) => job.status === 'completed')) void messagesQuery.refetch();
  }, [jobsQuery.dataUpdatedAt, selectedSession?.id]);
  const messagesQuery = useQuery({
    queryKey: ['chatMessages', selectedSession?.id],
    queryFn: () => fetchChatMessages(selectedSession!.id),
    enabled: Boolean(selectedSession),
    retry: shouldRetryChatTranscript,
    retryDelay: chatPollRetryDelay,
  });
  const status = agentStatus(selectedAgent, t);
  const activeDraftKey = draftKey(companyId, agentId, projectFilter, selectedSession?.id ?? '');
  activeIdentityRef.current = activeDraftKey;
  const draft = drafts[activeDraftKey] ?? '';
  const creationScopeKey = draftKey(companyId, agentId, projectFilter, '');
  const creating = Boolean(creatingScopes[creationScopeKey]);
  const creationError = creationErrors[activeDraftKey] ?? '';
  const sessionReadError = sessionReadErrors[creationScopeKey] ?? '';
  const messageReadError = selectedSession ? messageReadErrors[selectedSession.id] ?? '' : '';
  const readError = sessionReadError || messageReadError || jobReadError;
  const messages = selectedSession ? messagesBySession[selectedSession.id] ?? [] : [];
  const localReply = selectedSession ? repliesBySession[selectedSession.id] : undefined;
  const reply = { partial: localReply?.partial ?? '', pending: Boolean(localReply?.pending || jobPending) };
  const sessionProject = selectedSession?.projectId ? projects.find((project) => project.id === selectedSession.projectId) ?? null : null;
  const headerProjectName = selectedSession
    ? selectedSession.projectId ? sessionProject?.name ?? t('chat.project') : t('chat.noProject')
    : selectedProject?.name ?? (projectFilter === '__none' ? t('chat.noProject') : t('chat.allProjects'));

  function updateReply(targetSessionId: string, pending: boolean, partial = '') {
    setRepliesBySession((current) => ({ ...current, [targetSessionId]: { pending, partial } }));
  }

  function updateSessionMessages(targetSessionId: string, update: (current: ChatMessage[]) => ChatMessage[]) {
    setMessagesBySession((current) => ({
      ...current,
      [targetSessionId]: update(current[targetSessionId] ?? []),
    }));
  }

  async function refreshBase() {
    setLoading(true);
    setError('');
    const refreshedSelectionGeneration = selectionGenerationRef.current;
    const refreshedScopeKey = creationScopeKey;
    const refreshedSessionId = selectedSession?.id;
    try {
      const [companyResult, agentResult, projectResult, sessionResult, messageResult] = await Promise.all([
        companiesQuery.refetch(),
        agentsQuery.refetch(),
        projectsQuery.refetch(),
        companyId && agentId ? sessionsQuery.refetch() : Promise.resolve(null),
        refreshedSessionId ? messagesQuery.refetch() : Promise.resolve(null),
      ]);
      const baseError = companyResult.error ?? agentResult.error ?? projectResult.error;
      if (baseError) throw baseError;
      const companyRows = companyResult.data ?? [];
      const agentRows = agentResult.data ?? [];
      const projectRows = projectResult.data ?? [];
      setCompanies(companyRows);
      setProjects(projectRows);
      setAgents(agentRows);
      const nextCompany = companyRows.find((company) => company.id === companyId) ?? companyRows[0];
      const nextAgent = nextCompany ? agentRows.find((agent) => agent.companyId === nextCompany.id && agent.id === agentId) ?? agentRows.find((agent) => agent.companyId === nextCompany.id) : undefined;
      if (selectionGenerationRef.current === refreshedSelectionGeneration) {
        setCompanyId(nextCompany?.id ?? '');
        setAgentId(nextAgent?.id ?? '');
      }
      if (sessionResult) {
        setSessionReadErrors((current) => ({ ...current, [refreshedScopeKey]: sessionResult.error instanceof Error ? sessionResult.error.message : '' }));
      }
      if (messageResult && refreshedSessionId) {
        setMessageReadErrors((current) => ({ ...current, [refreshedSessionId]: messageResult.error instanceof Error ? messageResult.error.message : '' }));
        if (messageResult.data) updateSessionMessages(refreshedSessionId, (current) => mergeMessages(current, messageResult.data));
      }
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
    try {
      const rows = await queryClient.fetchQuery({ queryKey: ['chatMessages', nextSessionId], queryFn: () => fetchChatMessages(nextSessionId) });
      updateSessionMessages(nextSessionId, (current) => mergeMessages(current, rows));
      setMessageReadErrors((current) => ({ ...current, [nextSessionId]: '' }));
    } catch (err) {
      setMessageReadErrors((current) => ({ ...current, [nextSessionId]: err instanceof Error ? err.message : t('chat.loadFailed') }));
      throw err;
    }
  }

  async function retryRead() {
    if (jobReadError) { await jobsQuery.refetch(); return; }
    if (sessionReadError) {
      await sessionsQuery.refetch();
      return;
    }
    if (selectedSession && messageReadError) {
      try {
        await loadMessages(selectedSession.id);
      } catch {
        // loadMessages retains the recoverable error under the requested session.
      }
    }
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
    if (!companyId || !agentId) return;
    if (sessionsQuery.error) {
      setSessionReadErrors((current) => ({ ...current, [creationScopeKey]: sessionsQuery.error instanceof Error ? sessionsQuery.error.message : t('chat.loadFailed') }));
    } else if (sessionsQuery.data) {
      setSessionReadErrors((current) => ({ ...current, [creationScopeKey]: '' }));
    }
  }, [sessionsQuery.error, sessionsQuery.data, creationScopeKey, companyId, agentId]);
  useEffect(() => {
    const nextSession = sessions.find((session) => session.id === sessionId) ?? sessions[0];
    setSessionId(nextSession?.id ?? '');
  }, [sessions]);
  useEffect(() => {
    if (!selectedSession) return;
    if (messagesQuery.error) {
      setMessageReadErrors((current) => ({ ...current, [selectedSession.id]: messagesQuery.error instanceof Error ? messagesQuery.error.message : t('chat.loadFailed') }));
      return;
    }
    if (messagesQuery.data) {
      updateSessionMessages(selectedSession.id, (current) => mergeMessages(current, messagesQuery.data));
      setMessageReadErrors((current) => ({ ...current, [selectedSession.id]: '' }));
    }
  }, [messagesQuery.error, messagesQuery.data, selectedSession?.id]);
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
  useEffect(() => {
    if (selectedSession && selectedAgent?.isBusy) {
      setRepliesBySession((current) => current[selectedSession.id] ? current : { ...current, [selectedSession.id]: { pending: true, partial: '' } });
    }
  }, [selectedAgent?.isBusy, selectedSession?.id]);
  useEffect(() => {
    function onLive(event: Event) {
      const detail = (event as CustomEvent<LiveEvent>).detail;
      if (!detail?.type.startsWith('chat.')) return;
      const targetSessionId = detail.sessionId;
      if (!targetSessionId) return;
      if (detail.type === 'chat.reply.started') updateReply(targetSessionId, true);
      if (detail.type === 'chat.reply.partial') {
        const text = typeof detail.data?.text === 'string' ? detail.data.text : '';
        if (text) updateReply(targetSessionId, true, text);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['chatJobs', targetSessionId] });
      if (detail.type === 'chat.reply.finished') updateReply(targetSessionId, false);
      if (detail.type === 'chat.message.created') {
        setRepliesBySession((current) => ({ ...current, [targetSessionId]: { pending: current[targetSessionId]?.pending ?? false, partial: '' } }));
      }
      void queryClient.invalidateQueries({ queryKey: ['chatMessages', targetSessionId] })
        .then(() => loadMessages(targetSessionId))
        .catch(() => {
          // loadMessages records the failure under the event's session identity.
        });
      void queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    }
    window.addEventListener('megacorps-live', onLive);
    return () => window.removeEventListener('megacorps-live', onLive);
  }, [agentId, companyId, projectFilter, sessionId]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, reply?.pending]);
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
      projectFilter,
    } : null);
    if (!scope || !scope.companyId || !scope.agentId || selectedAgent?.isActive === false) return null;
    setError('');
    const session = await api<ChatSession>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId, projectId: scope.projectId, title: tf('chat.sessionTitle', { name: scope.agentName }) }),
    });
    queryClient.setQueryData<ChatSession[]>(['chatSessions', scope.companyId, scope.agentId, scope.projectFilter], (current = []) => [session, ...current.filter((row) => row.id !== session.id)]);
    if (activeIdentityRef.current === scope.originIdentity) {
      if (select) {
        setSessionId(session.id);
        setMobilePane('conversation');
      }
    }
    return session;
  }

  async function createSessionExplicitly() {
    if (creationPendingRef.current.has(creationScopeKey) || sending || !selectedAgent || selectedAgent.isActive === false) return;
    const originIdentity = activeDraftKey;
    const originScopeKey = creationScopeKey;
    creationPendingRef.current.add(originScopeKey);
    setCreatingScopes((current) => ({ ...current, [originScopeKey]: true }));
    setCreationErrors((current) => ({ ...current, [originIdentity]: '' }));
    try {
      await createSession();
    } catch (err) {
      setCreationErrors((current) => ({ ...current, [originIdentity]: err instanceof Error ? err.message : t('chat.noSessionAvailable') }));
    } finally {
      creationPendingRef.current.delete(originScopeKey);
      setCreatingScopes((current) => ({ ...current, [originScopeKey]: false }));
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || sending || reply.pending || checkingJob || creationPendingRef.current.has(creationScopeKey) || !selectedAgent || selectedAgent.isActive === false || (sessionId && !selectedSession)) return;
    const submittedDraftKey = activeDraftKey;
    const submittedScope: NewSessionScope | null = selectedAgent ? {
      companyId,
      agentId,
      projectId: selectedProject?.id ?? null,
      agentName: selectedAgent.name,
      originIdentity: submittedDraftKey,
      projectFilter,
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
      if (!submittedScope || !sessionMatchesScope(target, submittedScope.companyId, submittedScope.agentId, submittedScope.projectFilter)) throw new Error(t('chat.noSessionAvailable'));
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
      updateReply(target.id, true);
      const result = await api<ChatSendResult>(`/api/chat/sessions/${target.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      if (result.job) queryClient.setQueryData<ChatJob[]>(['chatJobs', target.id], (current = []) => [result.job!, ...current.filter(job => job.id !== result.job!.id)]);
      const nextMessages = [result.userMessage, result.agentMessage, result.systemMessage].filter(Boolean) as ChatMessage[];
      updateSessionMessages(target.id, (current) => mergeMessages(current, nextMessages, optimisticId));
      if (result.session) queryClient.setQueriesData<ChatSession[]>({ queryKey: ['chatSessions'] }, (current) => current?.map((session) => session.id === result.session?.id ? result.session : session));
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
      if (data?.job && targetSessionId) queryClient.setQueryData<ChatJob[]>(['chatJobs', targetSessionId], (current = []) => [data.job!, ...current.filter(job => job.id !== data.job!.id)]);
      if (targetSessionId) void queryClient.invalidateQueries({ queryKey: ['chatJobs', targetSessionId] });
      const nextMessages = [data?.userMessage, data?.agentMessage, data?.systemMessage].filter(Boolean) as ChatMessage[];
      if (nextMessages.length) updateSessionMessages(targetSessionId ?? sessionId, (current) => mergeMessages(current, nextMessages, optimisticId));
      else if (targetSessionId && optimisticId) updateSessionMessages(targetSessionId, (current) => current.filter((message) => message.id !== optimisticId));
      if (selectedSession) void queryClient.invalidateQueries({ queryKey: ['chatMessages', selectedSession.id] });
      if (activeIdentityRef.current === submittedDraftKey || activeIdentityRef.current === targetDraftKey) {
        setError(err instanceof Error ? err.message : t('chat.messageFailed'));
      }
    } finally {
      setSending(false);
      if (targetSessionId) updateReply(targetSessionId, false);
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

    {(creationError || readError || error) && <div className="chat-error-row" role="alert"><p className="form-error">{creationError || readError || error}</p>{selectedAgent?.isActive !== false && (creationError || readError || draft.trim()) && <button className="btn" onClick={() => void (creationError ? createSessionExplicitly() : readError ? retryRead() : sendMessage())} disabled={sending || creating}>{t('chat.retry')}</button>}</div>}

    <section className="card chat-scope-controls" aria-label={t('chat.scope')}>
      <label className="chat-scope-field">
        <span>{t('chat.company')}</span>
        <select className="input" aria-label={t('chat.company')} value={companyId} onChange={(event) => {
          const nextCompanyId = event.target.value;
          const nextAgent = agents.find((agent) => agent.companyId === nextCompanyId);
          selectionGenerationRef.current += 1;
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
          selectionGenerationRef.current += 1;
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
          selectionGenerationRef.current += 1;
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
          <button className="btn icon-btn" aria-label={t('chat.newSession')} onClick={() => void createSessionExplicitly()} disabled={creating || sending || !selectedAgent || selectedAgent.isActive === false}><Plus size={15} /></button>
        </div>
        <div className="chat-agent-card">
          <span className="chat-avatar large">{selectedAgent?.name.slice(0, 2).toUpperCase() ?? '--'}</span>
          <div><b>{selectedAgent?.name ?? t('chat.statusNoAgent')}</b><span>{selectedAgent?.role || t('chat.noIdentity')}</span></div>
          <em style={{ color: status.color }}>{status.label}</em>
        </div>
        <div className="chat-list">
          {sessions.map((session) => <button className={`chat-list-item ${session.id === sessionId ? 'active' : ''}`} key={session.id} onClick={() => { selectionGenerationRef.current += 1; setSessionId(session.id); setMobilePane('conversation'); setError(''); }}>
            <b>{session.title}</b>
            <span>{shortTime(session.updatedAt)} / {session.projectId ? projects.find((project) => project.id === session.projectId)?.name ?? t('chat.project') : t('chat.noProject')} / {session.agentSessionId ? t('chat.resumable') : t('common.new')}</span>
          </button>)}
          {!sessions.length && !sessionReadError && <p className="chat-empty">{sessionsQuery.isLoading ? t('common.loading') : t('chat.noSessions')}</p>}
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
          {messages.map((message) => {
            const projection = projectChatMessage(message.body, message.authorType, locale);
            return <article className={`chat-bubble ${message.authorType}`} key={message.id}>
            {projection.text && (message.authorType === 'user' ? <div>{projection.text}</div> : <Markdown text={projection.text} />)}
            {projection.receipt && <div className="status-pill chat-operation-receipt">{projection.receipt}</div>}
            {projection.raw && <details className="runtime-details"><summary>{t('kanban.rawRecord')}</summary><pre>{projection.raw}</pre></details>}
            <span>{t(`common.${message.authorType}`)} / {message.metadata?.pending ? t('chat.sending') : shortTime(message.createdAt)}{message.costUsd ? ` / $${message.costUsd}` : ''}</span>
          </article>;})}
          {reply?.pending && <article className="chat-bubble agent typing-bubble" aria-live="polite">
            {reply.partial && <div className="chat-partial-text"><Markdown text={reply.partial} /></div>}
            <div className="typing-dots" aria-label={`${selectedAgent?.name ?? t('chat.agent')} ${t('chat.replying')}`}>
              <i /><i /><i />
            </div>
            <span>{selectedAgent?.name ?? t('chat.agent')} {t('chat.replying')}</span>
          </article>}
          {!messages.length && selectedSession && messagesQuery.isLoading && <div className="chat-empty-state"><Loader2 size={24} className="spin" /><span>{t('common.loading')}</span></div>}
          {!messages.length && !reply?.pending && !messageReadError && !messagesQuery.isLoading && selectedAgent?.isActive !== false && <div className="chat-empty-state">
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
          <button className="btn btn-primary icon-btn" aria-label={t('chat.send')} onClick={() => void sendMessage()} disabled={sending || reply.pending || checkingJob || creating || !draft.trim() || !selectedAgent || selectedAgent.isActive === false}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </footer>
      </section>
    </section>
  </div>;
}
