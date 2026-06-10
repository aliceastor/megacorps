import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAgentSessionSchema, createMachineRunnerSchema, inferCardTransitionAction, normalizeCardStatus, runnerHeartbeatSchema, runnerTaskClaimSchema, runnerTaskCompleteSchema, updateMachineRunnerSchema, type CardActorType, type CardStatus } from '@megacorps/shared';
import { requireAnyVisibleCompany, requireCompanyRole } from './access.ts';
import { assertCardTransition, recordCardAction, recordStageAction } from './card-actions.ts';
import { db } from './db/client.ts';
import { activityLog, agentRuntimes, agentSessions, agents, cardComments, companies, externalWaits, heartbeatRuns, kanbanCards, machineRunners, projects, taskLogs, taskRuns, workProducts } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';
import { generateRunnerApiKey, hashRunnerApiKey, requireAgentSessionAuth, requireRunnerAuth } from './runner-auth.ts';
import { dependenciesMet as cardDependenciesMet } from './card-dependencies.ts';
import { cascadeParentStatus, completionStatusForQualityGate, createPendingApproval, enqueueTaskRun } from './dispatch.ts';

const REDACTED = '[redacted]';
const SENSITIVE_CONFIG_KEY = /(password|pass|token|secret|jwt|apiKey|privateKey)/i;

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_CONFIG_KEY.test(key) ? REDACTED : redactSecrets(item, depth + 1),
    ]));
  }
  return value;
}

function redactRunner<T extends { apiKeyHash?: string }>(runner: T): Omit<T, 'apiKeyHash'> {
  const { apiKeyHash: _apiKeyHash, ...rest } = runner;
  return rest;
}

function redactAgent<T extends { adapterConfig?: unknown }>(agent: T): T {
  return { ...agent, adapterConfig: redactSecrets(agent.adapterConfig) } as T;
}

function redactRuntime<T extends { config?: unknown }>(runtime: T | null | undefined): T | null {
  return runtime ? { ...runtime, config: redactSecrets(runtime.config) } as T : null;
}

function fingerprintFor(input: unknown): string | null {
  if (!input) return null;
  return createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex').slice(0, 32);
}

function httpError(statusCode: number, message: string, code = 'invalid_state') {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cardStatus(value: string | null | undefined): CardStatus {
  return normalizeCardStatus(value) ?? 'todo';
}

function assertStatusMove(from: CardStatus, to: CardStatus, actorType: CardActorType): void {
  if (from === to) return;
  const action = inferCardTransitionAction(from, to);
  if (!action) throw httpError(409, `Cannot move card from ${from} to ${to}`, 'INVALID_TRANSITION');
  assertCardTransition({ action, from, to, actorType });
}

function reviewCanRun(status: CardStatus): boolean {
  return status === 'in_review' || status === 'needs_review';
}

async function defaultCompanyId(): Promise<string | null> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
  return company?.id ?? null;
}

function runnerSupports(runner: typeof machineRunners.$inferSelect, runtime: typeof agentRuntimes.$inferSelect | null | undefined, adapterType: string): boolean {
  const supported = runner.supportedRuntimes ?? [];
  if (supported.length === 0) return true;
  const values = [adapterType, runtime?.name, adapterType.replace(/-/g, '_')].filter((value): value is string => Boolean(value));
  if (!values.some((value) => supported.includes(value))) return false;
  const statuses = (runner.runtimeStatuses ?? {}) as Record<string, string>;
  const status = values.map((value) => statuses[value]).find(Boolean);
  return !status || status === 'ready';
}

async function taskRunPayload(run: typeof taskRuns.$inferSelect) {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, run.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) return null;
  const [agent] = run.agentId ? await db.select().from(agents).where(and(eq(agents.id, run.agentId), isNull(agents.deletedAt))).limit(1) : [];
  const [project] = card.projectId ? await db.select().from(projects).where(eq(projects.id, card.projectId)).limit(1) : [];
  const [runtime] = agent?.runtimeId ? await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1) : [];
  return { taskRun: run, card, agent: agent ? redactAgent(agent) : null, project: project ?? null, runtime: redactRuntime(runtime) };
}

