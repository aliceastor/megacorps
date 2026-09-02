import { chatWorkItemsSchema, type ChatWorkItemAction, type ChatWorkItems } from '@megacorps/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { markedJsonCandidates } from './agent-report.ts';
import { recordCardAction, recordStageAction } from './card-actions.ts';
import { db } from './db/client.ts';
import { activityLog, agentNotes, agents, kanbanCards } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';

// Direct Chat sessions and the Kanban board are independent contexts: telling
// an agent something in chat used to leave no trace on the board. The chat
// prompt now asks the agent to emit a megacorps-chat-actions block when the
// user asks for work to be tracked, and this module applies it on the
// chatting user's behalf — the agent never needs API credentials of its own.

export const CHAT_ACTIONS_MARKER = 'megacorps-chat-actions';

export type ChatWorkItemsExtraction = { actions: ChatWorkItems } | { error: string };

export function extractChatWorkItems(output: string | null | undefined): ChatWorkItemsExtraction | null {
  const candidates = markedJsonCandidates(output, CHAT_ACTIONS_MARKER);
  if (candidates.length === 0) return null;
  let lastError: string | null = null;
  // Prefer the last candidate: an agent that revises mid-reply puts the final
  // block at the end.
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      lastError = 'chat_actions_json_parse_failed';
      continue;
    }
    const result = chatWorkItemsSchema.safeParse(parsed);
    if (result.success) return { actions: result.data };
    lastError = `chat_actions_schema_invalid: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`;
  }
  return lastError ? { error: lastError } : null;
}

function priorityToNumber(priority: string | undefined): number {
  return priority === 'urgent' ? 3 : priority === 'high' ? 2 : priority === 'low' ? -1 : 0;
}

export type ChatWorkItemOutcome = {
  action: 'create_card' | 'update_card' | 'note';
  cardId: string | null;
  title: string | null;
  ok: boolean;
  detail: string;
};

type ApplyInput = {
  companyId: string;
  projectId: string | null;
  chatSessionId: string;
  user: { id: string; email?: string };
  agentId: string;
  agentName: string;
};

async function resolveAssigneeId(companyId: string, slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null;
  const [row] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.slug, slug), isNull(agents.deletedAt))).limit(1);
  return row?.id ?? null;
}

