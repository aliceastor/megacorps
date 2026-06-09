import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  cardRequiredToolsSchema,
  createCardIntegrationSchema,
  createExternalEventSchema,
  createExternalWaitSchema,
  createTaskContextRequestSchema,
  createTaskContextSnapshotSchema,
  createToolSchema,
  normalizeCardStatus,
  updateTaskContextRequestSchema,
  updateToolSchema,
} from '@megacorps/shared';
import { requireAnyVisibleCompany, requireCompanyRole, requireVisibleCompany } from './access.ts';
import { recordCardAction, recordStageAction } from './card-actions.ts';
import { db } from './db/client.ts';
import {
  activityLog,
  agents,
  cardActions,
  cardComments,
  cardIntegrations,
  cardRequiredTools,
  externalEvents,
  externalWaits,
  kanbanCards,
  taskContextRequests,
  taskContextSnapshots,
  taskLogs,
  taskRuns,
  toolRegistry,
  workProducts,
} from './db/schema.ts';
import { buildCompanyKanbanContext, cascadeParentStatus, enqueueTaskRun } from './dispatch.ts';
import { publishLiveEvent } from './live.ts';

type CardRow = typeof kanbanCards.$inferSelect;

function hashValue(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function visibleCard(request: Parameters<typeof requireVisibleCompany>[0], reply: Parameters<typeof requireVisibleCompany>[1], cardId: string): Promise<CardRow | null> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) {
    await reply.code(404).send({ error: 'card_not_found' });
    return null;
  }
  const user = await requireVisibleCompany(request, reply, card.companyId);
  return user ? card : null;
}

async function operatorCard(request: Parameters<typeof requireCompanyRole>[0], reply: Parameters<typeof requireCompanyRole>[1], cardId: string): Promise<{ card: CardRow; user: { id: string; email?: string } } | null> {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) {
    await reply.code(404).send({ error: 'card_not_found' });
    return null;
  }
  const user = await requireCompanyRole(request, reply, card.companyId, 'operator');
  return user ? { card, user } : null;
}

