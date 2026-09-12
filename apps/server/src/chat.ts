import { claimAgentCapacity } from './dispatch.ts';
import { projectModelWarningChat } from './a2a-final-output.ts';
import { companyDiscoveryContext } from './company-discovery.ts';
import { agentOperationGuide } from './agent-operation-guide.ts';
import { z } from 'zod';
import { readLimit, optionalReadId, optionalReadProject } from './read-query.ts';
import { buildCommonCompanyContext } from './company-context.ts';
import { companyOutputSanitizer, sanitizeCompanyOutput } from './output-secrets.ts';
import { createHash } from 'node:crypto';
import { createChatMessageSchema, createChatSessionSchema } from '@megacorps/shared';
import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, type AuthUser } from './auth.ts';
import { hasCompanyRole, membershipRole, requireAnyVisibleCompany, requireCompanyRole } from './access.ts';
import { getAdapter } from './adapters/registry.ts';
import { stripHermesSessionMetadata } from './adapters/hermes.ts';
import { db } from './db/client.ts';
import { activityLog, agentRuntimes, agents, chatMessages, chatSessions, companies, costEvents, departments, goals, heartbeatRuns, kanbanCards, positions, projects, users } from './db/schema.ts';
import { budgetOk, buildCompanyKanbanContext, buildExecutionAgent, getBudgetGuard } from './dispatch.ts';
import { attemptKey, executeUsage, usageBudgetState, resultUsage, scopeFromEntry, settleUsage } from './usage-ledger.ts';
import { publishLiveEvent } from './live.ts';
import { findAdapterSession, rememberAdapterSession } from './adapter-sessions.ts';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';
import { workspaceProtocolLines } from './workspace-paths.ts';
import { readChatTaskTimeoutSeconds } from './runtime-settings.ts';
import { applyChatWorkItems, extractChatWorkItems, formatChatWorkItemOutcomes } from './chat-work-items.ts';
import { buildAgentDigest } from './agent-digest.ts';
import { giteaAuthenticatedCloneUrl, giteaCloneUrlForAgent, giteaConfigFromEnv } from './gitea.ts';

import { chatJobs, type ChatJob } from './db/chat-jobs-schema.ts';
import { createChatJobWorker, enqueueChatJob, projectChatJob, publicChatJob, type ChatJobAcknowledger } from './chat-jobs.ts';
import { withUsageAttempt } from './usage-context.ts';

type ChatMessageRow = typeof chatMessages.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type GoalRow = typeof goals.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type RuntimeRow = typeof agentRuntimes.$inferSelect;

const DIRECT_CHAT_BOOTSTRAP_MESSAGE_LIMIT = 30;
const DIRECT_CHAT_CONTINUATION_MESSAGE_LIMIT = 40;
const DIRECT_CHAT_CONTINUATION_HISTORY_CHARS = 12_000;
const DIRECT_CHAT_CARD_INDEX_LIMIT = 60;

function contextHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function titleFromMessage(body: string, agentName: string): string {
  const firstLine = body.replace(/\s+/g, ' ').trim().slice(0, 72);
  return firstLine || `Chat with ${agentName}`;
}

function formatGoal(goal: GoalRow): string {
  const scope = goal.projectId ? 'Project goal' : goal.departmentId ? 'Department goal' : 'Company goal';
  return `- ${scope}: ${goal.title}${goal.body ? `\n  ${goal.body.slice(0, 1200)}` : ''}`;
}

function runtimeLocalContext(runtime: RuntimeRow | null | undefined): string {
  return [
    `Runtime-local workspace root: ${runtime?.localWorkspaceRoot ?? 'not configured'}`,
    `Runtime-local scratch root: ${runtime?.localScratchRoot ?? 'not configured'}`,
  ].join('\n');
}

function agentWorkspaceContext(company: CompanyRow | null | undefined, project: ProjectRow | null | undefined, runtime: RuntimeRow | null | undefined, agent: AgentRow | null | undefined): string {
  return workspaceProtocolLines({
    companySlug: company?.slug ?? 'company',
    agentSlug: agent?.slug ?? 'agent',
    projectName: project?.name ?? null,
    mountRoot: runtime?.nfsMountRoot ?? null,
    localWorkspaceRoot: runtime?.localWorkspaceRoot ?? null,
    nfsShareUrl: company?.nfsShareUrl ?? null,
  }).join('\n');
}