async function createRunnerTaskCompletion(input: {
  runner: typeof machineRunners.$inferSelect;
  run: typeof taskRuns.$inferSelect;
  body: z.infer<typeof runnerTaskCompleteSchema>;
}) {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, input.run.cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) throw new Error('card_not_found');
  const output = [input.body.summary, input.body.output].filter(Boolean).join('\n\n');
  const runStatus = input.body.status === 'failed' || input.body.status === 'blocked'
    ? 'failed'
    : input.body.status === 'cancelled'
      ? 'cancelled'
      : 'success';
  const qualityReviewerId = input.run.kind === 'dispatch' && (input.body.status === 'success' || input.body.status === 'done') && card.reviewerId && card.reviewerId !== card.assigneeId
    ? card.reviewerId
    : null;
  const nextStatus: CardStatus = input.body.status === 'failed'
    ? 'blocked'
    : input.body.status === 'success'
      ? input.run.kind === 'review' ? 'done' : completionStatusForQualityGate('success', qualityReviewerId)
      : completionStatusForQualityGate(input.body.status, qualityReviewerId);
  const fromStatus = cardStatus(card.columnStatus);
  assertStatusMove(fromStatus, nextStatus, 'machine');
  const now = new Date();
  await db.update(taskRuns).set({
    status: runStatus,
    completedAt: now,
    lockedBy: null,
    lockedAt: null,
    output,
    error: input.body.error ?? (runStatus === 'failed' ? input.body.summary ?? 'runner_task_failed' : null),
    costUsd: input.body.costUsd?.toString(),
    updatedAt: now,
  }).where(eq(taskRuns.id, input.run.id));
  if (input.run.heartbeatRunId) {
    await db.update(heartbeatRuns).set({
      status: runStatus,
      completedAt: now,
      error: runStatus === 'failed' ? input.body.error ?? input.body.summary ?? 'runner_task_failed' : null,
      costUsd: input.body.costUsd?.toString(),
    }).where(eq(heartbeatRuns.id, input.run.heartbeatRunId));
  }
  const [updated] = await db.update(kanbanCards).set({
    columnStatus: nextStatus,
    executionLog: output || undefined,
    costUsd: input.body.costUsd?.toString(),
    completedAt: nextStatus === 'done' ? now : nextStatus === 'blocked' || nextStatus === 'cancelled' ? null : undefined,
    lastError: nextStatus === 'blocked' || nextStatus === 'cancelled' ? input.body.error ?? input.body.summary ?? `runner_${nextStatus}` : null,
    executionLockId: null,
    executionLockedByAgentId: null,
    executionLockedAt: null,
    executionLockExpiresAt: null,
    activeHeartbeatRunId: null,
    updatedAt: now,
  }).where(eq(kanbanCards.id, card.id)).returning();
  if (card.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, card.assigneeId));
  if (input.body.workProducts.length > 0) {
    await db.insert(workProducts).values(input.body.workProducts.map((product) => ({
      companyId: card.companyId,
      cardId: card.id,
      projectId: card.projectId,
      agentId: card.assigneeId,
      taskRunId: input.run.id,
      type: product.type,
      title: product.title,
      summary: product.summary ?? null,
      url: product.url ?? null,
      repoProvider: product.repoProvider ?? null,
      repoUrl: product.repoUrl ?? null,
      branch: product.branch ?? null,
      commitSha: product.commitSha ?? null,
      pullRequestUrl: product.pullRequestUrl ?? null,
      metadata: product.metadata,
    })));
  }
  let externalWaitId: string | null = null;
  if (nextStatus === 'waiting_on_external') {
    const externalProduct = input.body.workProducts.find((product) => product.pullRequestUrl || product.url || product.commitSha || product.branch);
    const [wait] = await db.insert(externalWaits).values({
      companyId: card.companyId,
      cardId: card.id,
      waitingFor: input.body.summary ?? externalProduct?.title ?? 'external completion',
      provider: externalProduct?.repoProvider ?? (externalProduct?.pullRequestUrl ? 'git' : 'external'),
      externalId: externalProduct?.commitSha ?? externalProduct?.branch ?? null,
      externalUrl: externalProduct?.pullRequestUrl ?? externalProduct?.url ?? null,
      pollIntervalSeconds: input.body.pollIntervalSeconds ?? null,
      status: 'waiting',
    }).returning();
    externalWaitId = wait?.id ?? null;
  }
  if (nextStatus !== fromStatus) {
    await recordStageAction({
      cardId: card.id,
      agentId: card.assigneeId,
      actor: { type: 'machine', id: input.runner.id, machineRunnerId: input.runner.id },
      fromStatus,
      toStatus: nextStatus,
      detail: `Stage changed from ${fromStatus} to ${nextStatus} by runner ${input.runner.name}.`,
      metadata: { taskRunId: input.run.id, runnerId: input.runner.id },
      logStatus: nextStatus === 'blocked' ? 'failed' : nextStatus === 'cancelled' ? 'warning' : 'success',
    });
  }
  await db.insert(taskLogs).values({
    cardId: card.id,
    agentId: card.assigneeId,
    type: 'runner',
    status: runStatus === 'failed' ? 'failed' : runStatus === 'cancelled' ? 'warning' : 'success',
    message: input.body.summary ?? `Runner completed task run as ${runStatus}.`,
    output: input.body.output,
    costUsd: input.body.costUsd?.toString(),
  });
  const [comment] = await db.insert(cardComments).values({
    cardId: card.id,
    agentId: card.assigneeId,
    authorType: 'system',
    action: `runner_${nextStatus}`,
    body: output || `Runner completed task run as ${runStatus}.`,
  }).returning();
  await db.insert(activityLog).values({
    companyId: card.companyId,
    actorType: 'system',
    actorId: input.runner.id,
    agentId: card.assigneeId,
    action: `runner.task_${nextStatus}`,
    entityType: 'card',
    entityId: card.id,
    details: { taskRunId: input.run.id, runnerId: input.runner.id, status: input.body.status, costUsd: input.body.costUsd, externalWaitId, pollIntervalSeconds: input.body.pollIntervalSeconds ?? null },
  });
  if (comment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: comment.id, cardId: card.id, projectId: card.projectId, action: comment.action });
  if (nextStatus === 'in_review' && qualityReviewerId && updated) {
    await createPendingApproval(updated, card.assigneeId, 'Runner completion requires quality review.');
    await enqueueTaskRun(card.id, 'review', 'queue');
  }
  if (nextStatus === 'done') await cascadeParentStatus(card.parentCardId);
  return updated ?? card;
}