async function rootCardId(card: CardRow): Promise<string> {
  let current = card;
  const seen = new Set<string>();
  while (current.parentCardId && !seen.has(current.parentCardId)) {
    seen.add(current.id);
    const [parent] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, current.parentCardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function statusPercent(status: string | null | undefined): number {
  switch (status) {
    case 'done': return 100;
    case 'in_review': return 80;
    case 'needs_review': return 70;
    case 'waiting_on_external': return 60;
    case 'in_progress': return 50;
    case 'todo': return 10;
    default: return 0;
  }
}

async function cardRollup(card: CardRow) {
  const rows = await db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId, card.companyId), isNull(kanbanCards.deletedAt)));
  const byParent = new Map<string, CardRow[]>();
  for (const row of rows) {
    if (!row.parentCardId) continue;
    byParent.set(row.parentCardId, [...(byParent.get(row.parentCardId) ?? []), row]);
  }
  const subtree: CardRow[] = [];
  const visit = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      subtree.push(child);
      visit(child.id);
    }
  };
  visit(card.id);
  const counts = subtree.reduce<Record<string, number>>((acc, row) => {
    const status = row.columnStatus ?? 'todo';
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const required = subtree.filter((row) => (row.childRequirementLevel ?? 'required') === 'required');
  const weights = subtree.map((row) => Number(row.estimatedWeight ?? 1) || 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const rollupPercent = subtree.length === 0
    ? statusPercent(card.columnStatus)
    : Math.round(subtree.reduce((sum, row, index) => sum + statusPercent(row.columnStatus) * (weights[index] ?? 1), 0) / Math.max(1, totalWeight));
  const blocked = subtree.find((row) => row.columnStatus === 'blocked');
  const waitingExternal = subtree.filter((row) => row.columnStatus === 'waiting_on_external');
  const needsReview = subtree.find((row) => row.columnStatus === 'needs_review' || row.columnStatus === 'in_review');
  const active = subtree.find((row) => row.columnStatus === 'in_progress');
  const nextAction = needsReview?.reviewerId
    ? { type: 'reviewer', agentId: needsReview.reviewerId, cardId: needsReview.id }
    : blocked?.assigneeId
      ? { type: 'blocked_assignee', agentId: blocked.assigneeId, cardId: blocked.id }
      : active?.assigneeId
        ? { type: 'assignee', agentId: active.assigneeId, cardId: active.id }
        : waitingExternal[0]
          ? { type: 'external', cardId: waitingExternal[0].id }
          : null;
  return {
    cardId: card.id,
    childTotal: subtree.length,
    requiredChildTotal: required.length,
    counts,
    waitingOnExternal: waitingExternal.length,
    rollupPercent,
    rollupStatus: blocked ? 'blocked' : waitingExternal.length ? 'waiting_on_external' : subtree.length ? 'waiting_on_children' : card.columnStatus ?? 'todo',
    nextAction,
    estimatedDurationMinutes: subtree.reduce((sum, row) => sum + Number(row.estimatedDurationMinutes ?? 0), Number(card.estimatedDurationMinutes ?? 0)),
    budgetAllocated: subtree.reduce((sum, row) => sum + Number(row.taskBudgetLimit ?? 0), Number(card.taskBudgetLimit ?? 0)),
  };
}

async function taskContextPackage(card: CardRow) {
  const rootId = await rootCardId(card);
  const [root] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, rootId)).limit(1);
  const companyCards = await db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId, card.companyId), isNull(kanbanCards.deletedAt))).orderBy(desc(kanbanCards.updatedAt));
  const byParent = new Map<string, CardRow[]>();
  for (const row of companyCards) {
    if (!row.parentCardId) continue;
    byParent.set(row.parentCardId, [...(byParent.get(row.parentCardId) ?? []), row]);
  }
  const flowCardIds = new Set<string>([rootId, card.id]);
  const visit = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      if (flowCardIds.has(child.id)) continue;
      flowCardIds.add(child.id);
      visit(child.id);
    }
  };
  visit(rootId);
  const flowCards = companyCards.filter((row) => flowCardIds.has(row.id));
  const agentIds = Array.from(new Set(flowCards.flatMap((row) => [row.assigneeId, row.reviewerId]).filter((id): id is string => Boolean(id))));
  const cast = agentIds.length ? await db.select().from(agents).where(inArray(agents.id, agentIds)) : [];
  const parentChain: CardRow[] = [];
  let current = card;
  const seen = new Set<string>();
  while (current.parentCardId && !seen.has(current.parentCardId)) {
    seen.add(current.id);
    const parent = companyCards.find((row) => row.id === current.parentCardId);
    if (!parent) break;
    parentChain.unshift(parent);
    current = parent;
  }
  const [comments, logs, actions, contextRequests] = await Promise.all([
    db.select().from(cardComments).where(inArray(cardComments.cardId, [...flowCardIds])).orderBy(desc(cardComments.createdAt)).limit(30),
    db.select().from(taskLogs).where(inArray(taskLogs.cardId, [...flowCardIds])).orderBy(desc(taskLogs.createdAt)).limit(30),
    db.select().from(cardActions).where(eq(cardActions.cardId, card.id)).orderBy(desc(cardActions.createdAt)).limit(30),
    db.select().from(taskContextRequests).where(inArray(taskContextRequests.currentCardId, [...flowCardIds])).orderBy(desc(taskContextRequests.createdAt)).limit(30),
  ]);
  return {
    rootMission: root ? { id: root.id, title: root.title, body: root.body, status: root.columnStatus, priority: root.priority, tags: root.tags } : null,
    parentChain: parentChain.map((row) => ({ id: row.id, title: row.title, status: row.columnStatus, assigneeId: row.assigneeId, reviewerId: row.reviewerId })),
    currentCard: card,
    flowMap: flowCards
      .map((row) => ({ id: row.id, parentCardId: row.parentCardId, title: row.title, status: row.columnStatus, assigneeId: row.assigneeId, reviewerId: row.reviewerId, dependencies: row.dependencyCardIds ?? [] })),
    mainCast: cast.map((agent) => ({ id: agent.id, name: agent.name, departmentId: agent.departmentId, positionId: agent.positionId, bossId: agent.bossId, adapterType: agent.adapterType, isBusy: agent.isBusy, isActive: agent.isActive })),
    messageDigest: comments.map((comment) => ({ id: comment.id, cardId: comment.cardId, authorType: comment.authorType, action: comment.action, body: comment.body.slice(0, 1000), createdAt: comment.createdAt })),
    logDigest: logs.map((log) => ({ id: log.id, cardId: log.cardId, type: log.type, status: log.status, message: log.message, createdAt: log.createdAt })),
    contextRequests: contextRequests.map((row) => ({ id: row.id, currentCardId: row.currentCardId, agentId: row.agentId, requestedCardIds: row.requestedCardIds ?? [], requestedLogKinds: row.requestedLogKinds ?? [], reason: row.reason, status: row.status, createdAt: row.createdAt, resolvedAt: row.resolvedAt })),
    actions: actions.map((action) => ({ id: action.id, action: action.action, fromStatus: action.fromStatus, toStatus: action.toStatus, detail: action.detail, createdAt: action.createdAt })),
    rollup: await cardRollup(card),
  };
}

