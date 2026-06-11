import websocket from '@fastify/websocket';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAuth, type AuthenticatedRequest } from './auth.ts';
import { db } from './db/client.ts';
import { companyMemberships } from './db/schema.ts';

type LiveSocket = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  on: (event: 'close' | 'error' | 'message', listener: (...args: unknown[]) => void) => void;
};

export type LiveEvent = {
  type: string;
  companyId?: string | null;
  // When set, the event is delivered only to this user's sockets (still company-gated).
  userId?: string | null;
  entityType?: string;
  entityId?: string;
  cardId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  action?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
};

type LiveClient = {
  socket: LiveSocket;
  userId: string;
  companyIds: Set<string>;
};

const clients = new Set<LiveClient>();
const OPEN = 1;

function canReceive(client: LiveClient, event: LiveEvent): boolean {
  if (event.userId && client.userId !== event.userId) return false;
  return !event.companyId || client.companyIds.has(event.companyId);
}

export function publishLiveEvent(event: LiveEvent): void {
  const payload = JSON.stringify({ ...event, createdAt: event.createdAt ?? new Date().toISOString() });
  for (const client of clients) {
    if (client.socket.readyState !== OPEN) {
      clients.delete(client);
      continue;
    }
    if (!canReceive(client, event)) continue;
    try {
      client.socket.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/api/live', {
    websocket: true,
    preValidation: async (request, reply) => {
      await requireAuth(request, reply);
    },
  }, async (socket, request) => {
    const user = (request as AuthenticatedRequest).authUser;
    if (!user) {
      socket.close();
      return;
    }
    const memberships = await db.select({ companyId: companyMemberships.companyId }).from(companyMemberships).where(and(
      eq(companyMemberships.userId, user.id),
      eq(companyMemberships.status, 'active'),
    ));
    const client: LiveClient = { socket, userId: user.id, companyIds: new Set(memberships.map((row) => row.companyId)) };
    clients.add(client);
    socket.send(JSON.stringify({ type: 'live.connected', data: { companies: client.companyIds.size }, createdAt: new Date().toISOString() }));
    socket.on('message', (message: unknown) => {
      if (String(message) === 'ping') socket.send(JSON.stringify({ type: 'live.pong', createdAt: new Date().toISOString() }));
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });
}