async function applyOne(input: ApplyInput, action: ChatWorkItemAction): Promise<ChatWorkItemOutcome> {
  const actor = { type: 'user' as const, id: input.user.id, userId: input.user.id };
  const actorName = input.user.email ?? input.user.id;
  const origin = `Direct Chat with ${input.agentName}`;

  if (action.action === 'note') {
    // Notes are the agent's own memory, not board state: no card mutation, no
    // live event — they surface through the cross-surface activity digest.
    const [note] = await db.insert(agentNotes).values({
      companyId: input.companyId,
      agentId: input.agentId,
      chatSessionId: input.chatSessionId,
      cardId: action.cardId ?? null,
      body: action.body,
    }).returning();
    if (!note) return { action: 'note', cardId: action.cardId ?? null, title: null, ok: false, detail: 'note insert failed' };
    return { action: 'note', cardId: action.cardId ?? null, title: null, ok: true, detail: `noted: ${action.body.slice(0, 80)}` };
  }

  if (action.action === 'create_card') {
    const assigneeId = await resolveAssigneeId(input.companyId, action.assigneeSlug);
    if (action.assigneeSlug && !assigneeId) {
      return { action: 'create_card', cardId: null, title: action.title, ok: false, detail: `assignee slug "${action.assigneeSlug}" is not an active agent in this company` };
    }
    const [card] = await db.insert(kanbanCards).values({
      companyId: input.companyId,
      projectId: input.projectId,
      title: action.title,
      body: action.body,
      priority: priorityToNumber(action.priority),
      assigneeId,
      columnStatus: 'todo',
      // Every card has a reviewer. A chat-created card has none named, so the
      // chatting user is its reviewer via the human-approval path.
      requiresApproval: true,
      decisionMode: 'auto',
      createdBy: input.user.id,
    }).returning();
    if (!card) return { action: 'create_card', cardId: null, title: action.title, ok: false, detail: 'card insert failed' };

    await recordStageAction({
      cardId: card.id,
      agentId: input.agentId,
      actor,
      fromStatus: null,
      toStatus: card.columnStatus ?? 'todo',
      action: 'create',
      detail: `Stage set to ${card.columnStatus ?? 'todo'} from ${origin} on behalf of ${actorName}.`,
    });
    await recordCardAction({
      companyId: card.companyId,
      cardId: card.id,
      actor,
      action: 'card.created',
      toStatus: card.columnStatus,
      detail: `Card created from ${origin} on behalf of ${actorName}.`,
      metadata: { title: card.title, chatSessionId: input.chatSessionId, agentId: input.agentId },
    });
    await db.insert(activityLog).values({
      companyId: card.companyId, actorType: 'user', actorId: input.user.id, userId: input.user.id, agentId: input.agentId,
      action: 'card.created', entityType: 'card', entityId: card.id,
      details: { title: card.title, stage: card.columnStatus, source: 'chat', chatSessionId: input.chatSessionId },
    });
    publishLiveEvent({ type: 'card.created', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId });
    return { action: 'create_card', cardId: card.id, title: card.title, ok: true, detail: `created in ${card.columnStatus ?? 'todo'}` };
  }

  const [existing] = await db.select().from(kanbanCards)
    .where(and(eq(kanbanCards.id, action.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!existing) return { action: 'update_card', cardId: action.cardId, title: null, ok: false, detail: 'card not found' };
  // A chat session is scoped to one company; never let a reply reach across it.
  if (existing.companyId !== input.companyId) {
    return { action: 'update_card', cardId: action.cardId, title: existing.title, ok: false, detail: 'card belongs to another company' };
  }

  const patch: Partial<typeof kanbanCards.$inferInsert> = { updatedAt: new Date() };
  if (action.title !== undefined) patch.title = action.title;
  if (action.body !== undefined) patch.body = action.body;
  if (action.priority !== undefined) patch.priority = priorityToNumber(action.priority);
  if (action.status !== undefined) patch.columnStatus = action.status;
  const [card] = await db.update(kanbanCards).set(patch).where(eq(kanbanCards.id, action.cardId)).returning();
  if (!card) return { action: 'update_card', cardId: action.cardId, title: existing.title, ok: false, detail: 'card update failed' };

  const changed = Object.keys(patch).filter((key) => key !== 'updatedAt');
  if (action.status !== undefined && action.status !== existing.columnStatus) {
    await recordStageAction({
      cardId: card.id,
      agentId: input.agentId,
      actor,
      fromStatus: existing.columnStatus ?? 'todo',
      toStatus: action.status,
      action: 'update',
      detail: `Stage changed from ${existing.columnStatus ?? 'todo'} to ${action.status} from ${origin} on behalf of ${actorName}.`,
    });
  }
  await recordCardAction({
    companyId: card.companyId,
    cardId: card.id,
    actor,
    action: 'card.updated',
    toStatus: card.columnStatus,
    detail: `Card updated from ${origin} on behalf of ${actorName}.`,
    metadata: { fields: changed, chatSessionId: input.chatSessionId, agentId: input.agentId },
  });
  await db.insert(activityLog).values({
    companyId: card.companyId, actorType: 'user', actorId: input.user.id, userId: input.user.id, agentId: input.agentId,
    action: 'card.updated', entityType: 'card', entityId: card.id,
    details: { title: card.title, fields: changed, source: 'chat', chatSessionId: input.chatSessionId },
  });
  publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'card.updated' });
  return { action: 'update_card', cardId: card.id, title: card.title, ok: true, detail: changed.length ? `updated ${changed.join(', ')}` : 'no fields changed' };
}

export async function applyChatWorkItems(input: ApplyInput, actions: ChatWorkItems): Promise<ChatWorkItemOutcome[]> {
  const outcomes: ChatWorkItemOutcome[] = [];
  for (const action of actions.actions) {
    try {
      outcomes.push(await applyOne(input, action));
    } catch (error) {
      outcomes.push({
        action: action.action,
        cardId: action.action === 'update_card' ? action.cardId : action.action === 'note' ? action.cardId ?? null : null,
        title: action.action === 'create_card' ? action.title : null,
        ok: false,
        detail: error instanceof Error ? error.message : 'chat work item failed',
      });
    }
  }
  return outcomes;
}

export function formatChatWorkItemOutcomes(outcomes: ChatWorkItemOutcome[]): string {
  const lines = outcomes.map((outcome) => {
    if (outcome.action === 'note') return `${outcome.ok ? '✓' : '✗'} Self-note — ${outcome.detail}`;
    const label = outcome.title ?? outcome.cardId ?? 'card';
    const verb = outcome.action === 'create_card' ? 'Created card' : 'Updated card';
    return `${outcome.ok ? '✓' : '✗'} ${verb} "${label}" — ${outcome.detail}`;
  });
  return [`Kanban updates from this conversation:`, ...lines].join('\n');
}
