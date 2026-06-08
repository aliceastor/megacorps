'use client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { getApiCandidates } from '@/lib/api';

type LiveEvent = {
  type: string;
  companyId?: string | null;
  entityType?: string;
  entityId?: string;
  cardId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  action?: string;
  data?: Record<string, unknown>;
};

function wsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/live';
  url.search = '';
  return url.toString();
}

async function hasLiveSession(apiUrls: string[]): Promise<boolean> {
  for (const apiUrl of apiUrls) {
    try {
      const response = await fetch(`${apiUrl}/api/me`, { credentials: 'include', cache: 'no-store' });
      if (response.ok) return true;
      if (response.status === 401 || response.status === 403) return false;
    } catch {
      // Try the next API candidate before giving up.
    }
  }
  return false;
}

function invalidateLiveEvent(queryClient: QueryClient, event: LiveEvent): void {
  if (event.type.startsWith('chat.')) {
    void queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    if (event.sessionId) void queryClient.invalidateQueries({ queryKey: ['chatMessages', event.sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
    return;
  }
  if (event.type.startsWith('card.') || event.type.startsWith('task_') || event.type.startsWith('work_product.')) {
    void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    if (event.cardId) {
      void queryClient.invalidateQueries({ queryKey: ['cardComments', event.cardId] });
      void queryClient.invalidateQueries({ queryKey: ['cardLogs', event.cardId] });
      void queryClient.invalidateQueries({ queryKey: ['cardWorkProducts', event.cardId] });
    }
    return;
  }
  if (event.type.startsWith('project.') || event.type.startsWith('goal.')) {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['goals'] });
    void queryClient.invalidateQueries({ queryKey: ['kanbanBoard'] });
  }
}

function LiveEvents() {
  const queryClient = useQueryClient();
  const reconnectRef = useRef<number | null>(null);

  useEffect(() => {
    if (window.location.pathname.startsWith('/login') || window.location.pathname.startsWith('/signup')) return;
    let closed = false;
    let socket: WebSocket | null = null;
    const apiCandidates = getApiCandidates();
    const candidates = apiCandidates.map(wsUrl);
    let candidateIndex = 0;

    const connect = async () => {
      if (closed) return;
      if (!(await hasLiveSession(apiCandidates))) return;
      if (closed) return;
      socket = new WebSocket(candidates[candidateIndex] ?? candidates[0] ?? 'ws://localhost:4000/api/live');
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as LiveEvent;
          invalidateLiveEvent(queryClient, event);
          window.dispatchEvent(new CustomEvent('megacorps-live', { detail: event }));
        } catch {
          // Ignore malformed live-event frames; the next API refresh remains authoritative.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        candidateIndex = (candidateIndex + 1) % Math.max(1, candidates.length);
        reconnectRef.current = window.setTimeout(connect, 1200);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socket?.close();
    };
  }, [queryClient]);

  return null;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      },
    },
  }), []);
  return <QueryClientProvider client={queryClient}><LiveEvents />{children}</QueryClientProvider>;
}