function projectRepoContext(company: CompanyRow | null | undefined, project: ProjectRow | null | undefined, runtime?: RuntimeRow | null, agent?: AgentRow | null): string {
  if (!project) return [
    'Project repository: none',
    agentWorkspaceContext(company, null, runtime, agent),
    runtimeLocalContext(runtime),
    'Repository rule: no repo is configured, so do not invent shared local workspace paths. Runtime-local scratch is only for temporary work.',
  ].join('\n');
  const repoUrl = project.repoProvider === 'gitea-local' && project.repoUrl
    ? giteaCloneUrlForAgent(project.repoUrl, giteaConfigFromEnv())
    : project.repoUrl;
  return [
    `Project repository provider: ${project.repoProvider ?? 'github'}`,
    `Project repository URL: ${repoUrl ?? 'not configured'}`,
    project.repoProvider === 'gitea-local' && repoUrl && agent?.giteaUsername && agent.giteaToken
      ? `Git credentials (yours alone): username ${agent.giteaUsername}, token ${agent.giteaToken}; authenticated clone URL ${giteaAuthenticatedCloneUrl(repoUrl, agent.giteaUsername, agent.giteaToken)}`
      : '',
    project.publishRepoUrl ? `Publish target: ${project.publishRepoUrl}${project.publishToken ? ' (auth token available in task prompts)' : ''}` : '',
    `Project work path: ${project.workPath ?? 'project root'}`,
    agentWorkspaceContext(company, project, runtime, agent),
    runtimeLocalContext(runtime),
    `Default branch: ${project.defaultBranch ?? 'main'}`,
    `Task branch pattern: ${project.workBranchPattern ?? 'megacorps/card-{cardId}-{agentSlug}'}`,
    `Pull before run: ${project.pullBeforeRun === false ? 'no' : 'yes'}`,
    `Push after run: ${project.pushAfterRun === false ? 'no' : 'yes'}`,
    `Completion policy: ${project.completionPolicy ?? 'push_or_pr'}`,
    project.setupCommand ? `Setup command: ${project.setupCommand}` : '',
    project.testCommand ? `Test command: ${project.testCommand}` : '',
    repoUrl
      ? 'Repository rule: use your runtime-owned local clone under the runtime-local workspace root when configured, stay inside the project work path unless explicitly required, pull/rebase before code changes, commit and push/PR completed work, and report PR/commit/preview links rather than local-only paths.'
      : 'Repository rule: no repo is configured, so do not invent shared local workspace paths. Runtime-local scratch is only for temporary work.',
    'Deliverable rule: durable reports, exports, handoff docs, and other non-code files belong in the project repo (e.g. a deliverables/ or docs/ folder), committed and pushed, then reported as workProducts — not only as /tmp files.',
  ].filter(Boolean).join('\n');
}

export async function buildDirectChatGoalContext(companyId: string, agent: AgentRow, projectId: string | null): Promise<string> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [project] = projectId ? await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1) : [];
  const [runtime] = agent.runtimeId ? await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, agent.runtimeId)).limit(1) : [];
  const [department] = agent.departmentId ? await db.select().from(departments).where(eq(departments.id, agent.departmentId)).limit(1) : [];
  const [position] = agent.positionId ? await db.select().from(positions).where(and(eq(positions.id, agent.positionId), eq(positions.companyId, companyId))).limit(1) : [];
  const companyGoals = await db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(desc(goals.createdAt));
  const positionPrompt = formatAgentPositionPrompt({ positionName: position?.name, departmentName: department?.name, companyName: company?.name, customPrompt: position?.prompt, isCompanyLeadership: Boolean(position?.isCompanyLeadership || position?.isCompanyBoss) });
  return [
    await buildCommonCompanyContext(companyId, agent.id),
    await companyDiscoveryContext(companyId, projectId),
    `Project: ${project?.name ?? 'No project / general chat'}`,
    project?.description ? `Project description: ${project.description}` : '',
    projectRepoContext(company, project, runtime, agent),
    `Department: ${department?.name ?? 'none'}`,
    positionPrompt ? `Position prompt:\n${positionPrompt}` : '',
    `Company goals:\n${companyGoals.filter((goal) => !goal.departmentId && !goal.projectId).map(formatGoal).join('\n') || 'none'}`,
    `Department goals:\n${agent.departmentId ? companyGoals.filter((goal) => goal.departmentId === agent.departmentId).map(formatGoal).join('\n') || 'none' : 'none'}`,
    `Project goals:\n${projectId ? companyGoals.filter((goal) => goal.projectId === projectId).map(formatGoal).join('\n') || 'none' : 'none'}`,
  ].filter(Boolean).join('\n');
}