export async function registerLifecycleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cards/:id/rollup', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return cardRollup(card);
  });

  app.get('/api/cards/:id/context', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return taskContextPackage(card);
  });

  app.get('/api/cards/:id/context-snapshots', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(taskContextSnapshots).where(eq(taskContextSnapshots.currentCardId, card.id)).orderBy(desc(taskContextSnapshots.createdAt)).limit(200);
  });

  app.post('/api/cards/:id/context-snapshots', async (request, reply) => {
    const access = await operatorCard(request, reply, (request.params as { id: string }).id);
    if (!access) return reply;
    const input = createTaskContextSnapshotSchema.parse(request.body ?? {});
    const context = await taskContextPackage(access.card);
    const promptContext = await buildCompanyKanbanContext(access.card.companyId, { focusCardId: access.card.id, focusAgentId: input.agentId ?? access.card.assigneeId });
    const rootId = await rootCardId(access.card);
    const summaryJson = { ...input.summaryJson, contextPackage: context, promptContextPreview: promptContext.slice(0, 8000) };
    const [snapshot] = await db.insert(taskContextSnapshots).values({
      companyId: access.card.companyId,
      rootCardId: rootId,
      currentCardId: access.card.id,
      taskRunId: input.taskRunId ?? null,
      agentId: input.agentId ?? null,
      mode: input.mode,
      contextHash: hashValue(summaryJson),
      tokenEstimate: estimateTokens(promptContext),
      includedCardIds: context.flowMap.map((row) => row.id),
      includedCommentIds: context.messageDigest.map((row) => row.id),
      includedLogIds: context.logDigest.map((row) => row.id),
      redactionSummary: 'Prompt context uses existing adapter prompt redaction and scoped company/card context.',
      summaryJson,
    }).returning();
    if (snapshot) await recordCardAction({ companyId: access.card.companyId, cardId: access.card.id, actor: { type: 'user', id: access.user.id, userId: access.user.id }, action: 'context.snapshot_created', detail: `Context snapshot created for ${input.mode}.`, metadata: { snapshotId: snapshot.id } });
    return reply.code(201).send(snapshot);
  });

  app.get('/api/cards/:id/context-requests', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(taskContextRequests).where(eq(taskContextRequests.currentCardId, card.id)).orderBy(desc(taskContextRequests.createdAt)).limit(200);
  });

  app.post('/api/cards/:id/context-requests', async (request, reply) => {
    const access = await operatorCard(request, reply, (request.params as { id: string }).id);
    if (!access) return reply;
    const input = createTaskContextRequestSchema.parse(request.body ?? {});
    const rootId = await rootCardId(access.card);
    if (input.requestedCardIds.length > 0) {
      const requestedRows = await db.select({ id: kanbanCards.id }).from(kanbanCards).where(and(inArray(kanbanCards.id, input.requestedCardIds), eq(kanbanCards.companyId, access.card.companyId), isNull(kanbanCards.deletedAt)));
      if (requestedRows.length !== input.requestedCardIds.length) return reply.code(400).send({ error: 'requested_context_card_company_mismatch' });
    }
    const [contextRequest] = await db.insert(taskContextRequests).values({
      companyId: access.card.companyId,
      rootCardId: rootId,
      currentCardId: access.card.id,
      agentId: input.agentId ?? access.card.assigneeId,
      requestedCardIds: input.requestedCardIds,
      requestedLogKinds: input.requestedLogKinds,
      reason: input.reason,
      status: 'open',
    }).returning();
    if (contextRequest) {
      await recordCardAction({
        companyId: access.card.companyId,
        cardId: access.card.id,
        actor: { type: 'user', id: access.user.id, userId: access.user.id },
        action: 'context.request_created',
        detail: input.reason,
        metadata: { contextRequestId: contextRequest.id, requestedCardIds: input.requestedCardIds, requestedLogKinds: input.requestedLogKinds },
      });
      await db.insert(activityLog).values({ companyId: access.card.companyId, actorType: 'user', actorId: access.user.id, userId: access.user.id, agentId: input.agentId ?? access.card.assigneeId, action: 'context_request.created', entityType: 'card', entityId: access.card.id, details: { contextRequestId: contextRequest.id, requestedCardIds: input.requestedCardIds, requestedLogKinds: input.requestedLogKinds } });
    }
    return reply.code(201).send(contextRequest);
  });

  app.put('/api/context-requests/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateTaskContextRequestSchema.parse(request.body ?? {});
    const [existing] = await db.select().from(taskContextRequests).where(eq(taskContextRequests.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'context_request_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [updated] = await db.update(taskContextRequests).set({
      status: input.status,
      resolvedAt: input.status === 'open' ? null : new Date(),
    }).where(eq(taskContextRequests.id, id)).returning();
    if (updated) {
      await recordCardAction({
        companyId: existing.companyId,
        cardId: existing.currentCardId,
        actor: { type: 'user', id: user.id, userId: user.id },
        action: 'context.request_updated',
        detail: `Context request ${input.status}.`,
        metadata: { contextRequestId: id, status: input.status },
      });
      await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: existing.agentId, action: 'context_request.updated', entityType: 'context_request', entityId: id, details: { status: input.status, currentCardId: existing.currentCardId } });
    }
    return updated;
  });

  app.get('/api/cards/:id/external-waits', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(externalWaits).where(eq(externalWaits.cardId, card.id)).orderBy(desc(externalWaits.createdAt));
  });

  app.post('/api/cards/:id/external-waits', async (request, reply) => {
    const access = await operatorCard(request, reply, (request.params as { id: string }).id);
    if (!access) return reply;
    const input = createExternalWaitSchema.parse(request.body ?? {});
    const fromStatus = normalizeCardStatus(access.card.columnStatus) ?? 'todo';
    const now = new Date();
    const [wait] = await db.insert(externalWaits).values({
      companyId: access.card.companyId,
      cardId: access.card.id,
      waitingFor: input.waitingFor,
      provider: input.provider,
      externalId: input.externalId ?? null,
      externalUrl: input.externalUrl ?? null,
      timeoutAt: input.timeoutAt ? new Date(input.timeoutAt) : null,
      status: 'waiting',
    }).returning();
    const [updated] = await db.update(kanbanCards).set({
      columnStatus: 'waiting_on_external',
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: now,
    }).where(eq(kanbanCards.id, access.card.id)).returning();
    await db.update(taskRuns).set({ status: 'success', completedAt: now, lockedBy: null, lockedAt: null, output: `Waiting on external ${input.provider}: ${input.waitingFor}`, updatedAt: now }).where(and(eq(taskRuns.cardId, access.card.id), eq(taskRuns.status, 'running')));
    if (access.card.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, access.card.assigneeId));
    await recordStageAction({ cardId: access.card.id, agentId: access.card.assigneeId, actor: { type: 'user', id: access.user.id, userId: access.user.id }, fromStatus, toStatus: 'waiting_on_external', action: 'wait_external', detail: `Waiting on ${input.provider}: ${input.waitingFor}.`, metadata: { externalWaitId: wait?.id } });
    await db.insert(taskLogs).values({ cardId: access.card.id, agentId: access.card.assigneeId, type: 'webhook', status: 'queued', message: `Waiting on external ${input.provider}: ${input.waitingFor}` });
    publishLiveEvent({ type: 'card.updated', companyId: access.card.companyId, entityType: 'card', entityId: access.card.id, cardId: access.card.id, projectId: access.card.projectId, action: 'card.waiting_on_external' });
    return reply.code(201).send({ wait, card: updated });
  });

  app.get('/api/external-events', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; cardId?: string; provider?: string; limit?: string };
    if (!query.companyId && access.companyIds.length === 0) return [];
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const filters = [
      query.companyId ? eq(externalEvents.companyId, query.companyId) : inArray(externalEvents.companyId, access.companyIds),
      query.cardId ? eq(externalEvents.cardId, query.cardId) : undefined,
      query.provider ? eq(externalEvents.provider, query.provider) : undefined,
    ].filter(Boolean);
    return db.select().from(externalEvents).where(and(...filters)).orderBy(desc(externalEvents.receivedAt)).limit(Number(query.limit ?? 200));
  });

  app.post('/api/external-events', async (request, reply) => {
    const input = createExternalEventSchema.parse(request.body ?? {});
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, input.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    const companyId = input.companyId ?? card.companyId;
    if (companyId !== card.companyId) return reply.code(400).send({ error: 'external_event_company_mismatch' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const now = new Date();
    const [event] = await db.insert(externalEvents).values({
      companyId,
      projectId: input.projectId ?? card.projectId,
      rootCardId: input.rootCardId ?? await rootCardId(card),
      cardId: card.id,
      provider: input.provider,
      eventType: input.eventType,
      externalId: input.externalId ?? null,
      externalUrl: input.externalUrl ?? null,
      status: input.status,
      payloadHash: hashValue(input.payload),
      payloadSummary: input.payloadSummary ?? null,
      payload: input.payload,
      processedAt: now,
    }).returning();
    await db.update(externalWaits).set({ status: input.status, resolvedAt: input.status === 'waiting' || input.status === 'info' ? undefined : now }).where(and(eq(externalWaits.cardId, card.id), eq(externalWaits.status, 'waiting')));
    let nextStatus = card.columnStatus;
    if (input.status === 'success') nextStatus = card.reviewerId ? 'in_review' : 'done';
    if (input.status === 'failure' || input.status === 'cancelled') nextStatus = card.assigneeId ? 'in_progress' : 'blocked';
    if (input.status === 'timeout') nextStatus = 'blocked';
    if (nextStatus !== card.columnStatus && nextStatus) {
      const fromStatus = normalizeCardStatus(card.columnStatus) ?? 'todo';
      const toStatus = normalizeCardStatus(nextStatus) ?? fromStatus;
      await db.update(kanbanCards).set({
        columnStatus: toStatus,
        lastError: toStatus === 'blocked' ? input.payloadSummary ?? `${input.provider} ${input.eventType} ${input.status}` : null,
        completedAt: toStatus === 'done' ? now : null,
        updatedAt: now,
      }).where(eq(kanbanCards.id, card.id));
      const action = input.status === 'success'
        ? 'external_success'
        : toStatus === 'in_progress'
          ? 'external_failure'
          : toStatus === 'blocked'
            ? 'block'
            : 'manual_move';
      await recordStageAction({ cardId: card.id, agentId: card.assigneeId, actor: { type: 'user', id: user.id, userId: user.id }, fromStatus, toStatus, action, detail: `External ${input.provider}/${input.eventType} reported ${input.status}.`, metadata: { externalEventId: event?.id } });
      if (toStatus === 'in_review') await enqueueTaskRun(card.id, 'review', 'queue');
      if (toStatus === 'done') await cascadeParentStatus(card.parentCardId);
    }
    await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'webhook', status: input.status === 'failure' || input.status === 'timeout' ? 'failed' : 'success', message: `External event ${input.provider}/${input.eventType}: ${input.status}`, output: input.payloadSummary ?? undefined });
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: card.assigneeId, action: 'external_event.received', entityType: 'card', entityId: card.id, details: { externalEventId: event?.id, provider: input.provider, eventType: input.eventType, status: input.status } });
    publishLiveEvent({ type: 'card.updated', companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'external_event.received' });
    return reply.code(201).send({ event, newStatus: nextStatus });
  });

  app.get('/api/tools', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; projectId?: string; active?: string };
    if (!query.companyId && access.companyIds.length === 0) return [];
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const filters = [
      query.companyId ? eq(toolRegistry.companyId, query.companyId) : inArray(toolRegistry.companyId, access.companyIds),
      query.projectId ? eq(toolRegistry.projectId, query.projectId) : undefined,
      query.active === 'true' ? eq(toolRegistry.isActive, true) : query.active === 'false' ? eq(toolRegistry.isActive, false) : undefined,
    ].filter(Boolean);
    return db.select().from(toolRegistry).where(and(...filters)).orderBy(desc(toolRegistry.updatedAt));
  });

  app.post('/api/tools', async (request, reply) => {
    const input = createToolSchema.parse(request.body ?? {});
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    const [tool] = await db.insert(toolRegistry).values({
      ...input,
      projectId: input.projectId ?? null,
      description: input.description ?? null,
      ownerAgentId: input.ownerAgentId ?? null,
      ownerUserId: input.ownerUserId ?? user.id,
    }).returning();
    if (tool) await db.insert(activityLog).values({ companyId: tool.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'tool.created', entityType: 'tool', entityId: tool.id, details: { name: tool.name, version: tool.version } });
    return reply.code(201).send(tool);
  });

  app.put('/api/tools/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateToolSchema.parse(request.body ?? {});
    const [existing] = await db.select().from(toolRegistry).where(eq(toolRegistry.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'tool_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'tool_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [tool] = await db.update(toolRegistry).set({
      projectId: input.projectId === undefined ? undefined : input.projectId ?? null,
      name: input.name,
      version: input.version,
      description: input.description === undefined ? undefined : input.description ?? null,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      ownerAgentId: input.ownerAgentId === undefined ? undefined : input.ownerAgentId ?? null,
      ownerUserId: input.ownerUserId === undefined ? undefined : input.ownerUserId ?? null,
      isRequiredEligible: input.isRequiredEligible,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(toolRegistry.id, id)).returning();
    return tool;
  });

  app.delete('/api/tools/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(toolRegistry).where(eq(toolRegistry.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'tool_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    await db.update(toolRegistry).set({ isActive: false, updatedAt: new Date() }).where(eq(toolRegistry.id, id));
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'tool.disabled', entityType: 'tool', entityId: id, details: { name: existing.name, version: existing.version } });
    return { ok: true };
  });

  app.get('/api/cards/:id/required-tools', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select({ cardTool: cardRequiredTools, tool: toolRegistry }).from(cardRequiredTools).innerJoin(toolRegistry, eq(cardRequiredTools.toolId, toolRegistry.id)).where(eq(cardRequiredTools.cardId, card.id));
  });

  app.put('/api/cards/:id/required-tools', async (request, reply) => {
    const access = await operatorCard(request, reply, (request.params as { id: string }).id);
    if (!access) return reply;
    const input = cardRequiredToolsSchema.parse(request.body ?? {});
    if (input.toolIds.length > 0) {
      const tools = await db.select().from(toolRegistry).where(and(inArray(toolRegistry.id, input.toolIds), eq(toolRegistry.companyId, access.card.companyId), eq(toolRegistry.isActive, true), eq(toolRegistry.isRequiredEligible, true)));
      if (tools.length !== input.toolIds.length) return reply.code(400).send({ error: 'required_tool_unavailable_or_not_eligible' });
    }
    await db.delete(cardRequiredTools).where(eq(cardRequiredTools.cardId, access.card.id));
    if (input.toolIds.length > 0) await db.insert(cardRequiredTools).values(input.toolIds.map((toolId) => ({ cardId: access.card.id, toolId, reason: input.reason ?? null })));
    await recordCardAction({ companyId: access.card.companyId, cardId: access.card.id, actor: { type: 'user', id: access.user.id, userId: access.user.id }, action: 'card.required_tools_updated', detail: `Required tools updated (${input.toolIds.length}).`, metadata: { toolIds: input.toolIds, reason: input.reason } });
    return { ok: true, toolIds: input.toolIds };
  });

  app.get('/api/cards/:id/integrations', async (request, reply) => {
    const card = await visibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(cardIntegrations).where(eq(cardIntegrations.parentCardId, card.id)).orderBy(desc(cardIntegrations.createdAt));
  });

  app.post('/api/cards/:id/integrations', async (request, reply) => {
    const access = await operatorCard(request, reply, (request.params as { id: string }).id);
    if (!access) return reply;
    const input = createCardIntegrationSchema.parse(request.body ?? {});
    const childIds = input.sourceChildCardIds.length
      ? input.sourceChildCardIds
      : (await db.select({ id: kanbanCards.id }).from(kanbanCards).where(eq(kanbanCards.parentCardId, access.card.id))).map((row) => row.id);
    if (childIds.length > 0) {
      const childRows = await db.select().from(kanbanCards).where(and(inArray(kanbanCards.id, childIds), eq(kanbanCards.companyId, access.card.companyId)));
      if (childRows.length !== childIds.length) return reply.code(400).send({ error: 'integration_child_company_mismatch' });
    }
    const allWorkProductIds = [...input.acceptedWorkProductIds, ...input.droppedWorkProductIds];
    if (allWorkProductIds.length > 0) {
      const productRows = await db.select({ id: workProducts.id }).from(workProducts).where(and(inArray(workProducts.id, allWorkProductIds), eq(workProducts.companyId, access.card.companyId)));
      if (productRows.length !== allWorkProductIds.length) return reply.code(400).send({ error: 'integration_work_product_company_mismatch' });
    }
    const [integration] = await db.insert(cardIntegrations).values({
      companyId: access.card.companyId,
      parentCardId: access.card.id,
      integratorAgentId: input.integratorAgentId ?? access.card.assigneeId,
      sourceChildCardIds: childIds,
      summary: input.summary,
      acceptedWorkProductIds: input.acceptedWorkProductIds,
      droppedWorkProductIds: input.droppedWorkProductIds,
      conflictNotes: input.conflictNotes ?? null,
      status: input.status,
    }).returning();
    if (integration) {
      await recordCardAction({ companyId: access.card.companyId, cardId: access.card.id, actor: { type: 'user', id: access.user.id, userId: access.user.id }, action: input.conflictNotes ? 'integration.conflict_recorded' : 'integration.created', detail: input.summary, metadata: { integrationId: integration.id, childIds, status: input.status } });
      if (input.status === 'accepted') {
        await db.update(kanbanCards).set({ executionLog: input.summary, rollupStatus: 'ready_for_review', updatedAt: new Date() }).where(eq(kanbanCards.id, access.card.id));
      }
    }
    return reply.code(201).send(integration);
  });
}
