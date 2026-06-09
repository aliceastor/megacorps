import type { CardActorType, CardStatus, CardTransitionAction } from '@megacorps/shared';
import { validateCardTransition } from '@megacorps/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { cardActions, kanbanCards, taskLogs } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';

export type CardActionActor = {
  type: CardActorType;
  id: string;
  userId?: string | null;
  agentId?: string | null;
  machineRunnerId?: string | null;
  sessionId?: string | null;
};

export async function recordCardAction(input: {
  companyId: string;
  cardId: string;
  actor: CardActionActor;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await db.insert(cardActions).values({
    companyId: input.companyId,
    cardId: input.cardId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    userId: input.actor.userId ?? null,
    agentId: input.actor.agentId ?? null,
    machineRunnerId: input.actor.machineRunnerId ?? null,
    sessionId: input.actor.sessionId ?? null,
    action: input.action,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    detail: input.detail ?? null,
    metadata: input.metadata ?? {},
  }).returning();
  if (row) publishLiveEvent({ type: 'card.action.created', companyId: input.companyId, entityType: 'card_action', entityId: row.id, cardId: input.cardId, action: input.action });
  return row;
}

export function assertCardTransition(input: {
  action: CardTransitionAction;
  from: CardStatus;
  actorType: CardActorType;
  to?: CardStatus;
}) {
  const error = validateCardTransition(input.action, input.from, input.actorType, input.to);
  if (error) {
    const err = new Error(error.message) as Error & { statusCode?: number; code?: string };
    err.statusCode = error.code === 'FORBIDDEN' ? 403 : 409;
    err.code = error.code;
    throw err;
  }
}

export async function recordStageAction(input: {
  cardId: string;
  agentId?: string | null;
  actor: CardActionActor;
  fromStatus?: string | null;
  toStatus: string;
  action?: string;
  detail?: string | null;
  metadata?: Record<string, unknown>;
  logStatus?: 'success' | 'warning' | 'failed';
}) {
  const [card] = await db.select({ companyId: kanbanCards.companyId, projectId: kanbanCards.projectId })
    .from(kanbanCards)
    .where(eq(kanbanCards.id, input.cardId))
    .limit(1);
  if (!card) return null;
  const message = input.detail ?? `Stage changed from ${input.fromStatus ?? 'todo'} to ${input.toStatus}.`;
  await db.insert(taskLogs).values({
    cardId: input.cardId,
    agentId: input.agentId ?? input.actor.agentId ?? null,
    type: 'stage',
    status: input.logStatus ?? 'success',
    message,
  });
  const action = await recordCardAction({
    companyId: card.companyId,
    cardId: input.cardId,
    actor: input.actor,
    action: input.action ?? 'stage.changed',
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus,
    detail: message,
    metadata: input.metadata,
  });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: input.cardId, cardId: input.cardId, projectId: card.projectId, action: input.action ?? 'stage.changed' });
  return action;
}

export async function getCardActions(cardId: string, limit = 200) {
  return db.select().from(cardActions).where(eq(cardActions.cardId, cardId)).orderBy(desc(cardActions.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
}