// Read-only compatibility for replies saved before alias diagnostics were parsed.
// Never reinterpret new display bodies, user examples, or replay chat actions.
function displayChatMessage(message: ChatMessageRow): ChatMessageRow {
  const metadata = message.metadata;
  if (message.authorType !== 'agent' || !metadata || typeof metadata !== 'object'
    || !('adapterType' in metadata) || metadata.adapterType !== 'a2a'
    || ('chatDisplayVersion' in metadata && metadata.chatDisplayVersion != null)) return message;
  const body = projectModelWarningChat(message.body);
  return body === null ? message : { ...message, body };
}

function formatChatHistoryForPrompt(history: ChatMessageRow[], budgetChars?: number): string {
  const lines = history.map((message) => {
    const author = message.authorType === 'agent' ? 'agent' : message.authorType === 'system' ? 'system' : 'user';
    return `[${author}] ${displayChatMessage(message).body}`;
  });
  if (!budgetChars || lines.join('\n\n').length <= budgetChars) return lines.join('\n\n');

  const selected: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const nextSize = size + line.length + (selected.length ? 2 : 0);
    if (nextSize > budgetChars) break;
    selected.unshift(line);
    size = nextSize;
  }
  return [
    `[system] Earlier Direct Chat messages were omitted to keep this continuation under ${budgetChars} characters. The remaining transcript is the most recent context and is authoritative.`,
    ...selected,
  ].join('\n\n');
}

// Continuation turns deliberately skip the full Kanban snapshot — the adapter
// session already carries it. But a chat reply can now ask MegaCorps to update
// a card by id, so a continuation still needs a current index of what those
// ids are; without it the agent can only ever create new cards.
async function buildChatCardIndex(companyId: string, projectId: string | null): Promise<string> {
  const rows = await db.select({ id: kanbanCards.id, title: kanbanCards.title, status: kanbanCards.columnStatus })
    .from(kanbanCards)
    .where(and(
      eq(kanbanCards.companyId, companyId),
      isNull(kanbanCards.deletedAt),
      projectId ? eq(kanbanCards.projectId, projectId) : isNull(kanbanCards.projectId),
    ))
    .orderBy(desc(kanbanCards.updatedAt))
    .limit(DIRECT_CHAT_CARD_INDEX_LIMIT);
  if (rows.length === 0) return 'Kanban card index: no cards in this scope yet.';
  return [
    'Kanban card index (current, use these ids for update_card):',
    ...rows.map((row) => `- ${row.id} [${row.status ?? 'todo'}] ${row.title.slice(0, 120)}`),
  ].join('\n');
}

export function buildChatPrompt(company: CompanyRow | undefined, agent: AgentRow, history: ChatMessageRow[], kanbanContext: string, goalContext: string, continuation = false, cardIndex = '', refreshedContext = '', digest = ''): string {
  if (continuation) {
    const latest = [...history].reverse().find((message) => message.authorType === 'user') ?? history[history.length - 1];
    return [
      'Continue the existing Direct Chat thread.',
      agentOperationGuide('chat'),
      'Use the recent transcript below as authoritative memory for this chat session. If the user asks what was just said, answer from this transcript.',
      'The company, goal, and Kanban context were already provided in prior turns for this chat session. Do not ask the user to repeat recent messages unless genuinely ambiguous.',
      [
        `Agent name: ${agent.name}`,
        `Adapter: ${agent.adapterType}`,
      ].join('\n'),
      refreshedContext ? `Standing context changed since your last turn in this session. This replaces what you were told before:\n${refreshedContext}` : '',
      digest ? `Your activity elsewhere moved since your last turn in this session (updated digest):\n${digest}` : '',
      cardIndex,
      'Recent conversation transcript:',
      formatChatHistoryForPrompt(history, DIRECT_CHAT_CONTINUATION_HISTORY_CHARS),
      'Latest user message:',
      latest ? latest.body : '',
    ].filter(Boolean).join('\n\n');
  }
  return [
    kanbanContext ? '' : company ? `Company: ${company.name}\nMission: ${company.mission ?? 'No mission configured.'}` : '',
    agentOperationGuide('chat'),
    digest,
    `Goal context:\n${goalContext}`,
    [
      `Agent name: ${agent.name}`,
      `Adapter: ${agent.adapterType}`,
    ].join('\n'),
    `Kanban context snapshot:\n${kanbanContext}`,
    'Conversation history:',
    formatChatHistoryForPrompt(history),
  ].filter(Boolean).join('\n\n');
}