export async function registerRunnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/machine-runners', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const companyIds = query.companyId ? [query.companyId] : access.companyIds;
    if (companyIds.length === 0) return [];
    const rows = await db.select().from(machineRunners).where(and(inArray(machineRunners.companyId, companyIds), isNull(machineRunners.deletedAt))).orderBy(desc(machineRunners.updatedAt));
    return rows.map(redactRunner);
  });

  app.post('/api/machine-runners', async (request, reply) => {
    const input = createMachineRunnerSchema.parse(request.body);
    const companyId = input.companyId ?? await defaultCompanyId();
    if (!companyId) return reply.code(400).send({ error: 'company_required' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const apiKey = generateRunnerApiKey();
    const [runner] = await db.insert(machineRunners).values({
      companyId,
      name: input.name,
      slug: input.slug,
      apiKeyHash: hashRunnerApiKey(apiKey),
      supportedRuntimes: input.supportedRuntimes,
      maxConcurrent: input.maxConcurrent,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot) ?? null,
      localScratchRoot: optionalText(input.localScratchRoot) ?? null,
      metadata: input.metadata,
    }).returning();
    if (!runner) throw new Error('machine_runner_create_failed');
    await db.insert(activityLog).values({
      companyId,
      actorType: 'user',
      actorId: user.id,
      userId: user.id,
      action: 'machine_runner.created',
      entityType: 'machine_runner',
      entityId: runner.id,
      details: { name: runner.name, slug: runner.slug, supportedRuntimes: runner.supportedRuntimes },
    });
    return reply.code(201).send({ runner: redactRunner(runner), apiKey });
  });

  app.put('/api/machine-runners/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateMachineRunnerSchema.parse(request.body);
    const [existing] = await db.select().from(machineRunners).where(and(eq(machineRunners.id, id), isNull(machineRunners.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'machine_runner_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [runner] = await db.update(machineRunners).set({
      name: input.name,
      slug: input.slug,
      status: input.status,
      supportedRuntimes: input.supportedRuntimes,
      maxConcurrent: input.maxConcurrent,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot),
      localScratchRoot: optionalText(input.localScratchRoot),
      metadata: input.metadata,
      updatedAt: new Date(),
    }).where(eq(machineRunners.id, id)).returning();
    return runner ? redactRunner(runner) : runner;
  });

  app.post('/api/machine-runners/:id/rotate-key', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(machineRunners).where(and(eq(machineRunners.id, id), isNull(machineRunners.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'machine_runner_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const apiKey = generateRunnerApiKey();
    const [runner] = await db.update(machineRunners).set({ apiKeyHash: hashRunnerApiKey(apiKey), updatedAt: new Date() }).where(eq(machineRunners.id, id)).returning();
    return { runner: runner ? redactRunner(runner) : runner, apiKey };
  });

  app.delete('/api/machine-runners/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(machineRunners).where(and(eq(machineRunners.id, id), isNull(machineRunners.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'machine_runner_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    await db.update(machineRunners).set({ status: 'disabled', deletedAt: new Date(), updatedAt: new Date() }).where(eq(machineRunners.id, id));
    return { ok: true };
  });

  app.get('/api/runner/me', async (request, reply) => {
    const runner = await requireRunnerAuth(request, reply); if (!runner) return reply;
    return redactRunner(runner);
  });

  app.post('/api/runner/heartbeat', async (request, reply) => {
    const runner = await requireRunnerAuth(request, reply); if (!runner) return reply;
    const input = runnerHeartbeatSchema.parse(request.body ?? {});
    const ip = request.ip;
    const [updated] = await db.update(machineRunners).set({
      name: input.name,
      version: input.version,
      os: input.os,
      supportedRuntimes: input.supportedRuntimes,
      maxConcurrent: input.maxConcurrent,
      activeSlots: input.activeSlots,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot),
      localScratchRoot: optionalText(input.localScratchRoot),
      runtimeStatuses: input.runtimeStatuses,
      metadata: input.metadata,
      status: 'online',
      lastHeartbeatAt: new Date(),
      lastSeenIp: ip,
      updatedAt: new Date(),
    }).where(eq(machineRunners.id, runner.id)).returning();
    return updated ? redactRunner(updated) : redactRunner(runner);
  });

  app.post('/api/runner/agent-sessions', async (request, reply) => {
    const runner = await requireRunnerAuth(request, reply); if (!runner) return reply;
    const input = createAgentSessionSchema.parse(request.body ?? {});
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent || agent.companyId !== runner.companyId) return reply.code(404).send({ error: 'agent_not_found' });
    if (input.cardId) {
      const [card] = await db.select({ companyId: kanbanCards.companyId }).from(kanbanCards).where(and(eq(kanbanCards.id, input.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (!card || card.companyId !== runner.companyId) return reply.code(400).send({ error: 'agent_session_card_mismatch' });
    }
    if (input.taskRunId) {
      const [run] = await db.select({ companyId: taskRuns.companyId, cardId: taskRuns.cardId }).from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).limit(1);
      if (!run || run.companyId !== runner.companyId) return reply.code(400).send({ error: 'agent_session_task_run_mismatch' });
      if (input.cardId && run.cardId !== input.cardId) return reply.code(400).send({ error: 'agent_session_task_run_card_mismatch' });
    }
    const [session] = await db.insert(agentSessions).values({
      companyId: runner.companyId,
      agentId: agent.id,
      machineRunnerId: runner.id,
      cardId: input.cardId ?? null,
      taskRunId: input.taskRunId ?? null,
      sessionKind: input.sessionKind,
      publicKeyJwk: input.publicKeyJwk ?? null,
      publicKey: input.publicKey ?? null,
      fingerprint: input.fingerprint ?? fingerprintFor(input.publicKeyJwk ?? input.publicKey),
      metadata: input.metadata,
    }).returning();
    if (!session) throw new Error('agent_session_create_failed');
    if (session.cardId) await recordCardAction({
      companyId: runner.companyId,
      cardId: session.cardId,
      actor: { type: 'machine', id: runner.id, machineRunnerId: runner.id, sessionId: session.id },
      action: 'agent_session.created',
      detail: `Agent session ${session.id} opened by runner ${runner.name}.`,
      metadata: { agentId: agent.id, taskRunId: session.taskRunId },
    });
    return reply.code(201).send(session);
  });

  app.post('/api/runner/task-runs/claim', async (request, reply) => {
    const runner = await requireRunnerAuth(request, reply); if (!runner) return reply;
    const input = runnerTaskClaimSchema.parse(request.body ?? {});
    if (input.companyId && input.companyId !== runner.companyId) return reply.code(403).send({ error: 'runner_company_mismatch' });
    const kindFilter = input.kinds?.length ? inArray(taskRuns.kind, input.kinds) : undefined;
    const candidates = await db.select().from(taskRuns).where(and(
      eq(taskRuns.companyId, runner.companyId),
      eq(taskRuns.status, 'queued'),
      kindFilter,
    )).orderBy(desc(taskRuns.priority), asc(taskRuns.createdAt)).limit(25);
    for (const run of candidates) {
      const payload = await taskRunPayload(run);
      if (!payload?.agent) continue;
      const fromStatus = cardStatus(payload.card.columnStatus);
      if (run.kind === 'dispatch') {
        if (!(await cardDependenciesMet(payload.card.id))) continue;
        try {
          assertStatusMove(fromStatus, 'in_progress', 'machine');
        } catch {
          continue;
        }
      }
      if (run.kind === 'review' && !reviewCanRun(fromStatus)) continue;
      if (!runnerSupports(runner, payload.runtime, payload.agent.adapterType ?? 'mock')) continue;
      const now = new Date();
      const [claimed] = await db.update(taskRuns).set({
        status: 'running',
        lockedBy: runner.id,
        lockedAt: now,
        startedAt: now,
        updatedAt: now,
      }).where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'queued'))).returning();
      if (!claimed) continue;
      let claimedPayload = { ...payload, taskRun: claimed };
      if (claimed.kind === 'dispatch') {
        const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
        const [lockedCard] = await db.update(kanbanCards).set({
          columnStatus: 'in_progress',
          executionLockId: claimed.id,
          executionLockedByAgentId: payload.agent.id,
          executionLockedAt: now,
          executionLockExpiresAt: expiresAt,
          startedAt: payload.card.startedAt ?? now,
          lastError: null,
          updatedAt: now,
        }).where(and(
          eq(kanbanCards.id, payload.card.id),
          isNull(kanbanCards.deletedAt),
          drizzleSql`(${kanbanCards.executionLockId} IS NULL OR ${kanbanCards.executionLockExpiresAt} < now())`,
        )).returning();
        if (!lockedCard) {
          await db.update(taskRuns).set({ status: 'queued', lockedBy: null, lockedAt: null, startedAt: null, updatedAt: new Date(), error: 'card_execution_locked' }).where(eq(taskRuns.id, claimed.id));
          continue;
        }
        claimedPayload = { ...claimedPayload, card: lockedCard };
        if (fromStatus !== 'in_progress') {
          await recordStageAction({
            cardId: payload.card.id,
            agentId: payload.agent.id,
            actor: { type: 'machine', id: runner.id, machineRunnerId: runner.id },
            fromStatus,
            toStatus: 'in_progress',
            action: 'claim',
            detail: `Runner ${runner.name} claimed dispatch and moved the card to in_progress.`,
            metadata: { taskRunId: claimed.id, runnerId: runner.id },
          });
        }
      }
      await db.update(agents).set({ isBusy: true }).where(eq(agents.id, payload.agent.id));
      await recordCardAction({
        companyId: runner.companyId,
        cardId: payload.card.id,
        actor: { type: 'machine', id: runner.id, machineRunnerId: runner.id },
        action: 'task_run.claimed',
        fromStatus,
        toStatus: claimedPayload.card.columnStatus,
        detail: `Runner ${runner.name} claimed ${claimed.kind} task run.`,
        metadata: { taskRunId: claimed.id, agentId: payload.agent.id },
      });
      return claimedPayload;
    }
    return { taskRun: null };
  });

  app.post('/api/runner/task-runs/:id/complete', async (request, reply) => {
    const runner = await requireRunnerAuth(request, reply); if (!runner) return reply;
    const id = (request.params as { id: string }).id;
    const body = runnerTaskCompleteSchema.parse(request.body ?? {});
    const [run] = await db.select().from(taskRuns).where(and(eq(taskRuns.id, id), eq(taskRuns.companyId, runner.companyId))).limit(1);
    if (!run) return reply.code(404).send({ error: 'task_run_not_found' });
    if (run.status !== 'running' || run.lockedBy !== runner.id) return reply.code(409).send({ error: 'task_run_not_claimed_by_runner' });
    return createRunnerTaskCompletion({ runner, run, body });
  });

  app.get('/api/agent/me', async (request, reply) => {
    const ctx = await requireAgentSessionAuth(request, reply); if (!ctx) return reply;
    return { session: ctx.session, agent: redactAgent(ctx.agent) };
  });

  app.post('/api/agent/cards/:id/claim', async (request, reply) => {
    const ctx = await requireAgentSessionAuth(request, reply); if (!ctx) return reply;
    const id = (request.params as { id: string }).id;
    if (ctx.session.cardId && ctx.session.cardId !== id) return reply.code(403).send({ error: 'agent_session_card_mismatch' });
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card || card.companyId !== ctx.agent.companyId) return reply.code(404).send({ error: 'card_not_found' });
    if (card.assigneeId && card.assigneeId !== ctx.agent.id) return reply.code(409).send({ error: 'card_assigned_to_other_agent' });
    const fromStatus = cardStatus(card.columnStatus);
    assertStatusMove(fromStatus, 'in_progress', 'agent:worker');
    const [updated] = await db.update(kanbanCards).set({ assigneeId: ctx.agent.id, columnStatus: 'in_progress', startedAt: new Date(), updatedAt: new Date() }).where(eq(kanbanCards.id, id)).returning();
    if (fromStatus !== 'in_progress') await recordStageAction({ cardId: id, agentId: ctx.agent.id, actor: { type: 'agent:worker', id: ctx.agent.id, agentId: ctx.agent.id, sessionId: ctx.session.id }, fromStatus, toStatus: 'in_progress', detail: `Agent ${ctx.agent.name} claimed the card.`, metadata: { sessionId: ctx.session.id } });
    return updated;
  });

  app.post('/api/agent/cards/:id/review', async (request, reply) => {
    const ctx = await requireAgentSessionAuth(request, reply); if (!ctx) return reply;
    const id = (request.params as { id: string }).id;
    if (ctx.session.cardId && ctx.session.cardId !== id) return reply.code(403).send({ error: 'agent_session_card_mismatch' });
    const body = z.object({ summary: z.string().trim().max(2000).optional(), output: z.string().max(100_000).optional(), needsHelp: z.boolean().default(false) }).parse(request.body ?? {});
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card || card.companyId !== ctx.agent.companyId) return reply.code(404).send({ error: 'card_not_found' });
    if (card.assigneeId && card.assigneeId !== ctx.agent.id) return reply.code(409).send({ error: 'card_assigned_to_other_agent' });
    const nextStatus = body.needsHelp ? 'needs_review' : 'in_review';
    const fromStatus = cardStatus(card.columnStatus);
    assertStatusMove(fromStatus, nextStatus, 'agent:worker');
    const [updated] = await db.update(kanbanCards).set({ columnStatus: nextStatus, executionLog: [body.summary, body.output].filter(Boolean).join('\n\n'), updatedAt: new Date() }).where(eq(kanbanCards.id, id)).returning();
    if (fromStatus !== nextStatus) await recordStageAction({ cardId: id, agentId: ctx.agent.id, actor: { type: 'agent:worker', id: ctx.agent.id, agentId: ctx.agent.id, sessionId: ctx.session.id }, fromStatus, toStatus: nextStatus, detail: `Agent ${ctx.agent.name} submitted ${body.needsHelp ? 'help review' : 'quality review'}.`, metadata: { sessionId: ctx.session.id } });
    return updated;
  });

  app.post('/api/agent/cards/:id/release', async (request, reply) => {
    const ctx = await requireAgentSessionAuth(request, reply); if (!ctx) return reply;
    const id = (request.params as { id: string }).id;
    if (ctx.session.cardId && ctx.session.cardId !== id) return reply.code(403).send({ error: 'agent_session_card_mismatch' });
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card || card.companyId !== ctx.agent.companyId) return reply.code(404).send({ error: 'card_not_found' });
    const fromStatus = cardStatus(card.columnStatus);
    if (card.assigneeId && card.assigneeId !== ctx.agent.id) return reply.code(409).send({ error: 'card_assigned_to_other_agent' });
    if (!card.assigneeId && fromStatus !== 'todo') return reply.code(409).send({ error: 'card_not_assigned_to_session_agent' });
    assertStatusMove(fromStatus, 'todo', 'agent:worker');
    const [updated] = await db.update(kanbanCards).set({ columnStatus: 'todo', executionLockId: null, executionLockedAt: null, executionLockedByAgentId: null, executionLockExpiresAt: null, activeHeartbeatRunId: null, updatedAt: new Date() }).where(eq(kanbanCards.id, id)).returning();
    await db.update(agents).set({ isBusy: false }).where(eq(agents.id, ctx.agent.id));
    if (fromStatus !== 'todo') await recordStageAction({ cardId: id, agentId: ctx.agent.id, actor: { type: 'agent:worker', id: ctx.agent.id, agentId: ctx.agent.id, sessionId: ctx.session.id }, fromStatus, toStatus: 'todo', detail: `Agent ${ctx.agent.name} released the card.`, metadata: { sessionId: ctx.session.id } });
    return updated;
  });
}