function supportsScopedDirectChatAdapterSession(adapterType?: string | null): boolean {
  return adapterType === 'codex-app' || adapterType === 'hermes-ssh';
}

async function addChatActivity(input: {
  companyId: string;
  agentId: string;
  userId?: string | null;
  action: string;
  sessionId: string;
  details?: Record<string, unknown>;
}) {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.userId ? 'user' : 'system',
    actorId: input.userId ?? 'system',
    userId: input.userId ?? null,
    agentId: input.agentId,
    action: input.action,
    entityType: 'chat_session',
    entityId: input.sessionId,
    details: input.details ?? {},
  });
}


async function chatUserStillAuthorized(user: AuthUser, companyId: string) {
  const [current] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  return Boolean(current && current.status !== 'disabled' && hasCompanyRole(await membershipRole(user, companyId), 'operator'));
}

async function performChatReply(session: typeof chatSessions.$inferSelect, agent: AgentRow, company: CompanyRow | undefined, user: AuthUser, userMessage: ChatMessageRow, run: typeof heartbeatRuns.$inferSelect, reply?: FastifyReply, job?: ChatJob, acknowledge?: ChatJobAcknowledger): Promise<unknown> {
  const project = async <T>(action: () => Promise<T>): Promise<T | undefined> => job ? projectChatJob(job, action, acknowledge) : action();
    try {
      publishLiveEvent({
        type: 'chat.reply.started',
        companyId: session.companyId,
        entityType: 'chat_session',
        entityId: session.id,
        sessionId: session.id,
        projectId: session.projectId,
        data: { agentId: agent.id, runId: run.id },
      });
      const adapter = getAdapter(agent.adapterType ?? 'hermes-ssh');
      const adapterSession = supportsScopedDirectChatAdapterSession(agent.adapterType)
        ? await findAdapterSession({
          companyId: session.companyId,
          agentId: agent.id,
          runtimeId: agent.runtimeId,
          adapterType: agent.adapterType,
          scopeType: 'chat',
          scopeId: session.id,
          kind: 'chat',
        })
        : null;
      const existingChatSessionId = adapterSession?.adapterSessionId ?? session.agentSessionId ?? null;
      const handOffContextToAdapter = Boolean(existingChatSessionId);
      const recentLimit = handOffContextToAdapter ? DIRECT_CHAT_CONTINUATION_MESSAGE_LIMIT : DIRECT_CHAT_BOOTSTRAP_MESSAGE_LIMIT;
      const recent = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, session.id)).orderBy(desc(chatMessages.createdAt)).limit(recentLimit);
      const history = recent.reverse();
      const kanbanContext = handOffContextToAdapter ? '' : await buildCompanyKanbanContext(session.companyId, {
        focusAgentId: agent.id,
        projectId: session.projectId ?? null,
        budgetChars: 20_000,
        includeGoals: false,
        includeInvocationPositionPrompt: false,
      });
      // Standing context is built on every turn but injected only when it is
      // new to this session: once at bootstrap, and again whenever the company
      // mission, goals, project config, or position prompt actually change.
      // The Kanban board snapshot is deliberately not part of the hash — it
      // moves constantly, and the card index below already keeps it current.
      const standingContext = await buildDirectChatGoalContext(session.companyId, agent, session.projectId);
      const standingContextHash = contextHash(standingContext);
      const contextStale = session.bootstrapContextHash !== null && session.bootstrapContextHash !== standingContextHash;
      const goalContext = handOffContextToAdapter ? '' : standingContext;
      const refreshedContext = handOffContextToAdapter && contextStale ? standingContext : '';
      const cardIndex = handOffContextToAdapter ? await buildChatCardIndex(session.companyId, session.projectId ?? null) : '';
      // Cross-surface digest: injected at bootstrap, and again on a
      // continuation only when its hash moved — i.e. when the agent's world
      // outside this chat (cards, reviews, its own notes) actually changed.
      const agentDigest = await buildAgentDigest(agent.id, session.companyId);
      const digestStale = session.digestHash !== null && session.digestHash !== agentDigest.hash;
      const digestForPrompt = handOffContextToAdapter ? (digestStale ? agentDigest.text : '') : agentDigest.text;
      const prompt = buildChatPrompt(company, agent, history, kanbanContext, goalContext, handOffContextToAdapter, cardIndex, refreshedContext, digestForPrompt);
      const contextMode = handOffContextToAdapter
        ? refreshedContext || digestForPrompt ? 'adapter_session_continuation_refresh' : 'adapter_session_continuation'
        : 'full_bootstrap';
      const executionAgent = await buildExecutionAgent(agent, existingChatSessionId);
      const chatTask = { ...(job ? { executionKey: `chat:${userMessage.id}` } : {}), id: `chat-${session.id}`, title: session.title, body: prompt, timeoutSeconds: await readChatTaskTimeoutSeconds(), kind: 'chat' as const };
      await recordPromptLog({
        companyId: session.companyId,
        agentId: agent.id,
        projectId: session.projectId,
        heartbeatRunId: run.id,
        chatSessionId: session.id,
        source: 'chat',
        adapterType: agent.adapterType ?? 'hermes-ssh',
        title: session.title,
        prompt: promptSnapshotForAdapter(executionAgent, chatTask),
        metadata: { adapterSessionId: existingChatSessionId, userMessageId: userMessage.id, megacorpsPromptChars: prompt.length, contextMode, standingContextHash, chatHistoryMessages: history.length },
      });
      // Stream partial output to the requesting user only (targeted live event);
      // throttled so a chatty adapter cannot flood the socket.
      const sanitizeOutput = await companyOutputSanitizer(session.companyId);
      let partialBuffer = '';
      let lastPartialSentAt = 0;
      const PARTIAL_THROTTLE_MS = 700;
      const PARTIAL_MAX_CHARS = 12_000;
      const publishPartial = (chunk: string) => {
        partialBuffer = `${partialBuffer}${chunk}`.slice(-PARTIAL_MAX_CHARS);
        const now = Date.now();
        if (now - lastPartialSentAt < PARTIAL_THROTTLE_MS) return;
        lastPartialSentAt = now;
        publishLiveEvent({
          type: 'chat.reply.partial',
          companyId: session.companyId,
          userId: user.id,
          entityType: 'chat_session',
          entityId: session.id,
          sessionId: session.id,
          projectId: session.projectId,
          data: { agentId: agent.id, runId: run.id, text: stripHermesSessionMetadata(sanitizeOutput.partial(partialBuffer)) },
        });
      };
      const usageScope = { companyId: session.companyId, agentId: agent.id, projectId: session.projectId, heartbeatRunId: run.id, runtimeId: agent.runtimeId, attemptKey: attemptKey({ heartbeatRunId: run.id }), source: 'chat' };
      const [priorUsage] = job ? await db.select().from(costEvents).where(eq(costEvents.attemptKey, usageScope.attemptKey)).limit(1) : [];
      const dispatch = () => adapter.dispatch(executionAgent, chatTask, { onOutput: publishPartial });
      const result = sanitizeOutput(priorUsage ? await (async () => {
        const resumed = await withUsageAttempt(usageScope.attemptKey, dispatch);
        const settled = await settleUsage(scopeFromEntry(priorUsage), resultUsage(resumed));
        return { ...resumed, usage: settled.entry.usage ?? resultUsage(resumed), costUsd: Number(settled.entry.costUsd ?? 0) };
      })() : await executeUsage(usageScope, dispatch, { timeoutSeconds: chatTask.timeoutSeconds }));
      if (!result.success) throw new Error(result.output || 'agent_chat_failed');
      return await project(async () => {
      if (supportsScopedDirectChatAdapterSession(agent.adapterType)) {
        await rememberAdapterSession({
          companyId: session.companyId,
          agentId: agent.id,
          runtimeId: agent.runtimeId,
          adapterType: agent.adapterType ?? 'hermes-ssh',
          scopeType: 'chat',
          scopeId: session.id,
          kind: 'chat',
          adapterSessionId: result.sessionId,
          lastTurnId: result.turnId ?? null,
          metadata: { heartbeatRunId: run.id },
        });
      }

      const overBudget = (await usageBudgetState(agent)).blocked;
      const monthlyExceeded = overBudget;
      const taskExceeded = false;
      if (!job) await db.update(agents).set({
        isBusy: false,
      }).where(eq(agents.id, agent.id));
      if (!job) await db.update(heartbeatRuns).set({
        status: 'success',
        completedAt: new Date(),
        durationSeconds: result.durationSeconds,
        outputTokens: result.tokensUsed,
        costUsd: result.costUsd.toString(),
      }).where(eq(heartbeatRuns.id, run.id));
      const [agentMessage] = await db.insert(chatMessages).values({
        ...(job ? { id: job.responseMessageId } : {}),
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        authorType: 'agent',
        body: result.output,
        metadata: { runId: run.id, adapterType: agent.adapterType, chatDisplayVersion: 1, sessionId: result.sessionId, tokensUsed: result.tokensUsed, overBudget, ...(job && extractChatWorkItems(result.output) ? { chatActionsPending: true } : {}) },
        costUsd: result.costUsd.toString(),
        durationSeconds: result.durationSeconds,
      }).returning();
      const [updatedSession] = await db.update(chatSessions).set({
        agentSessionId: result.sessionId,
        // Only record the hashes once the turn actually reached the agent, so
        // a failed run does not mark stale context as delivered.
        bootstrapContextHash: standingContextHash,
        digestHash: agentDigest.hash,
        updatedAt: new Date(),
      }).where(eq(chatSessions.id, session.id)).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: overBudget ? 'chat.budget_hard_stop' : 'chat.reply_received', sessionId: session.id, details: { runId: run.id, costUsd: result.costUsd, overBudget, monthlyExceeded, taskExceeded } });
      if (agentMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: agentMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'agent', agentId: session.agentId, runId: run.id } });

      // The agent cannot reach the board itself from a chat turn, so a
      // megacorps-chat-actions block in its reply is applied here on the
      // chatting user's authority. Failures are reported back into the thread
      // rather than thrown: the reply itself is already saved and valid.
      const workItems = extractChatWorkItems(result.output);
      let workItemMessage: ChatMessageRow | undefined;
      if (workItems) {
        const body = 'error' in workItems
          ? `The agent proposed Kanban updates but the block could not be read: ${workItems.error}`
          : !await chatUserStillAuthorized(user, session.companyId)
            ? 'Kanban updates were not applied because your company operator access was revoked.'
          : formatChatWorkItemOutcomes(await applyChatWorkItems({
            companyId: session.companyId,
            projectId: session.projectId ?? null,
            chatSessionId: session.id,
            user,
            agentId: agent.id,
            agentName: agent.name,
          }, workItems.actions));
        [workItemMessage] = await db.insert(chatMessages).values({
          sessionId: session.id,
          companyId: session.companyId,
          agentId: session.agentId,
          userId: user.id,
          authorType: 'system',
          body,
          metadata: { runId: run.id, chatActions: true },
        }).returning();
        if (workItemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: workItemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, runId: run.id } });
      }

      if (job && agentMessage) await db.update(chatMessages).set({ metadata: { ...(agentMessage.metadata as Record<string, unknown>), chatActionsPending: false } }).where(eq(chatMessages.id, agentMessage.id));
      publishLiveEvent({ type: 'chat.reply.finished', companyId: session.companyId, entityType: 'chat_session', entityId: session.id, sessionId: session.id, projectId: session.projectId, data: { agentId: agent.id, runId: run.id, status: 'success' } });
      return { session: updatedSession, userMessage, agentMessage, ...(workItemMessage ? { workItemMessage } : {}) };
      });
    } catch (error) {
      return project(async () => {
      const message = await sanitizeCompanyOutput(session.companyId, error instanceof Error ? error.message : 'agent_chat_failed');
      if (!job) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
      if (!job) await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: message }).where(eq(heartbeatRuns.id, run.id));
      const [systemMessage] = await db.insert(chatMessages).values({
        ...(job ? { id: job.responseMessageId } : {}),
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `Agent chat failed: ${message}`,
        metadata: { runId: run.id, error: message },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.failed', sessionId: session.id, details: { runId: run.id, error: message } });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, runId: run.id, error: message } });
      publishLiveEvent({ type: 'chat.reply.finished', companyId: session.companyId, entityType: 'chat_session', entityId: session.id, sessionId: session.id, projectId: session.projectId, data: { agentId: agent.id, runId: run.id, status: 'failed', error: message } });
      const failure = { error: message, userMessage, systemMessage };
      return reply ? reply.code(502).send(failure) : failure;
      });
    }
}

export async function registerChatRoutes(app: FastifyInstance, options: { acknowledgeExecution?: ChatJobAcknowledger } = {}): Promise<void> {
  const acknowledge: ChatJobAcknowledger = options.acknowledgeExecution ?? (async (key, tx) => (await import('./a2a-executions.ts')).acknowledgeA2aExecution(key, tx));
  const worker = createChatJobWorker(async job => {
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, job.sessionId)).limit(1);
    const [agent] = await db.select().from(agents).where(eq(agents.id, job.agentId)).limit(1);
    const [company] = await db.select().from(companies).where(eq(companies.id, job.companyId)).limit(1);
    const [userRow] = await db.select().from(users).where(eq(users.id, job.userId)).limit(1);
    const [userMessage] = await db.select().from(chatMessages).where(eq(chatMessages.id, job.userMessageId)).limit(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, job.heartbeatRunId)).limit(1);
    if (!session || !agent || !userMessage || !run) throw new Error('chat_job_identity_missing');
    const [existingReply] = await db.select().from(chatMessages).where(eq(chatMessages.id, job.responseMessageId)).limit(1);
    if (existingReply) {
      const metadata = existingReply.metadata as Record<string, unknown> | null;
      // A process may exit after saving a reply but before marking the job done.
      // Never dispatch again or replay chat actions in that window.
      await projectChatJob(job, async () => {
        if (metadata?.chatActionsPending) await db.insert(chatMessages).values({ id: job.id, sessionId: job.sessionId, companyId: job.companyId, agentId: job.agentId, userId: job.userId, authorType: 'system', body: 'This reply was recovered after an interruption. Its proposed Kanban updates may be incomplete. Review the board before requesting further changes; the updates were not replayed.', metadata: { error: 'chat_actions_recovery_required', runId: run.id } }).onConflictDoNothing();
        if (typeof metadata?.sessionId === 'string') await db.update(chatSessions).set({ agentSessionId: metadata.sessionId, updatedAt: new Date() }).where(eq(chatSessions.id, session.id));
      }, acknowledge);
    } else if (!userRow || !await chatUserStillAuthorized({ id: userRow.id, email: userRow.email, role: userRow.role ?? 'viewer' }, session.companyId) || agent.deletedAt || agent.isActive === false || agent.adapterType !== 'a2a') {
      await projectChatJob(job, async () => {
        await db.insert(chatMessages).values({ id: job.responseMessageId, sessionId: job.sessionId, companyId: job.companyId, agentId: job.agentId, userId: job.userId, authorType: 'system', body: 'Agent chat stopped: operator access or agent availability changed.', metadata: { error: 'chat_authority_changed', runId: run.id } });
      }, acknowledge);
    } else {
      await performChatReply(session, agent, company, { id: userRow.id, email: userRow.email, role: userRow.role ?? 'viewer' }, userMessage, run, undefined, job, acknowledge);
    }
  }, error => app.log.error({ err: error }, 'Chat job worker failed; durable lease will permit recovery'));
  app.addHook('onReady', async () => { worker.wake(); });
  app.addHook('onClose', async () => { worker.stop(); });

  const readChatJobs = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.string().uuid(), jobId: z.string().uuid().optional() }).parse(request.params);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, params.id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    if (!await requireCompanyRole(request, reply, session.companyId, 'viewer')) return reply;
    const rows = await db.select().from(chatJobs).where(and(eq(chatJobs.sessionId, session.id), params.jobId ? eq(chatJobs.id, params.jobId) : undefined)).orderBy(desc(chatJobs.createdAt)).limit(params.jobId ? 1 : 20);
    if (params.jobId) return rows[0] ? publicChatJob(rows[0]) : reply.code(404).send({ error: 'chat_job_not_found' });
    return rows.map(publicChatJob);
  };
  app.get('/api/chat/sessions/:id/jobs', readChatJobs);
  app.get('/api/chat/sessions/:id/jobs/:jobId', readChatJobs);
  app.get('/api/chat/sessions', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = z.object({ companyId: optionalReadId, agentId: optionalReadId, projectId: optionalReadProject, limit: readLimit(100, 300) }).parse(request.query);
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(chatSessions.companyId, query.companyId) : inArray(chatSessions.companyId, access.companyIds),
      query.agentId ? eq(chatSessions.agentId, query.agentId) : undefined,
      query.projectId === 'none' ? isNull(chatSessions.projectId) : query.projectId ? eq(chatSessions.projectId, query.projectId) : undefined,
    ].filter(Boolean);
    return db.select().from(chatSessions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(query.limit);
  });

  app.post('/api/chat/sessions', async (request, reply) => {
    const input = createChatSessionSchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    if (agent.companyId !== input.companyId) return reply.code(400).send({ error: 'agent_company_mismatch' });
    if (input.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId), isNull(projects.deletedAt))).limit(1);
      if (!project) return reply.code(400).send({ error: 'project_company_mismatch' });
    }
    const [session] = await db.insert(chatSessions).values({
      companyId: input.companyId,
      agentId: input.agentId,
      projectId: input.projectId ?? null,
      userId: user.id,
      title: input.title ?? `Chat with ${agent.name}`,
    }).returning();
    if (!session) return reply.code(500).send({ error: 'chat_session_create_failed' });
    await addChatActivity({ companyId: session.companyId, agentId: session.agentId, userId: user.id, action: 'chat.session_created', sessionId: session.id, details: { title: session.title } });
    return reply.code(201).send(session);
  });

  app.get('/api/chat/sessions/:id/messages', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const query = z.object({ limit: readLimit(200, 500) }).parse(request.query);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const user = await requireCompanyRole(request, reply, session.companyId, 'viewer'); if (!user) return reply;
    const rows = await db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(query.limit);
    return rows.reverse().map(displayChatMessage);
  });

  app.post('/api/chat/sessions/:id/messages', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createChatMessageSchema.parse(request.body);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    if (!session) return reply.code(404).send({ error: 'chat_session_not_found' });
    const user = await requireCompanyRole(request, reply, session.companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, session.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const [company] = await db.select().from(companies).where(eq(companies.id, session.companyId)).limit(1);

    if (agent.adapterType === 'a2a') {
      if (agent.isActive === false) return reply.code(409).send({ error: 'agent_paused' });
      if (!await budgetOk(agent)) return reply.code(409).send({ error: 'agent_budget_exceeded' });
      const admitted = await enqueueChatJob(session, user.id, input.body);
      if ('error' in admitted) return reply.code(409).send(admitted);
      publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: admitted.userMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'user', agentId: session.agentId } });
      worker.wake();
      return reply.code(202).send(admitted);
    }

    const now = new Date();
    const [userMessage] = await db.insert(chatMessages).values({
      sessionId: session.id,
      companyId: session.companyId,
      agentId: session.agentId,
      userId: user.id,
      authorType: 'user',
      body: input.body,
      metadata: {},
    }).returning();
    if (!userMessage) return reply.code(500).send({ error: 'chat_message_create_failed' });
    publishLiveEvent({
      type: 'chat.message.created',
      companyId: session.companyId,
      entityType: 'chat_message',
      entityId: userMessage.id,
      sessionId: session.id,
      projectId: session.projectId,
      data: { authorType: 'user', agentId: session.agentId },
    });

    await db.update(chatSessions).set({
      title: session.title.startsWith('Chat with ') ? titleFromMessage(input.body, agent.name) : session.title,
      updatedAt: now,
    }).where(eq(chatSessions.id, session.id));

    if (agent.isActive === false) {
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is paused. Resume the agent before starting a direct chat run.`,
        metadata: { error: 'agent_paused' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.agent_paused', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_paused' } });
      return reply.code(409).send({ error: 'agent_paused', userMessage, systemMessage });
    }

    if (!(await budgetOk(agent))) {
      await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, agent.id));
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is over budget and was paused before starting a direct chat run.`,
        metadata: { error: 'agent_budget_exceeded' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.budget_blocked', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_budget_exceeded' } });
      return reply.code(409).send({ error: 'agent_budget_exceeded', userMessage, systemMessage });
    }

    const busyAgent = await claimAgentCapacity(agent);
    if (!busyAgent) {
      const [systemMessage] = await db.insert(chatMessages).values({
        sessionId: session.id,
        companyId: session.companyId,
        agentId: session.agentId,
        userId: user.id,
        authorType: 'system',
        body: `${agent.name} is busy. Try this session again after the current run finishes.`,
        metadata: { error: 'agent_busy' },
      }).returning();
      await addChatActivity({ companyId: session.companyId, agentId: agent.id, userId: user.id, action: 'chat.agent_busy', sessionId: session.id });
      if (systemMessage) publishLiveEvent({ type: 'chat.message.created', companyId: session.companyId, entityType: 'chat_message', entityId: systemMessage.id, sessionId: session.id, projectId: session.projectId, data: { authorType: 'system', agentId: session.agentId, error: 'agent_busy' } });
      return reply.code(409).send({ error: 'agent_busy', userMessage, systemMessage });
    }

    const [run] = await db.insert(heartbeatRuns).values({
      companyId: session.companyId,
      agentId: agent.id,
      source: 'chat',
      status: 'running',
      startedAt: now,
    }).returning();
    if (!run) {
      await db.update(agents).set({ isBusy: false }).where(eq(agents.id, agent.id));
      return reply.code(500).send({ error: 'heartbeat_run_create_failed' });
    }

    return performChatReply(session, agent, company, user, userMessage, run, reply);
  });
}

export const chatInternals = {
  buildChatPrompt,
  formatChatHistoryForPrompt,
};
