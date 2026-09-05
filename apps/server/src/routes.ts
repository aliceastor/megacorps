import { registerCompanySetupRoutes, setupConnectionFingerprint, recordSetupConnectionCheck } from './company-setup.ts';
import { registerCompanyRetirementRoutes } from './company-retirement.ts';
import { companyDeletionInventory, deletionBlockers, lockCompanyInventory } from './company-inventory.ts';
import { structuralCompletionIssue, companyExecutionReadiness, structuralReviewer } from './company-workflow.ts';
import { workerRepositoryReadiness } from './worker-readiness.ts';
import { sealDeliveryAcceptance } from './delivery-acceptance.ts';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNull, lte, ne, or, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { acceptInviteSchema, updateBudgetPolicySchema, updateCompanySchema, updatePositionSchema, updateAgentRuntimeSchema, updateProjectSchema, updateKnowledgeDocSchema, adminUpdateSettingsSchema, adminUpdateUserSchema, approvalDecisionSchema, cardStatuses, createAgentRuntimeSchema, createAgentSchema, createBudgetPolicySchema, createCardCommentSchema, createCardSchema, createCompanyMembershipSchema, createCompanySchema, createDepartmentSchema, createGoalSchema, createInviteSchema, createKnowledgeDocSchema, createPositionSchema, createProjectSchema, createWorkProductSchema, inferCardTransitionAction, loginSchema, normalizeCardStatus, signupSchema, updateAgentSchema, updateCardSchema, updateCompanyMembershipSchema, updateDepartmentSchema, validateCardTransition } from '@megacorps/shared';
import { assertSessionSecretReady, signSession, requireAuth, requireRole } from './auth.ts';
import { requireAnyVisibleCompany, requireCompanyRole, requireVisibleCompany, resolveMutationCompany } from './access.ts';
import { db, sql } from './db/client.ts';
import { activityLog, adapterSessions, agentReviewScores, agentRuntimes, agents, apiEvents, appSettings, approvals, budgetPolicies, cardComments, chatMessages, chatSessions, companies, companyMemberships, costEvents, departments, externalWaits, goals, heartbeatRuns, kanbanCards, knowledgeDocs, positions, projects, projectWorkspaceFiles, promptLogs, taskLogs, taskRuns, userInvites, users, workProducts } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import { activeDirectReportsForAgent, buildExecutionAgent, cascadeParentStatus, collaborationDelegationInstructions, collaborationDelegationRequirement, collaborationModeRequiresDelegation, completeMessageTaskRunFromWebhook, completeTaskRun, completionBlockedByChildren, completionStatusForQualityGate, createMessageDelegations, createPendingApproval, delegationItems, enqueueMessageTaskRun, enqueueTaskRun, ensureParentWaitingOnChildren, getTaskLogs, gitRemoteMatchesProjectRepo, isGuidanceEscalation, optionalDelegationInstructions, peerMentionsFromOutput, performWebhookHandoff, processChildSplits, processPeerMentions, processMentionQuestions, processReportNotes, reportNotesFromOutput, childrenFromOutput, answerClientCheckpoint, finishRunWaitingOnClient, resolveClientCheckpointRequest, finishRunWaitingOnBrainstorm, resolveBrainstormRequest, recordReviewScore, webhookCompletionDecision } from './dispatch.ts';
import { afterAuthorFix, completePanelReviewFromWebhook, ensureHumanGate, hasOpenReviewRound, listReviewRounds, openFixRound, openPanelRound, panelRequiredForCard } from './review-rounds.ts';
import { dispositionErrors, formatDispositionRules } from './review-panel.ts';
import { applyMergeGatePlan, handleGiteaWebhookEvent, mergeCompletionStatus, planMergeGate } from './merge-gate.ts';
import { openExternalWait } from './external-events.ts';
import { brainstormFromOutput } from './brainstorm.ts';
import { CLIENT_CHECKPOINT_APPROVAL_TYPE, checkpointFromOutput } from './client-checkpoints.ts';
import { registerChatRoutes } from './chat.ts';
import { runAgentMaintenance } from './agent-maintenance.ts';
import { delegationLineFromReportItem } from './agent-report.ts';
import { agentResultExecutionLog, normalizeAgentResult, persistAgentWorkProducts } from './agent-results.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';
import { sendAgentFeedbackAndRequeue } from './dispatch.ts';
import { finishProtocolHelp, protocolHelpOrigin, resetProtocolRepair } from './protocol-repair.ts';
import { completionCondition, guardedCompletionUpdate } from './completion-guard.ts';
import { inspectManagedProject, optInManagedBinding } from './managed-project-policy.ts';
import { mergeIntents } from './db/schema.ts';
import { parseA2aPushPayload, verifyA2aPushSignature } from './a2a-client.ts';
import { registerCronRoutes } from './cron-routes.ts';
import { registerLifecycleRoutes } from './lifecycle-routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { registerTrashRoutes } from './trash-routes.ts';
import { authenticateAgentToken, decideGiteaProvisionAuth, looksLikeAgentToken, previewAgentToken, revokeAgentToken, rotateAgentToken } from './agent-auth.ts';
import { addGiteaCollaborator, ensureGiteaAgentAccount, ensureGiteaOrg, ensureGiteaRepo, ensureGiteaRepoWebhook, ensureGiteaWebhookToken, giteaConfigFromEnv, giteaWebhookCallbackUrl } from './gitea.ts';
import { apiHelpCatalog, apiHelpMarkdown } from './api-help.ts';
import { CEO_POSITION_PROMPT, POSITION_TEMPLATES } from './role-playbooks.ts';
import { configuredWebhookSharedSecret } from './webhook-secret.ts';
import { publishLiveEvent } from './live.ts';
import { resetAdapterSessionsForAgent } from './adapter-sessions.ts';
import { encodeLogCursor, LogQueryError, parseLogListQuery, type LogCursor } from './log-query.ts';
import { getCardActions, recordCardAction, recordStageAction } from './card-actions.ts';
import { hydrateCardDependencyState, setCardDependencies } from './card-dependencies.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';
import { listNotifications, markAllNotificationsRead, markNotificationRead, notify, unreadNotificationCount } from './notifications.ts';
import { notifications } from './db/schema.ts';
import { API_TOKEN_HASH_SETTING, readApiTokenSettings, revokeApiToken, rotateApiToken } from './api-token.ts';
import { CHAT_TASK_TIMEOUT_SETTING, KANBAN_TASK_TIMEOUT_SETTING, readChatTaskTimeoutSeconds, readKanbanTaskTimeoutSeconds, setChatTaskTimeoutSeconds, setKanbanTaskTimeoutSeconds } from './runtime-settings.ts';


function priorityToNumber(priority: string | undefined): number { return priority === 'urgent' ? 3 : priority === 'high' ? 2 : priority === 'low' ? -1 : 0; }
function actorLabel(user: { email?: string; id?: string } | null): string { return user?.email ?? user?.id ?? 'system'; }
function compactText(value: string | null | undefined): string { return (value ?? '').replace(/\s+/g, ' ').trim(); }
function timestampsNear(a: Date | string | null | undefined, b: Date | string | null | undefined, windowMs = 5 * 60 * 1000): boolean {
  if (!a || !b) return true;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= windowMs;
}

function hydrateReviewCommentAuthors(
  card: typeof kanbanCards.$inferSelect,
  comments: Array<typeof cardComments.$inferSelect>,
  reviewRuns: Array<Pick<typeof taskRuns.$inferSelect, 'agentId' | 'output' | 'completedAt'>>,
) {
  if (!card.assigneeId || reviewRuns.length === 0) return comments;
  return comments.map((comment) => {
    if (comment.agentId !== card.assigneeId) return comment;
    const body = compactText(comment.body);
    if (!body) return comment;
    const match = reviewRuns.find((run) => run.agentId && run.agentId !== comment.agentId && compactText(run.output) === body && timestampsNear(comment.createdAt, run.completedAt));
    return match?.agentId ? { ...comment, agentId: match.agentId, authorType: 'agent', action: 'review_note' } : comment;
  });
}

const ACTIVE_DELEGATION_STATUSES = new Set(['queued', 'running', 'waiting', 'submitted']);
const PROCESS_DELEGATION_STATUSES = new Set(['queued', 'running', 'waiting']);

function normalizedReviewerId(assigneeId: string | null | undefined, reviewerId: string | null | undefined): string | null {
  if (!reviewerId) return null;
  return reviewerId === assigneeId ? null : reviewerId;
}

async function resolveIndependentReviewerForCard(card: typeof kanbanCards.$inferSelect, actorAgentId?: string | null): Promise<string | null> {
  if (card.reviewerId && card.reviewerId !== card.assigneeId && card.reviewerId !== actorAgentId) return card.reviewerId;
  if (!card.assigneeId) return null;
  const [assignee] = await db.select({ bossId: agents.bossId }).from(agents).where(and(eq(agents.id, card.assigneeId), isNull(agents.deletedAt))).limit(1);
  if (assignee?.bossId && assignee.bossId !== card.assigneeId && assignee.bossId !== actorAgentId) return assignee.bossId;
  return null;
}

async function hydrateCardWorkflowActors<T extends { id: string; columnStatus?: string | null; assigneeId?: string | null; reviewerId?: string | null }>(cards: T[]): Promise<Array<T & { workflowProcessAgentId: string | null; workflowReviewAgentId: string | null }>> {
  if (cards.length === 0) return [];
  const cardIds = cards.map((card) => card.id);
  const rows = await db.select({
    cardId: cardComments.cardId,
    assigneeAgentId: cardComments.assigneeAgentId,
    reviewerAgentId: cardComments.reviewerAgentId,
    reviewerScope: cardComments.reviewerScope,
    delegationStatus: cardComments.delegationStatus,
    createdAt: cardComments.createdAt,
  }).from(cardComments).where(and(
    inArray(cardComments.cardId, cardIds),
    drizzleSql`${cardComments.delegationStatus} IS NOT NULL`,
  )).orderBy(desc(cardComments.createdAt)).limit(Math.max(500, cardIds.length * 20));
  const rowsByCard = new Map<string, typeof rows>();
  for (const row of rows) {
    const current = rowsByCard.get(row.cardId) ?? [];
    current.push(row);
    rowsByCard.set(row.cardId, current);
  }
  return cards.map((card) => {
    const cardRows = rowsByCard.get(card.id) ?? [];
    const activeRows = cardRows.filter((row) => row.delegationStatus && ACTIVE_DELEGATION_STATUSES.has(row.delegationStatus));
    const reviewRow = activeRows.find((row) => row.delegationStatus === 'submitted' && row.reviewerAgentId)
      ?? activeRows.find((row) => row.reviewerScope === 'final' && row.reviewerAgentId)
      ?? activeRows.find((row) => row.reviewerAgentId);
    const processRow = activeRows.find((row) => row.delegationStatus && PROCESS_DELEGATION_STATUSES.has(row.delegationStatus) && row.assigneeAgentId)
      ?? activeRows.find((row) => row.assigneeAgentId);
    const status = normalizeCardStatus(card.columnStatus) ?? 'todo';
    const workflowReviewAgentId = reviewRow?.reviewerAgentId ?? (['in_review', 'needs_review'].includes(status) ? card.reviewerId ?? null : null);
    const workflowProcessAgentId = processRow?.assigneeAgentId ?? (!workflowReviewAgentId && ['todo', 'in_progress', 'waiting_on_external'].includes(status) ? card.assigneeId ?? null : null);
    return { ...card, workflowProcessAgentId, workflowReviewAgentId };
  });
}

function webhookRunStatus(status: string): 'success' | 'failed' | 'cancelled' {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'failed';
  return 'success';
}

const REDACTED = '[redacted]';
const SENSITIVE_CONFIG_KEY = /(password|pass|token|secret|jwt|apiKey|privateKey)/i;
const SIGNUP_ENABLED_SETTING = 'auth.signup_enabled';

const bootstrapSchema = signupSchema.extend({
  token: z.string().optional(),
});
const signupRequestSchema = signupSchema.extend({
  bootstrapToken: z.string().optional(),
  token: z.string().optional(),
});

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isLocalWebOrigin(): boolean {
  const origin = process.env.WEB_ORIGIN ?? '';
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
}

function sessionCookieSecure(): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return truthy(process.env.COOKIE_SECURE);
  return process.env.NODE_ENV === 'production' && !isLocalWebOrigin();
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', path: '/', secure: sessionCookieSecure() });
}

function bearerFromRequest(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim() || null;
}

function safeSecretEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function bootstrapToken(): string | undefined {
  return configuredString(process.env.BOOTSTRAP_TOKEN);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function webUrl(path: string): string | null {
  const origin = process.env.WEB_ORIGIN;
  if (!origin) return null;
  return `${origin.replace(/\/$/, '')}${path}`;
}

async function settingValue(key: string, fallback: string): Promise<string> {
  await db.insert(appSettings).values({ key, value: fallback }).onConflictDoNothing();
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.value ?? fallback;
}

async function setSettingValue(key: string, value: string): Promise<void> {
  await db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

async function signupEnabled(): Promise<boolean> {
  return truthy(await settingValue(SIGNUP_ENABLED_SETTING, 'true'));
}

async function adminSettingsResponse(apiToken?: string) {
  const tokenSettings = await readApiTokenSettings();
  return {
    signupEnabled: await signupEnabled(),
    kanbanTaskTimeoutSeconds: await readKanbanTaskTimeoutSeconds(),
    chatTaskTimeoutSeconds: await readChatTaskTimeoutSeconds(),
    apiTokenConfigured: tokenSettings.configured,
    apiTokenPreview: tokenSettings.preview,
    apiTokenUpdatedAt: tokenSettings.updatedAt,
    apiTokenOwnerUserId: tokenSettings.ownerUserId,
    apiTokenOwnerEmail: tokenSettings.ownerEmail,
    ...(apiToken ? { apiToken } : {}),
  };
}




async function userCount(): Promise<number> {
  const [row] = await db.select({ count: drizzleSql<number>`count(*)::int` }).from(users);
  return Number(row?.count ?? 0);
}

async function hasActiveGlobalAdmin(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active'))).limit(1);
  return Boolean(row);
}

async function hasOtherActiveGlobalAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, userId))).limit(1);
  return Boolean(row);
}

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

function preserveRedactedSecrets(input: unknown, existing: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const previous = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    if (value === REDACTED && Object.prototype.hasOwnProperty.call(previous, key)) return [key, previous[key]];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [key, preserveRedactedSecrets(value, previous[key])];
    return [key, value];
  }));
}

function redactAgent<T extends { adapterConfig?: unknown }>(agent: T): T {
  const record = agent as T & { apiToken?: string | null; giteaToken?: string | null };
  // The raw per-agent token exists only for prompt injection; API responses
  // carry a preview, never the token itself.
  return {
    ...agent,
    adapterConfig: redactSecrets(agent.adapterConfig),
    ...('apiToken' in record ? { apiToken: previewAgentToken(record.apiToken) } : {}),
    ...('giteaToken' in record ? { giteaToken: record.giteaToken ? '[redacted]' : null } : {}),
  } as T;
}

function redactRuntime<T extends { config?: unknown }>(runtime: T): T {
  return { ...runtime, config: redactSecrets(runtime.config) } as T;
}

function redactProject<T extends { publishToken?: string | null }>(project: T): T {
  return { ...project, publishToken: project.publishToken ? '[redacted]' : null };
}

async function cardCompanyId(cardId: string): Promise<string | null> {
  const [card] = await db.select({ companyId: kanbanCards.companyId }).from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  return card?.companyId ?? null;
}

async function agentCompanyId(agentId: string): Promise<string | null> {
  const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
  return agent?.companyId ?? null;
}

async function ensureVisibleCard(request: Parameters<typeof requireVisibleCompany>[0], reply: Parameters<typeof requireVisibleCompany>[1], cardId: string) {
  const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, cardId), isNull(kanbanCards.deletedAt))).limit(1);
  if (!card) {
    await reply.code(404).send({ error: 'card_not_found' });
    return null;
  }
  const user = await requireVisibleCompany(request, reply, card.companyId);
  return user ? card : null;
}

function boundedQueryInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

async function getCardSubtreeRows(card: typeof kanbanCards.$inferSelect, limit: number) {
  return db.execute(drizzleSql`
    WITH RECURSIVE subtree AS (
      SELECT
        c.*,
        1::int AS depth,
        ARRAY[lower(c.title), c.id::text] AS sort_path,
        ARRAY[c.id] AS path_ids
      FROM kanban_cards c
      WHERE c.parent_card_id = ${card.id}::uuid
        AND c.company_id = ${card.companyId}::uuid
        AND c.deleted_at IS NULL

      UNION ALL

      SELECT
        child.*,
        subtree.depth + 1 AS depth,
        subtree.sort_path || ARRAY[lower(child.title), child.id::text] AS sort_path,
        subtree.path_ids || child.id AS path_ids
      FROM kanban_cards child
      JOIN subtree ON child.parent_card_id = subtree.id
      WHERE child.company_id = ${card.companyId}::uuid
        AND child.deleted_at IS NULL
        AND subtree.depth < 32
        AND NOT child.id = ANY(subtree.path_ids)
    ),
    child_counts AS (
      SELECT parent_card_id, count(*)::int AS child_count
      FROM kanban_cards
      WHERE company_id = ${card.companyId}::uuid
        AND deleted_at IS NULL
        AND parent_card_id IS NOT NULL
      GROUP BY parent_card_id
    )
    SELECT
      subtree.id,
      subtree.title,
      subtree.body,
      subtree.column_status AS "columnStatus",
      subtree.priority,
      subtree.tags,
      subtree.company_id AS "companyId",
      subtree.department_id AS "departmentId",
      subtree.project_id AS "projectId",
      subtree.goal_id AS "goalId",
      subtree.parent_card_id AS "parentCardId",
      subtree.assignee_id AS "assigneeId",
      subtree.reviewer_id AS "reviewerId",
      subtree.dependency_card_ids AS "dependencyCardIds",
      subtree.requires_approval AS "requiresApproval",
      subtree.decision_mode AS "decisionMode",
      subtree.rollup_status AS "rollupStatus",
      subtree.required_child_policy AS "requiredChildPolicy",
      subtree.child_requirement_level AS "childRequirementLevel",
      subtree.estimated_weight AS "estimatedWeight",
      subtree.estimated_duration_minutes AS "estimatedDurationMinutes",
      subtree.task_budget_limit AS "taskBudgetLimit",
      subtree.revision_count AS "revisionCount",
      subtree.max_revisions AS "maxRevisions",
      subtree.retry_count AS "retryCount",
      subtree.max_retries AS "maxRetries",
      subtree.timeout_seconds AS "timeoutSeconds",
      subtree.schedule_at AS "scheduleAt",
      subtree.recur_every_minutes AS "recurEveryMinutes",
      subtree.recur_next_at AS "recurNextAt",
      subtree.scheduled_from_card_id AS "scheduledFromCardId",
      subtree.next_run_at AS "nextRunAt",
      subtree.started_at AS "startedAt",
      subtree.completed_at AS "completedAt",
      subtree.last_error AS "lastError",
      subtree.review_feedback AS "reviewFeedback",
      subtree.execution_log AS "executionLog",
      subtree.session_id AS "sessionId",
      subtree.cost_usd AS "costUsd",
      subtree.execution_lock_id AS "executionLockId",
      subtree.active_heartbeat_run_id AS "activeHeartbeatRunId",
      subtree.created_at AS "createdAt",
      subtree.updated_at AS "updatedAt",
      subtree.depth,
      coalesce(child_counts.child_count, 0)::int AS "childCount"
    FROM subtree
    LEFT JOIN child_counts ON child_counts.parent_card_id = subtree.id
    ORDER BY subtree.sort_path
    LIMIT ${limit}
  `);
}

type CompanyReferenceInput = {
  departmentId?: string | null;
  positionId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  bossId?: string | null;
  parentCardId?: string | null;
  dependencyCardIds?: string[];
  runtimeId?: string | null;
  adapterType?: string | null;
};

async function ensureCompanyReferences(companyId: string, input: CompanyReferenceInput) {
  if (input.departmentId) {
    const [row] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.departmentId), eq(departments.companyId, companyId))).limit(1);
    if (!row) throw new Error('department_company_mismatch');
  }
  if (input.positionId) {
    const [row] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.id, input.positionId), eq(positions.companyId, companyId))).limit(1);
    if (!row) throw new Error('position_company_mismatch');
  }
  if (input.projectId) {
    const [row] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))).limit(1);
    if (!row) throw new Error('project_company_mismatch');
  }
  if (input.goalId) {
    const [row] = await db.select({ id: goals.id, departmentId: goals.departmentId, projectId: goals.projectId }).from(goals).where(and(eq(goals.id, input.goalId), eq(goals.companyId, companyId))).limit(1);
    if (!row) throw new Error('goal_company_mismatch');
    if (row.departmentId && input.departmentId !== row.departmentId) throw new Error('goal_department_mismatch');
    if (row.projectId && input.projectId !== row.projectId) throw new Error('goal_project_mismatch');
  }
  for (const [key, id] of [['assignee_company_mismatch', input.assigneeId], ['reviewer_company_mismatch', input.reviewerId], ['boss_company_mismatch', input.bossId]] as const) {
    if (!id) continue;
    const company = await agentCompanyId(id);
    if (company !== companyId) throw new Error(key);
  }
  if (input.parentCardId) {
    const company = await cardCompanyId(input.parentCardId);
    if (company !== companyId) throw new Error('parent_card_company_mismatch');
  }
  if (input.dependencyCardIds?.length) {
    const rows = await db.select({ id: kanbanCards.id }).from(kanbanCards).where(and(inArray(kanbanCards.id, input.dependencyCardIds), eq(kanbanCards.companyId, companyId)));
    if (rows.length !== input.dependencyCardIds.length) throw new Error('dependency_card_company_mismatch');
  }
  if (input.adapterType && adapterRequiresRuntime(input.adapterType) && !input.runtimeId) throw new Error('agent_runtime_required');
  if (input.runtimeId) {
    const [runtime] = await db.select({ companyId: agentRuntimes.companyId, adapterType: agentRuntimes.adapterType }).from(agentRuntimes).where(eq(agentRuntimes.id, input.runtimeId)).limit(1);
    if (!runtime || runtime.companyId !== companyId) throw new Error('runtime_company_mismatch');
    if (input.adapterType && runtime.adapterType !== input.adapterType) throw new Error('runtime_adapter_mismatch');
  }
}

type LogListQuery = ReturnType<typeof parseLogListQuery>;

function parsedLogQuery(request: FastifyRequest, reply: FastifyReply, legacyDefault: number): LogListQuery | null {
  try {
    return parseLogListQuery(request.query as Record<string, string | undefined>, legacyDefault);
  } catch (error) {
    if (error instanceof LogQueryError) {
      reply.code(400).send({ error: error.code, message: error.code === 'invalid_limit' ? 'limit must be a positive integer within the endpoint bound.' : error.code === 'invalid_cursor' ? 'cursor is malformed or is only valid with view=summary.' : 'q must be at most 200 characters.' });
      return null;
    }
    throw error;
  }
}

function logCursorFilter(createdAt: unknown, id: unknown, cursor: LogCursor | null) {
  if (!cursor) return undefined;
  return drizzleSql`(${createdAt as any} < ${cursor.createdAt}::timestamptz OR (${createdAt as any} = ${cursor.createdAt}::timestamptz AND ${id as any} < ${cursor.id}::uuid))`;
}

function logSearchFilter(search: string | null, ...fields: unknown[]) {
  if (!search) return undefined;
  const pattern = `%${search}%`;
  return or(...fields.map((field) => ilike(field as any, pattern)));
}

function summaryPage<T extends { id: string; createdAt?: Date | string | null; cursorCreatedAt?: string | null }, U>(rows: T[], limit: number, project: (row: T) => U) {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const rawTimestamp = last?.cursorCreatedAt ?? (last?.createdAt instanceof Date ? last.createdAt.toISOString() : last?.createdAt ?? null);
  return { items: pageRows.map(project), nextCursor: rows.length > limit && last && rawTimestamp ? encodeLogCursor(rawTimestamp, last.id) : null };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) => {
    try {
      await db.execute(drizzleSql`select 1`);
      return { ok: true, database: 'up' };
    } catch (error) {
      request.log.error({ error }, 'health check database probe failed');
      return reply.code(503).send({ ok: false, database: 'down' });
    }
  });
  await registerCompanySetupRoutes(app);
  registerCompanyRetirementRoutes(app);
  await registerChatRoutes(app);
  await registerCronRoutes(app);
  await registerRunnerRoutes(app);
  await registerLifecycleRoutes(app);
  await registerTrashRoutes(app);
  app.get('/api/help', async (request, reply) => {
    const query = request.query as { format?: string };
    if (query.format === 'markdown' || query.format === 'md') {
      return reply.type('text/markdown; charset=utf-8').send(apiHelpMarkdown());
    }
    return apiHelpCatalog();
  });

  app.get('/api/auth/status', async () => {
    const count = await userCount();
    const hasAdmin = await hasActiveGlobalAdmin();
    return {
      signupEnabled: await signupEnabled(),
      userCount: count,
      firstAccountWillBeAdmin: count === 0,
      nextSignupWillBeAdmin: !hasAdmin,
    };
  });

  app.post('/api/auth/bootstrap', async (request, reply) => {
    await assertSessionSecretReady();
    const expectedToken = bootstrapToken();
    if (!expectedToken) return reply.code(503).send({ error: 'bootstrap_token_not_configured' });
    if (expectedToken.length < 16) return reply.code(503).send({ error: 'bootstrap_token_too_short' });
    const input = bootstrapSchema.parse(request.body);
    const headerToken = request.headers['x-megacorps-bootstrap-token'];
    const providedToken = input.token ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
    if (!safeSecretEqual(providedToken, expectedToken)) return reply.code(401).send({ error: 'bootstrap_auth_required' });

    const passwordHash = await bcrypt.hash(input.password, 12);
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(7042024060602)`);
      const [adminRow] = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active'))).limit(1);
      if (adminRow) return { blocked: true as const };
      const [existingUser] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
      const [user] = existingUser
        ? await tx.update(users).set({ name: input.name, passwordHash, role: 'admin', status: 'active', updatedAt: now }).where(eq(users.id, existingUser.id)).returning()
        : await tx.insert(users).values({ email: input.email, name: input.name, passwordHash, role: 'admin', status: 'active' }).returning();
      if (!user) throw new Error('bootstrap_user_failed');
      const membership = null;
      await tx.insert(activityLog).values({ companyId: null, actorType: 'system', actorId: 'bootstrap', userId: user.id, action: existingUser ? 'auth.bootstrap_admin_promoted' : 'auth.bootstrap_admin_created', entityType: 'user', entityId: user.id, details: { email: user.email } });
      return { blocked: false as const, user, membership };
    });
    if (result.blocked) return reply.code(409).send({ error: 'bootstrap_already_has_admin' });
    const token = await signSession({ id: result.user.id, email: result.user.email, role: 'admin' });
    setSessionCookie(reply, token);
    return { user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role }, membership: result.membership };
  });

  app.post('/api/auth/signup', async (request, reply) => {
    await assertSessionSecretReady();
    const input = signupRequestSchema.parse(request.body);
    const expectedToken = bootstrapToken();
    const headerToken = request.headers['x-megacorps-bootstrap-token'];
    const providedToken = input.bootstrapToken ?? input.token ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
    const bootstrapAllowed = Boolean(expectedToken && expectedToken.length >= 16 && safeSecretEqual(providedToken, expectedToken));
    const signupIsEnabled = await signupEnabled();
    if (!signupIsEnabled && !bootstrapAllowed) return reply.code(403).send({ error: 'signup_disabled' });
    const passwordHash = await bcrypt.hash(input.password, 12);
    const result = await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(7042024060601)`);
      const [countRow] = await tx.select({ count: drizzleSql<number>`count(*)::int` }).from(users);
      const firstAccount = Number(countRow?.count ?? 0) === 0;
      const [adminRow] = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.status, 'active'))).limit(1);
      if (!signupIsEnabled && bootstrapAllowed && adminRow) return { blocked: true as const, firstAccount, nextSignupAdmin: false as const };
      const nextSignupAdmin = !adminRow;
      const role = nextSignupAdmin ? 'admin' : 'viewer';
      const companyRole = nextSignupAdmin ? 'admin' : 'viewer';
      const [created] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash, role, status: 'active' }).returning();
      if (!created) throw new Error('signup_failed');
      const membership = null;
      await tx.insert(activityLog).values({ companyId: null, actorType: 'user', actorId: created.id, userId: created.id, action: nextSignupAdmin ? 'auth.first_admin_signup' : 'auth.signup', entityType: 'user', entityId: created.id, details: { email: created.email, role, companyRole, firstAccount } });
      return { blocked: false as const, user: created, membership, firstAccount, nextSignupAdmin };
    });
    if (result.blocked) return reply.code(409).send({ error: 'bootstrap_already_has_admin', firstAccount: result.firstAccount, nextSignupWillBeAdmin: result.nextSignupAdmin });
    const user = result.user;
    if (!user) return reply.code(500).send({ error: 'signup_failed' });
    const token = await signSession({ id: user.id, email: user.email, role: user.role ?? (result.nextSignupAdmin ? 'admin' : 'viewer') });
    setSessionCookie(reply, token);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, firstAccount: result.firstAccount, nextSignupWillBeAdmin: result.nextSignupAdmin, membership: result.membership };
  });

  app.post('/api/auth/login', async (request, reply) => {
    await assertSessionSecretReady();
    const input = loginSchema.parse(request.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) return reply.code(401).send({ error: 'invalid_credentials' });
    if (user.status === 'disabled') return reply.code(403).send({ error: 'user_disabled' });
    const token = await signSession({ id: user.id, email: user.email, role: user.role ?? 'viewer' });
    setSessionCookie(reply, token);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status } };
  });

  app.post('/api/auth/logout', async (_request, reply) => { reply.clearCookie('session', { path: '/' }); return { ok: true }; });
  app.post('/api/auth/invites', async (request, reply) => {
    const input = createInviteSchema.parse(request.body);
    const actor = await requireCompanyRole(request, reply, input.companyId, 'admin'); if (!actor) return reply;
    const token = generateInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);
    await db.update(userInvites).set({ status: 'superseded', updatedAt: now }).where(and(eq(userInvites.companyId, input.companyId), eq(userInvites.email, input.email), eq(userInvites.status, 'pending')));
    const [invite] = await db.insert(userInvites).values({
      companyId: input.companyId,
      email: input.email,
      name: input.name ?? null,
      role: input.role,
      tokenHash: sha256(token),
      status: 'pending',
      invitedByUserId: actor.id,
      expiresAt,
    }).returning();
    if (!invite) return reply.code(500).send({ error: 'invite_create_failed' });
    await db.insert(activityLog).values({ companyId: input.companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'invite.created', entityType: 'user_invite', entityId: invite.id, details: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt } });
    const acceptPath = `/signup?invite=${encodeURIComponent(token)}`;
    return reply.code(201).send({
      invite: { id: invite.id, companyId: invite.companyId, email: invite.email, name: invite.name, role: invite.role, status: invite.status, expiresAt: invite.expiresAt },
      token,
      acceptUrl: webUrl(acceptPath),
    });
  });

  app.post('/api/auth/accept-invite', async (request, reply) => {
    await assertSessionSecretReady();
    const input = acceptInviteSchema.parse(request.body);
    const [invite] = await db.select().from(userInvites).where(eq(userInvites.tokenHash, sha256(input.token))).limit(1);
    if (!invite) return reply.code(404).send({ error: 'invite_not_found' });
    if (invite.status !== 'pending') return reply.code(409).send({ error: 'invite_not_pending', status: invite.status });
    const now = new Date();
    if (invite.expiresAt && invite.expiresAt < now) {
      await db.update(userInvites).set({ status: 'expired', updatedAt: now }).where(eq(userInvites.id, invite.id));
      return reply.code(410).send({ error: 'invite_expired' });
    }

    const [existingUser] = await db.select().from(users).where(eq(users.email, invite.email)).limit(1);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const nextName = input.name ?? invite.name ?? invite.email.split('@')[0] ?? 'Invited User';
    let shouldSetSession = false;
    const [user] = existingUser
      ? await db.update(users).set({
        name: input.name ?? existingUser.name,
        passwordHash: existingUser.passwordHash ? existingUser.passwordHash : passwordHash,
        updatedAt: now,
      }).where(eq(users.id, existingUser.id)).returning()
      : await db.insert(users).values({ email: invite.email, name: nextName, passwordHash, role: 'viewer' }).returning();
    if (!user) return reply.code(500).send({ error: 'invite_user_failed' });
    shouldSetSession = !existingUser || !existingUser.passwordHash;

    const [membership] = await db.insert(companyMemberships).values({ companyId: invite.companyId, userId: user.id, role: invite.role, status: 'active' }).onConflictDoUpdate({
      target: [companyMemberships.companyId, companyMemberships.userId],
      set: { role: invite.role, status: 'active', updatedAt: now },
    }).returning();
    await db.update(userInvites).set({ status: 'accepted', acceptedByUserId: user.id, acceptedAt: now, updatedAt: now }).where(eq(userInvites.id, invite.id));
    await db.insert(activityLog).values({ companyId: invite.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'invite.accepted', entityType: 'user_invite', entityId: invite.id, details: { email: invite.email, role: invite.role } });
    if (shouldSetSession) {
      const token = await signSession({ id: user.id, email: user.email, role: user.role ?? 'viewer' });
      setSessionCookie(reply, token);
    }
    return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role }, membership, loginRequired: !shouldSetSession };
  });

  app.get('/api/me', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return reply;
    const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.userId, user.id), eq(companyMemberships.status, 'active')));
    return { user, memberships };
  });

  app.get('/api/admin/settings', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    return adminSettingsResponse();
  });

  app.put('/api/admin/settings', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    const input = adminUpdateSettingsSchema.parse(request.body);
    if (input.signupEnabled !== undefined) await setSettingValue(SIGNUP_ENABLED_SETTING, input.signupEnabled ? 'true' : 'false');
    if (input.kanbanTaskTimeoutSeconds !== undefined) await setKanbanTaskTimeoutSeconds(input.kanbanTaskTimeoutSeconds);
    if (input.chatTaskTimeoutSeconds !== undefined) await setChatTaskTimeoutSeconds(input.chatTaskTimeoutSeconds);
    const rotated = input.apiTokenAction === 'rotate' ? await rotateApiToken(user.id) : null;
    if (input.apiTokenAction === 'revoke') await revokeApiToken();
    const companyId = null;
    await db.insert(activityLog).values({
      companyId,
      actorType: 'user',
      actorId: user.id,
      userId: user.id,
      action: 'admin.settings.updated',
      entityType: 'app_settings',
      entityId: input.apiTokenAction ? API_TOKEN_HASH_SETTING : input.kanbanTaskTimeoutSeconds !== undefined ? KANBAN_TASK_TIMEOUT_SETTING : input.chatTaskTimeoutSeconds !== undefined ? CHAT_TASK_TIMEOUT_SETTING : SIGNUP_ENABLED_SETTING,
      details: { signupEnabled: input.signupEnabled, kanbanTaskTimeoutSeconds: input.kanbanTaskTimeoutSeconds, chatTaskTimeoutSeconds: input.chatTaskTimeoutSeconds, apiTokenAction: input.apiTokenAction },
    });
    return adminSettingsResponse(rotated?.token);
  });

  app.get('/api/admin/users', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    const userRows = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      locale: users.locale,
      theme: users.theme,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    }).from(users).orderBy(desc(users.createdAt));
    const membershipRows = await db.select({
      id: companyMemberships.id,
      userId: companyMemberships.userId,
      companyId: companyMemberships.companyId,
      companyName: companies.name,
      role: companyMemberships.role,
      status: companyMemberships.status,
    }).from(companyMemberships)
      .innerJoin(companies, eq(companyMemberships.companyId, companies.id))
      .orderBy(desc(companyMemberships.createdAt));
    return userRows.map((row) => ({
      ...row,
      memberships: membershipRows.filter((membership) => membership.userId === row.id),
    }));
  });

  app.put('/api/admin/users/:id', async (request, reply) => {
    const actor = await requireRole(request, reply, 'admin'); if (!actor) return reply;
    const { id } = request.params as { id: string };
    const input = adminUpdateUserSchema.parse(request.body);
    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'user_not_found' });
    const wouldRemoveAdmin = existing.role === 'admin' && existing.status === 'active' && ((input.role !== undefined && input.role !== 'admin') || input.status === 'disabled');
    if (wouldRemoveAdmin && !await hasOtherActiveGlobalAdmin(id)) return reply.code(409).send({ error: 'last_admin_required' });
    const updates: { name?: string; role?: string; status?: string; passwordHash?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.role !== undefined) updates.role = input.role;
    if (input.status !== undefined) updates.status = input.status;
    if (input.password !== undefined) updates.passwordHash = await bcrypt.hash(input.password, 12);
    const [updated] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    if (!updated) return reply.code(500).send({ error: 'user_update_failed' });
    const companyId = null;
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'admin.user.updated', entityType: 'user', entityId: id, details: { email: updated?.email, role: input.role, status: input.status, passwordReset: input.password !== undefined } });
    return { user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, status: updated.status, createdAt: updated.createdAt, updatedAt: updated.updatedAt } };
  });

  app.get('/api/system-logs', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const query = parsedLogQuery(request, reply, 100); if (!query) return reply;
    const filters = [eq(apiEvents.userId, user.id), logCursorFilter(apiEvents.createdAt, apiEvents.id, query.cursor), logSearchFilter(query.search, apiEvents.method, apiEvents.path, apiEvents.error)].filter(Boolean);
    if (!query.summary) return db.select().from(apiEvents).where(and(...filters)).orderBy(desc(apiEvents.createdAt), desc(apiEvents.id)).limit(query.limit);
    const rows = await db.select({ id: apiEvents.id, method: drizzleSql<string>`left(${apiEvents.method}, 32)`, path: drizzleSql<string>`left(${apiEvents.path}, 1000)`, statusCode: apiEvents.statusCode, error: drizzleSql<string | null>`left(${apiEvents.error}, 500)`, durationMs: apiEvents.durationMs, createdAt: apiEvents.createdAt, cursorCreatedAt: drizzleSql<string>`${apiEvents.createdAt}::text` }).from(apiEvents).where(and(...filters)).orderBy(desc(apiEvents.createdAt), desc(apiEvents.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, ({ cursorCreatedAt: _, ...row }) => row);
  });
  app.get('/api/system-logs/:id', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const [row] = await db.select().from(apiEvents).where(and(eq(apiEvents.id, (request.params as { id: string }).id), eq(apiEvents.userId, user.id))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/prompt-logs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const raw = request.query as { companyId?: string; cardId?: string; agentId?: string; source?: string; surface?: string };
    const query = parsedLogQuery(request, reply, 200); if (!query) return reply;
    if (access.companyIds.length === 0 || (raw.companyId && !access.companyIds.includes(raw.companyId))) return query.summary ? { items: [], nextCursor: null } : [];
    const filters = [
      raw.companyId ? eq(promptLogs.companyId, raw.companyId) : inArray(promptLogs.companyId, access.companyIds),
      raw.cardId ? eq(promptLogs.cardId, raw.cardId) : undefined,
      raw.agentId ? eq(promptLogs.agentId, raw.agentId) : undefined,
      raw.source ? eq(promptLogs.source, raw.source) : undefined,
      raw.surface === 'chat' ? eq(promptLogs.source, 'chat') : raw.surface === 'kanban' ? inArray(promptLogs.source, ['dispatch', 'review', 'message', 'message_review']) : undefined,
      logCursorFilter(promptLogs.createdAt, promptLogs.id, query.cursor),
      logSearchFilter(query.search, promptLogs.title, promptLogs.source, promptLogs.adapterType, promptLogs.prompt, drizzleSql`${promptLogs.agentId}::text`, drizzleSql`${promptLogs.cardId}::text`, drizzleSql`${promptLogs.chatSessionId}::text`),
    ].filter(Boolean);
    if (!query.summary) return db.select().from(promptLogs).where(and(...filters)).orderBy(desc(promptLogs.createdAt), desc(promptLogs.id)).limit(query.limit);
    const rows = await db.select({ id: promptLogs.id, companyId: promptLogs.companyId, agentId: promptLogs.agentId, cardId: promptLogs.cardId, projectId: promptLogs.projectId, goalId: promptLogs.goalId, heartbeatRunId: promptLogs.heartbeatRunId, taskRunId: promptLogs.taskRunId, chatSessionId: promptLogs.chatSessionId, source: promptLogs.source, adapterType: promptLogs.adapterType, title: drizzleSql<string>`left(${promptLogs.title}, 240)`, preview: drizzleSql<string>`left(${promptLogs.prompt}, 240)`, promptHash: promptLogs.promptHash, contextMode: drizzleSql<string | null>`${promptLogs.metadata}->>'contextMode'`, createdAt: promptLogs.createdAt, cursorCreatedAt: drizzleSql<string>`${promptLogs.createdAt}::text` }).from(promptLogs).where(and(...filters)).orderBy(desc(promptLogs.createdAt), desc(promptLogs.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, (row) => { const { cursorCreatedAt: _, metadata, prompt, ...item } = row as typeof row & { metadata?: Record<string, unknown>; prompt?: string }; return { ...item, contextMode: row.contextMode ?? (typeof metadata?.contextMode === 'string' ? metadata.contextMode : null), preview: row.preview ?? prompt?.slice(0, 240) ?? '' }; });
  });
  app.get('/api/prompt-logs/:id', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return reply.code(404).send({ error: 'log_not_found' });
    const [row] = await db.select().from(promptLogs).where(and(eq(promptLogs.id, (request.params as { id: string }).id), inArray(promptLogs.companyId, access.companyIds))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/admin/activity', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    const query = parsedLogQuery(request, reply, 200); if (!query) return reply;
    const filters = [isNull(activityLog.companyId), logCursorFilter(activityLog.createdAt, activityLog.id, query.cursor), logSearchFilter(query.search, activityLog.action, activityLog.entityType, activityLog.entityId, activityLog.actorType, activityLog.actorId, drizzleSql`${activityLog.details}::text`)].filter(Boolean);
    if (!query.summary) return db.select().from(activityLog).where(and(...filters)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(query.limit);
    const rows = await db.select({ id: activityLog.id, companyId: activityLog.companyId, actorType: drizzleSql<string>`left(${activityLog.actorType}, 80)`, actorId: drizzleSql<string>`left(${activityLog.actorId}, 500)`, agentId: activityLog.agentId, userId: activityLog.userId, action: drizzleSql<string>`left(${activityLog.action}, 240)`, entityType: drizzleSql<string>`left(${activityLog.entityType}, 120)`, entityId: drizzleSql<string>`left(${activityLog.entityId}, 500)`, createdAt: activityLog.createdAt, cursorCreatedAt: drizzleSql<string>`${activityLog.createdAt}::text` }).from(activityLog).where(and(...filters)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, ({ cursorCreatedAt: _, ...row }) => row);
  });
  app.get('/api/admin/activity/:id', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    const [row] = await db.select().from(activityLog).where(and(eq(activityLog.id, (request.params as { id: string }).id), isNull(activityLog.companyId))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/activity', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const raw = request.query as { companyId?: string; entityType?: string };
    const query = parsedLogQuery(request, reply, 200); if (!query) return reply;
    if (access.companyIds.length === 0 || (raw.companyId && !access.companyIds.includes(raw.companyId))) return query.summary ? { items: [], nextCursor: null } : [];
    const filters = [
      raw.companyId ? eq(activityLog.companyId, raw.companyId) : inArray(activityLog.companyId, access.companyIds),
      raw.entityType ? eq(activityLog.entityType, raw.entityType) : undefined,
      logCursorFilter(activityLog.createdAt, activityLog.id, query.cursor),
      logSearchFilter(query.search, activityLog.action, activityLog.entityType, activityLog.entityId, activityLog.actorType, activityLog.actorId, drizzleSql`${activityLog.details}::text`),
    ].filter(Boolean);
    if (!query.summary) return db.select().from(activityLog).where(and(...filters)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(query.limit);
    const rows = await db.select({ id: activityLog.id, companyId: activityLog.companyId, actorType: drizzleSql<string>`left(${activityLog.actorType}, 80)`, actorId: drizzleSql<string>`left(${activityLog.actorId}, 500)`, agentId: activityLog.agentId, userId: activityLog.userId, action: drizzleSql<string>`left(${activityLog.action}, 240)`, entityType: drizzleSql<string>`left(${activityLog.entityType}, 120)`, entityId: drizzleSql<string>`left(${activityLog.entityId}, 500)`, createdAt: activityLog.createdAt, cursorCreatedAt: drizzleSql<string>`${activityLog.createdAt}::text` }).from(activityLog).where(and(...filters)).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, ({ cursorCreatedAt: _, ...row }) => row);
  });
  app.get('/api/activity/:id', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return reply.code(404).send({ error: 'log_not_found' });
    const [row] = await db.select().from(activityLog).where(and(eq(activityLog.id, (request.params as { id: string }).id), inArray(activityLog.companyId, access.companyIds))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/heartbeat-runs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const raw = request.query as { companyId?: string; cardId?: string; agentId?: string; status?: string };
    const query = parsedLogQuery(request, reply, 200); if (!query) return reply;
    if (access.companyIds.length === 0 || (raw.companyId && !access.companyIds.includes(raw.companyId))) return query.summary ? { items: [], nextCursor: null } : [];
    const filters = [
      raw.companyId ? eq(heartbeatRuns.companyId, raw.companyId) : inArray(heartbeatRuns.companyId, access.companyIds),
      raw.cardId ? eq(heartbeatRuns.cardId, raw.cardId) : undefined,
      raw.agentId ? eq(heartbeatRuns.agentId, raw.agentId) : undefined,
      raw.status ? eq(heartbeatRuns.status, raw.status) : undefined,
      logCursorFilter(heartbeatRuns.createdAt, heartbeatRuns.id, query.cursor),
      logSearchFilter(query.search, heartbeatRuns.source, heartbeatRuns.status, heartbeatRuns.error, drizzleSql`${heartbeatRuns.cardId}::text`, drizzleSql`${heartbeatRuns.agentId}::text`),
    ].filter(Boolean);
    if (!query.summary) return db.select().from(heartbeatRuns).where(and(...filters)).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(query.limit);
    const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, cardId: heartbeatRuns.cardId, agentId: heartbeatRuns.agentId, source: heartbeatRuns.source, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, completedAt: heartbeatRuns.completedAt, durationSeconds: heartbeatRuns.durationSeconds, error: drizzleSql<string | null>`left(${heartbeatRuns.error}, 500)`, costUsd: heartbeatRuns.costUsd, inputTokens: heartbeatRuns.inputTokens, outputTokens: heartbeatRuns.outputTokens, createdAt: heartbeatRuns.createdAt, cursorCreatedAt: drizzleSql<string>`${heartbeatRuns.createdAt}::text` }).from(heartbeatRuns).where(and(...filters)).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, ({ cursorCreatedAt: _, ...row }) => row);
  });
  app.get('/api/heartbeat-runs/:id', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return reply.code(404).send({ error: 'log_not_found' });
    const [row] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, (request.params as { id: string }).id), inArray(heartbeatRuns.companyId, access.companyIds))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/task-runs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const raw = request.query as { companyId?: string; cardId?: string; agentId?: string; kind?: string; status?: string };
    const query = parsedLogQuery(request, reply, 200); if (!query) return reply;
    if (access.companyIds.length === 0 || (raw.companyId && !access.companyIds.includes(raw.companyId))) return query.summary ? { items: [], nextCursor: null } : [];
    const filters = [
      raw.companyId ? eq(taskRuns.companyId, raw.companyId) : inArray(taskRuns.companyId, access.companyIds),
      raw.cardId ? eq(taskRuns.cardId, raw.cardId) : undefined,
      raw.agentId ? eq(taskRuns.agentId, raw.agentId) : undefined,
      raw.kind ? eq(taskRuns.kind, raw.kind) : undefined,
      raw.status ? eq(taskRuns.status, raw.status) : undefined,
      logCursorFilter(taskRuns.createdAt, taskRuns.id, query.cursor),
      logSearchFilter(query.search, taskRuns.kind, taskRuns.source, taskRuns.status, taskRuns.error, taskRuns.output, drizzleSql`${taskRuns.cardId}::text`, drizzleSql`${taskRuns.agentId}::text`),
    ].filter(Boolean);
    if (!query.summary) return db.select().from(taskRuns).where(and(...filters)).orderBy(desc(taskRuns.createdAt), desc(taskRuns.id)).limit(query.limit);
    const rows = await db.select({ id: taskRuns.id, companyId: taskRuns.companyId, cardId: taskRuns.cardId, agentId: taskRuns.agentId, heartbeatRunId: taskRuns.heartbeatRunId, kind: taskRuns.kind, source: taskRuns.source, status: taskRuns.status, priority: taskRuns.priority, attemptNumber: taskRuns.attemptNumber, maxAttempts: taskRuns.maxAttempts, adapterSessionId: taskRuns.adapterSessionId, adapterTurnId: taskRuns.adapterTurnId, startedAt: taskRuns.startedAt, completedAt: taskRuns.completedAt, durationSeconds: taskRuns.durationSeconds, error: drizzleSql<string | null>`left(${taskRuns.error}, 500)`, preview: drizzleSql<string | null>`left(${taskRuns.output}, 240)`, costUsd: taskRuns.costUsd, createdAt: taskRuns.createdAt, updatedAt: taskRuns.updatedAt, cursorCreatedAt: drizzleSql<string>`${taskRuns.createdAt}::text` }).from(taskRuns).where(and(...filters)).orderBy(desc(taskRuns.createdAt), desc(taskRuns.id)).limit(query.limit + 1);
    return summaryPage(rows, query.limit, ({ cursorCreatedAt: _, ...row }) => row);
  });
  app.get('/api/task-runs/:id', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return reply.code(404).send({ error: 'log_not_found' });
    const [row] = await db.select().from(taskRuns).where(and(eq(taskRuns.id, (request.params as { id: string }).id), inArray(taskRuns.companyId, access.companyIds))).limit(1);
    return row ?? reply.code(404).send({ error: 'log_not_found' });
  });
  app.get('/api/cost-events', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; agentId?: string; cardId?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(costEvents.companyId, query.companyId) : inArray(costEvents.companyId, access.companyIds),
      query.agentId ? eq(costEvents.agentId, query.agentId) : undefined,
      query.cardId ? eq(costEvents.cardId, query.cardId) : undefined,
    ].filter(Boolean);
    return db.select().from(costEvents).where(filters.length ? and(...filters) : undefined).orderBy(desc(costEvents.occurredAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.get('/api/approvals', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; status?: string; cardId?: string; type?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(approvals.companyId, query.companyId) : inArray(approvals.companyId, access.companyIds),
      query.status ? eq(approvals.status, query.status) : undefined,
      query.cardId ? eq(approvals.cardId, query.cardId) : undefined,
      query.type ? eq(approvals.type, query.type) : undefined,
    ].filter(Boolean);
    return db.select().from(approvals).where(filters.length ? and(...filters) : undefined).orderBy(desc(approvals.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.put('/api/approvals/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = approvalDecisionSchema.parse(request.body);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return reply.code(404).send({ error: 'approval_not_found' });
    const user = await requireCompanyRole(request, reply, approval.companyId, 'operator'); if (!user) return reply;
    const [approvalCard] = approval.cardId
      ? await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, approval.cardId), isNull(kanbanCards.deletedAt))).limit(1)
      : [];
    if (approval.type === CLIENT_CHECKPOINT_APPROVAL_TYPE) {
      if (approval.status !== 'pending') return reply.code(409).send({ error: 'checkpoint_not_pending', status: approval.status });
      if (!approvalCard) return reply.code(404).send({ error: 'card_not_found' });
      if (input.status === 'cancelled') {
        const [cancelled] = await db.update(approvals).set({ status: 'cancelled', decisionNote: input.decisionNote ?? null, decidedByUserId: user.id, decidedAt: new Date(), updatedAt: new Date() }).where(eq(approvals.id, id)).returning();
        await db.update(kanbanCards).set({ columnStatus: 'in_progress', updatedAt: new Date() }).where(eq(kanbanCards.id, approvalCard.id));
        await enqueueTaskRun(approvalCard.id, 'dispatch', 'queue');
        return cancelled;
      }
      if (!input.answer?.trim() && !input.selectedOption?.trim()) {
        return reply.code(400).send({ error: 'checkpoint_answer_required', message: 'Answer the checkpoint with selectedOption and/or answer text.' });
      }
      await answerClientCheckpoint(approval, approvalCard, user, { answer: input.answer ?? input.decisionNote ?? null, selectedOption: input.selectedOption ?? null });
      const [answered] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
      return answered;
    }
    if (input.status === 'answered') return reply.code(400).send({ error: 'invalid_status', message: 'status=answered is only valid for client_checkpoint approvals.' });
    if (approvalCard && input.status === 'approved') {
      const childBlock = await completionBlockedByChildren(approvalCard, 'done');
      if (childBlock) {
        return reply.code(409).send({
          error: 'parent_children_incomplete',
          message: childBlock.message,
          childCount: childBlock.childCount,
          incompleteCount: childBlock.incompleteCount,
          incompleteTitles: childBlock.incompleteTitles,
        });
      }
    }
    const [updatedApproval] = await db.update(approvals).set({
      status: input.status,
      decisionNote: input.decisionNote ?? null,
      decidedByUserId: user.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(approvals.id, id)).returning();
    if (approval.cardId) {
      const card = approvalCard;
      if (card && input.status !== 'cancelled') {
        // Merge closure (§19): human approval is the last review gate, and the
        // merge gate sits after it. An approved card on a merge-gated project
        // parks on its authorized head instead of going straight to done.
        const mergePlan = input.status === 'approved' ? await planMergeGate(card) : null;
        const nextStatus = input.status === 'approved' && mergePlan ? mergeCompletionStatus(mergePlan) : 'todo';
        const completed = await guardedCompletionUpdate(card, { columnStatus: nextStatus, completedAt: nextStatus === 'done' ? new Date() : null, reviewFeedback: input.decisionNote ?? card.reviewFeedback, updatedAt: new Date() });
        if (!completed) return reply.code(409).send({ error: 'approval_completion_superseded' });
        if (nextStatus === 'done') { await sealDeliveryAcceptance(card.id); await cascadeParentStatus(card.parentCardId); }
        await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'approval', status: input.status === 'approved' ? 'success' : 'failed', message: `Approval ${input.status} by ${actorLabel(user)}.`, output: input.decisionNote });
        if (mergePlan) {
          await applyMergeGatePlan(completed, mergePlan, { approvedBy: user.id, actor: { type: 'user', id: user.id, userId: user.id }, fromStatus: card.columnStatus });
        } else {
          await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'todo'} to ${nextStatus} by approval.` });
        }
      }
    }
    await db.insert(activityLog).values({ companyId: approval.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: `approval.${input.status}`, entityType: 'approval', entityId: approval.id, details: { cardId: approval.cardId, note: input.decisionNote } });
    return updatedApproval;
  });
  app.get('/api/budget-policies', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; agentId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(budgetPolicies.companyId, query.companyId) : inArray(budgetPolicies.companyId, access.companyIds),
      query.agentId ? eq(budgetPolicies.agentId, query.agentId) : undefined,
    ].filter(Boolean);
    return db.select().from(budgetPolicies).where(filters.length ? and(...filters) : undefined).orderBy(desc(budgetPolicies.createdAt));
  });
  app.post('/api/budget-policies', async (request, reply) => {
    const input = createBudgetPolicySchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    await ensureCompanyReferences(input.companyId, { assigneeId: input.agentId ?? null });
    const [policy] = await db.insert(budgetPolicies).values({
      companyId: input.companyId,
      agentId: input.agentId ?? null,
      name: input.name,
      monthlyLimitUsd: input.monthlyLimitUsd?.toString() ?? null,
      perTaskLimitUsd: input.perTaskLimitUsd?.toString() ?? null,
      warnAtPercent: input.warnAtPercent,
      hardStop: input.hardStop,
      isActive: input.isActive,
    }).returning();
    if (policy) await db.insert(activityLog).values({ companyId: policy.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'budget_policy.created', entityType: 'budget_policy', entityId: policy.id, details: { name: policy.name } });
    return reply.code(201).send(policy);
  });
  app.put('/api/budget-policies/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateBudgetPolicySchema.parse(request.body);
    const [existing] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'budget_policy_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'budget_policy_company_immutable' });
    const companyId = existing.companyId;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    await ensureCompanyReferences(companyId, { assigneeId: input.agentId ?? existing.agentId });
    const [policy] = await db.update(budgetPolicies).set({
      agentId: input.agentId,
      name: input.name,
      monthlyLimitUsd: input.monthlyLimitUsd === undefined ? undefined : input.monthlyLimitUsd?.toString() ?? null,
      perTaskLimitUsd: input.perTaskLimitUsd === undefined ? undefined : input.perTaskLimitUsd?.toString() ?? null,
      warnAtPercent: input.warnAtPercent,
      hardStop: input.hardStop,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(budgetPolicies.id, id)).returning();
    if (!policy) return reply.code(404).send({ error: 'budget_policy_not_found' });
    await db.insert(activityLog).values({ companyId: policy.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'budget_policy.updated', entityType: 'budget_policy', entityId: policy.id, details: { name: policy.name } });
    return policy;
  });
  app.delete('/api/budget-policies/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'budget_policy_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [policy] = await db.delete(budgetPolicies).where(eq(budgetPolicies.id, id)).returning();
    if (policy) await db.insert(activityLog).values({ companyId: policy.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'budget_policy.deleted', entityType: 'budget_policy', entityId: policy.id, details: { name: policy.name } });
    return { ok: true };
  });
  app.get('/api/dashboard', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) {
      return { stats: { companies: 0, tasks: 0, openTasks: 0, completedTasks: 0, blockedTasks: 0, cancelledTasks: 0, agents: 0, activeAgents: 0, busyAgents: 0, activeRuns: 0, pendingApprovals: 0, budgetPolicies: 0, monthlyCost: 0 }, stages: {}, recentTaskLogs: [], recentApiEvents: [], recentActivity: [], recentRuns: [], pendingApprovals: [] };
    }
    const [cardStatRows, agentStatRows, companyStatRows, recentTaskLogs, recentApiEvents, recentActivity, recentRuns, pendingApprovals, policyStatRows] = await Promise.all([
      db.select({
        status: kanbanCards.columnStatus,
        count: drizzleSql<number>`count(*)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(${kanbanCards.costUsd}), 0)::float`,
      }).from(kanbanCards).where(inArray(kanbanCards.companyId, access.companyIds)).groupBy(kanbanCards.columnStatus),
      db.select({
        total: drizzleSql<number>`count(*)::int`,
        active: drizzleSql<number>`count(*) filter (where ${agents.isActive} is distinct from false)::int`,
        busy: drizzleSql<number>`count(*) filter (where ${agents.isBusy})::int`,
      }).from(agents).where(inArray(agents.companyId, access.companyIds)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(companies).where(inArray(companies.id, access.companyIds)),
      db.select().from(taskLogs).innerJoin(kanbanCards, eq(taskLogs.cardId, kanbanCards.id)).where(inArray(kanbanCards.companyId, access.companyIds)).orderBy(desc(taskLogs.createdAt)).limit(20),
      db.select().from(apiEvents).where(eq(apiEvents.userId, access.user.id)).orderBy(desc(apiEvents.createdAt)).limit(20),
      db.select().from(activityLog).where(inArray(activityLog.companyId, access.companyIds)).orderBy(desc(activityLog.createdAt)).limit(20),
      db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.companyId, access.companyIds)).orderBy(desc(heartbeatRuns.createdAt)).limit(20),
      db.select().from(approvals).where(and(inArray(approvals.companyId, access.companyIds), eq(approvals.status, 'pending'))).orderBy(desc(approvals.createdAt)).limit(50),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(budgetPolicies).where(and(inArray(budgetPolicies.companyId, access.companyIds), eq(budgetPolicies.isActive, true))),
    ]);
    const stages: Record<string, number> = {};
    let totalTasks = 0;
    let completedTasks = 0;
    let blockedTasks = 0;
    let cancelledTasks = 0;
    let monthlyCost = 0;
    for (const row of cardStatRows) {
      const key = row.status ?? 'todo';
      stages[key] = (stages[key] ?? 0) + row.count;
      totalTasks += row.count;
      monthlyCost += row.costUsd;
      if (key === 'done') completedTasks += row.count;
      if (key === 'blocked') blockedTasks += row.count;
      if (key === 'cancelled') cancelledTasks += row.count;
    }
    const agentStats = agentStatRows[0] ?? { total: 0, active: 0, busy: 0 };
    return {
      stats: {
        companies: companyStatRows[0]?.count ?? 0,
        tasks: totalTasks,
        openTasks: totalTasks - completedTasks - blockedTasks - cancelledTasks,
        completedTasks,
        blockedTasks,
        cancelledTasks,
        agents: agentStats.total,
        activeAgents: agentStats.active,
        busyAgents: agentStats.busy,
        activeRuns: recentRuns.filter((run) => run.status === 'running').length,
        pendingApprovals: pendingApprovals.length,
        budgetPolicies: policyStatRows[0]?.count ?? 0,
        monthlyCost: Number(monthlyCost.toFixed(4)),
      },
      stages,
      recentTaskLogs: recentTaskLogs.map((row) => row.task_logs),
      recentApiEvents,
      recentActivity,
      recentRuns,
      pendingApprovals,
    };
  });

  app.get('/api/search', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { q?: string; companyId?: string; limit?: string };
    const q = (query.q ?? '').trim();
    if (q.length < 2) return { query: q, cards: [], agents: [], projects: [], companies: [], chatSessions: [], knowledgeDocs: [] };
    const companyIds = query.companyId
      ? access.companyIds.filter((id) => id === query.companyId)
      : access.companyIds;
    if (companyIds.length === 0) return { query: q, cards: [], agents: [], projects: [], companies: [], chatSessions: [], knowledgeDocs: [] };
    const limit = Math.min(Math.max(Number(query.limit ?? 8), 1), 25);
    const pattern = `%${q.replace(/([\\%_])/g, '\\$1')}%`;
    const [cardRows, agentRows, projectRows, companyRows, sessionRows, docRows] = await Promise.all([
      db.select({ id: kanbanCards.id, title: kanbanCards.title, columnStatus: kanbanCards.columnStatus, companyId: kanbanCards.companyId, projectId: kanbanCards.projectId })
        .from(kanbanCards)
        .where(and(inArray(kanbanCards.companyId, companyIds), isNull(kanbanCards.deletedAt), drizzleSql`${kanbanCards.title} ILIKE ${pattern}`))
        .orderBy(desc(kanbanCards.updatedAt)).limit(limit),
      db.select({ id: agents.id, name: agents.name, role: agents.role, companyId: agents.companyId, isActive: agents.isActive })
        .from(agents)
        .where(and(inArray(agents.companyId, companyIds), isNull(agents.deletedAt), drizzleSql`(${agents.name} ILIKE ${pattern} OR ${agents.role} ILIKE ${pattern})`))
        .limit(limit),
      db.select({ id: projects.id, name: projects.name, companyId: projects.companyId })
        .from(projects)
        .where(and(inArray(projects.companyId, companyIds), isNull(projects.deletedAt), drizzleSql`${projects.name} ILIKE ${pattern}`))
        .limit(limit),
      db.select({ id: companies.id, name: companies.name, slug: companies.slug })
        .from(companies)
        .where(and(inArray(companies.id, companyIds), drizzleSql`${companies.name} ILIKE ${pattern}`))
        .limit(limit),
      db.select({ id: chatSessions.id, title: chatSessions.title, companyId: chatSessions.companyId, agentId: chatSessions.agentId })
        .from(chatSessions)
        .where(and(inArray(chatSessions.companyId, companyIds), drizzleSql`${chatSessions.title} ILIKE ${pattern}`))
        .orderBy(desc(chatSessions.updatedAt)).limit(limit),
      db.select({ id: knowledgeDocs.id, title: knowledgeDocs.title, companyId: knowledgeDocs.companyId })
        .from(knowledgeDocs)
        .where(and(inArray(knowledgeDocs.companyId, companyIds), drizzleSql`${knowledgeDocs.title} ILIKE ${pattern}`))
        .limit(limit),
    ]);
    return { query: q, cards: cardRows, agents: agentRows, projects: projectRows, companies: companyRows, chatSessions: sessionRows, knowledgeDocs: docRows };
  });

  app.get('/api/dashboard/timeseries', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { days?: string; companyId?: string };
    const companyIds = query.companyId
      ? access.companyIds.filter((id) => id === query.companyId)
      : access.companyIds;
    const days = Math.min(Math.max(Number(query.days ?? 30), 7), 180);
    if (companyIds.length === 0) return { days, points: [] };
    const [costRows, doneRows, runRows] = await Promise.all([
      db.select({
        day: drizzleSql<string>`to_char(date_trunc('day', ${costEvents.occurredAt}), 'YYYY-MM-DD')`,
        costUsd: drizzleSql<number>`coalesce(sum(${costEvents.costUsd}), 0)::float`,
      }).from(costEvents)
        .where(and(inArray(costEvents.companyId, companyIds), drizzleSql`${costEvents.occurredAt} > now() - interval '${drizzleSql.raw(String(days))} days'`))
        .groupBy(drizzleSql`1`),
      db.select({
        day: drizzleSql<string>`to_char(date_trunc('day', ${kanbanCards.completedAt}), 'YYYY-MM-DD')`,
        completed: drizzleSql<number>`count(*)::int`,
      }).from(kanbanCards)
        .where(and(inArray(kanbanCards.companyId, companyIds), isNull(kanbanCards.deletedAt), drizzleSql`${kanbanCards.completedAt} > now() - interval '${drizzleSql.raw(String(days))} days'`))
        .groupBy(drizzleSql`1`),
      db.select({
        day: drizzleSql<string>`to_char(date_trunc('day', ${heartbeatRuns.createdAt}), 'YYYY-MM-DD')`,
        runs: drizzleSql<number>`count(*)::int`,
        failedRuns: drizzleSql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
      }).from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.companyId, companyIds), drizzleSql`${heartbeatRuns.createdAt} > now() - interval '${drizzleSql.raw(String(days))} days'`))
        .groupBy(drizzleSql`1`),
    ]);
    const byDay = new Map<string, { day: string; costUsd: number; completed: number; runs: number; failedRuns: number }>();
    const point = (day: string) => {
      const existing = byDay.get(day);
      if (existing) return existing;
      const created = { day, costUsd: 0, completed: 0, runs: 0, failedRuns: 0 };
      byDay.set(day, created);
      return created;
    };
    const today = new Date();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
      point(date.toISOString().slice(0, 10));
    }
    for (const row of costRows) point(row.day).costUsd = Number(row.costUsd.toFixed(4));
    for (const row of doneRows) point(row.day).completed = row.completed;
    for (const row of runRows) { const entry = point(row.day); entry.runs = row.runs; entry.failedRuns = row.failedRuns; }
    return { days, points: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  });

  app.get('/api/notifications', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; limit?: string };
    const companyIds = query.companyId
      ? access.companyIds.filter((id) => id === query.companyId)
      : access.companyIds;
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    const [rows, unread] = await Promise.all([
      listNotifications(access.user.id, companyIds, limit),
      unreadNotificationCount(access.user.id, companyIds),
    ]);
    return { notifications: rows, unreadCount: unread };
  });
  app.post('/api/notifications/:id/read', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const id = (request.params as { id: string }).id;
    const [row] = await db.select({ companyId: notifications.companyId }).from(notifications).where(eq(notifications.id, id)).limit(1);
    if (!row || !access.companyIds.includes(row.companyId)) return reply.code(404).send({ error: 'notification_not_found' });
    await markNotificationRead(access.user.id, id);
    return { ok: true };
  });
  app.post('/api/notifications/read-all', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    const companyIds = query.companyId
      ? access.companyIds.filter((id) => id === query.companyId)
      : access.companyIds;
    const marked = await markAllNotificationsRead(access.user.id, companyIds);
    return { ok: true, marked };
  });

  app.get('/api/companies', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    return db.select().from(companies).where(inArray(companies.id, access.companyIds)).orderBy(desc(companies.createdAt));
  });
  app.post('/api/companies', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const input = createCompanySchema.parse(request.body);
    const company = await db.transaction(async (tx) => {
      const [created] = await tx.insert(companies).values({
        name: input.name,
        slug: input.slug,
        mission: input.mission ?? null,
        bossRolePrompt: input.bossRolePrompt ?? null,
        nfsShareUrl: input.nfsShareUrl ?? null,
        maxChildrenPerCard: input.maxChildrenPerCard ?? 3,
        panelReviewDefault: input.panelReviewDefault ?? 'critical_only',
        dispatchIntervalSeconds: input.dispatchIntervalSeconds,
        autoDispatchEnabled: false,
      }).returning();
      if (!created) return null;
      await tx.insert(companyMemberships).values({ companyId: created.id, userId: user.id, role: 'admin', status: 'active' }).onConflictDoNothing();
      await tx.insert(positions).values({
        companyId: created.id,
        name: 'CEO',
        slug: 'ceo',
        prompt: CEO_POSITION_PROMPT,
        description: 'Default company boss position.',
        rank: 0,
        isCompanyBoss: true,
        canDelegateAcrossDepartments: true,
      }).onConflictDoNothing();
      await tx.insert(activityLog).values({ companyId: created.id, actorType: 'user', actorId: user.id, userId: user.id, action: 'company.created', entityType: 'company', entityId: created.id, details: { name: created.name } });
      return created;
    });
    return reply.code(201).send(company);
  });
  app.get('/api/companies/:id/execution-readiness', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (!access.companyIds.includes(id)) return reply.code(403).send({ error: 'company_access_denied' });
    const query = z.object({ agentId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).parse(request.query);
    const structure = await companyExecutionReadiness(id, query.agentId, query.departmentId);
    const repository = await workerRepositoryReadiness(id, query.agentId, query.projectId);
    return { ...structure, ready: structure.ready && repository.status !== 'blocked', repositoryWriteAccess: repository.status, repositoryIssues: repository.issues };
  });
  app.put('/api/companies/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = await requireCompanyRole(request, reply, id, 'operator'); if (!user) return reply;
    const input = updateCompanySchema.parse(request.body);
    if (input.autoDispatchEnabled === true) {
      const [current] = await db.select().from(companies).where(eq(companies.id,id)).limit(1);
      if (current?.autoDispatchEnabled !== true) {
        if (current?.setupDraft && !current.setupDraft.completed) return reply.code(409).send({ error: 'company_setup_finish_required', message: 'Finish company setup and check the runtime connections before enabling automatic dispatch.' });
        const readiness = await companyExecutionReadiness(id);
        if (!readiness.ready) return reply.code(409).send({ error: 'company_setup_required', message: [...readiness.issues,...readiness.runtimeIssues].join(' ') });
      }
    }
    const [company] = await db.update(companies).set({
      name: input.name,
      slug: input.slug,
      mission: input.mission,
      bossRolePrompt: input.bossRolePrompt,
      nfsShareUrl: input.nfsShareUrl,
      maxChildrenPerCard: input.maxChildrenPerCard,
      panelReviewDefault: input.panelReviewDefault,
      dispatchIntervalSeconds: input.dispatchIntervalSeconds,
      autoDispatchEnabled: input.autoDispatchEnabled,
    }).where(eq(companies.id, id)).returning();
    if (!company) return reply.code(404).send({ error: 'company_not_found' });
    return company;
  });
  app.get('/api/companies/:id/deletion-preview', async (request, reply) => {
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const user = await requireCompanyRole(request, reply, id, 'admin'); if (!user) return reply;
    return sql.begin('isolation level repeatable read read only', async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='5000ms'");
      const inventory = await companyDeletionInventory(tx, id);
      const blocking = deletionBlockers(inventory);
      return { companyId: id, canDelete: Object.keys(blocking).length === 0, blocking, inventory };
    });
  });
  app.delete('/api/companies/:id', async (request, reply) => {
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const user = await requireCompanyRole(request, reply, id, 'admin'); if (!user) return reply;
    try {
      const result = await sql.begin(async tx => {
        const catalog = await lockCompanyInventory(tx);
        const [membership] = await tx.unsafe("SELECT cm.id FROM company_memberships cm JOIN users u ON u.id=cm.user_id WHERE cm.company_id=$1 AND cm.user_id=$2 AND cm.role='admin' AND cm.status='active' AND u.status='active' FOR SHARE OF u", [id, user.id]);
        if (!membership) return { error: 'company_role_required' as const };
        const [company] = await tx.unsafe('SELECT id,name,slug FROM companies WHERE id=$1', [id]);
        if (!company) return { error: 'company_not_found' as const };
        const inventory = await companyDeletionInventory(tx, id, catalog);
        const blocking = deletionBlockers(inventory);
        if (Object.keys(blocking).length) return { error: 'company_not_empty' as const, blocking, inventory };
        await tx.unsafe("UPDATE activity_log SET company_id=NULL, details=coalesce(details,'{}'::jsonb) || jsonb_build_object('formerCompany', $2::jsonb) WHERE company_id=$1", [id, JSON.stringify(company)]);
        await tx.unsafe('DELETE FROM positions WHERE company_id=$1', [id]);
        await tx.unsafe('DELETE FROM company_memberships WHERE company_id=$1', [id]);
        await tx.unsafe('DELETE FROM companies WHERE id=$1', [id]);
        await tx.unsafe("INSERT INTO activity_log (company_id, actor_type, actor_id, user_id, action, entity_type, entity_id, details) VALUES (NULL,'user',$1,$2::uuid,'company.deleted','company',$3,$4::jsonb)", [user.id, user.id, id, JSON.stringify({ formerCompany: company })]);
        return { ok: true as const };
      });
      if ('error' in result) return reply.code(result.error === 'company_role_required' ? 403 : result.error === 'company_not_found' ? 404 : 409).send(result);
      return result;
    } catch (error) {
      if (['55P03','57014','40P01','23503'].includes(String((error as { code?: string }).code))) return reply.code(409).send({ error: 'company_delete_busy', message: 'Company records changed or are busy. Refresh the deletion preview and retry.' });
      throw error;
    }
  });

  app.get('/api/company-memberships', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [query.companyId ? eq(companyMemberships.companyId, query.companyId) : inArray(companyMemberships.companyId, access.companyIds)];
    return db.select({
      id: companyMemberships.id,
      companyId: companyMemberships.companyId,
      userId: companyMemberships.userId,
      role: companyMemberships.role,
      status: companyMemberships.status,
      createdAt: companyMemberships.createdAt,
      updatedAt: companyMemberships.updatedAt,
      userEmail: users.email,
      userName: users.name,
    }).from(companyMemberships)
      .innerJoin(users, eq(companyMemberships.userId, users.id))
      .where(and(...filters))
      .orderBy(desc(companyMemberships.createdAt));
  });

  app.post('/api/company-memberships', async (request, reply) => {
    const input = createCompanyMembershipSchema.parse(request.body);
    const actor = await requireCompanyRole(request, reply, input.companyId, 'admin'); if (!actor) return reply;
    const [targetUser] = input.userId
      ? await db.select().from(users).where(eq(users.id, input.userId)).limit(1)
      : await db.select().from(users).where(eq(users.email, input.email ?? '')).limit(1);
    if (!targetUser) return reply.code(404).send({ error: 'user_not_found' });
    const [membership] = await db.insert(companyMemberships).values({
      companyId: input.companyId,
      userId: targetUser.id,
      role: input.role,
      status: input.status,
    }).onConflictDoUpdate({
      target: [companyMemberships.companyId, companyMemberships.userId],
      set: { role: input.role, status: input.status, updatedAt: new Date() },
    }).returning();
    if (membership) await db.insert(activityLog).values({ companyId: membership.companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'membership.upserted', entityType: 'company_membership', entityId: membership.id, details: { userId: targetUser.id, email: targetUser.email, role: membership.role, status: membership.status } });
    return reply.code(201).send(membership);
  });

  app.put('/api/company-memberships/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateCompanyMembershipSchema.parse(request.body);
    const [existing] = await db.select().from(companyMemberships).where(eq(companyMemberships.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'membership_not_found' });
    const actor = await requireCompanyRole(request, reply, existing.companyId, 'admin'); if (!actor) return reply;
    const [membership] = await db.update(companyMemberships).set({ role: input.role, status: input.status, updatedAt: new Date() }).where(eq(companyMemberships.id, id)).returning();
    if (membership) await db.insert(activityLog).values({ companyId: membership.companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'membership.updated', entityType: 'company_membership', entityId: membership.id, details: { role: membership.role, status: membership.status } });
    return membership;
  });

  app.delete('/api/company-memberships/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(companyMemberships).where(eq(companyMemberships.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'membership_not_found' });
    const actor = await requireCompanyRole(request, reply, existing.companyId, 'admin'); if (!actor) return reply;
    await db.update(companyMemberships).set({ status: 'disabled', updatedAt: new Date() }).where(eq(companyMemberships.id, id));
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'membership.disabled', entityType: 'company_membership', entityId: existing.id, details: { userId: existing.userId } });
    return { ok: true };
  });

  app.get('/api/departments', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    return db.select().from(departments).where(query.companyId ? eq(departments.companyId, query.companyId) : inArray(departments.companyId, access.companyIds)).orderBy(desc(departments.createdAt));
  });
  app.post('/api/departments', async (request, reply) => {
    const input = createDepartmentSchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    if (input.headAgentId) {
      const [head] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.headAgentId), eq(agents.companyId, input.companyId), isNull(agents.deletedAt))).limit(1);
      if (!head) return reply.code(400).send({ error: 'department_head_mismatch', detail: 'headAgentId must be an active agent of the same company.' });
    }
    const [department] = await db.insert(departments).values({ companyId: input.companyId, name: input.name, slug: input.slug, headAgentId: input.headAgentId ?? null, description: input.description ?? null, headRolePrompt: input.headRolePrompt ?? null }).returning();
    return reply.code(201).send(department);
  });
  // Department head and charter: the head receives department cards from the
  // CEO and splits them to members; the description is what the CEO reads to
  // decide which departments a task or brainstorm concerns.
  app.put('/api/departments/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateDepartmentSchema.parse(request.body);
    const [existing] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'department_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    if (input.headAgentId) {
      const [head] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.headAgentId), eq(agents.companyId, existing.companyId), isNull(agents.deletedAt))).limit(1);
      if (!head) return reply.code(400).send({ error: 'department_head_mismatch', detail: 'headAgentId must be an active agent of the same company.' });
    }
    const [department] = await db.update(departments).set({
      name: input.name,
      headAgentId: input.headAgentId === undefined ? undefined : input.headAgentId,
      description: input.description === undefined ? undefined : input.description,
      headRolePrompt: input.headRolePrompt,
    }).where(eq(departments.id, id)).returning();
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'department.updated', entityType: 'department', entityId: id, details: { headAgentId: input.headAgentId, hasDescription: Boolean(input.description) } });
    return department;
  });

  app.get('/api/positions/templates', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    return POSITION_TEMPLATES;
  });
  app.get('/api/positions', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    return db.select().from(positions).where(query.companyId ? eq(positions.companyId, query.companyId) : inArray(positions.companyId, access.companyIds)).orderBy(desc(positions.createdAt));
  });
  app.post('/api/positions', async (request, reply) => {
    const input = createPositionSchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    if (input.defaultDepartmentId) {
      try { await ensureCompanyReferences(input.companyId, { departmentId: input.defaultDepartmentId }); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' }); }
    }
    if (input.managerPositionId) {
      const [manager] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.id, input.managerPositionId), eq(positions.companyId, input.companyId))).limit(1);
      if (!manager) return reply.code(400).send({ error: 'manager_position_company_mismatch' });
    }
    if (input.isCompanyBoss && input.isActive) {
      const [existingBoss] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.companyId, input.companyId), eq(positions.isCompanyBoss, true), eq(positions.isActive, true))).limit(1);
      if (existingBoss) return reply.code(409).send({ error: 'company_boss_position_exists', existingPositionId: existingBoss.id });
    }
    const [position] = await db.insert(positions).values({
      companyId: input.companyId,
      name: input.name,
      slug: input.slug,
      prompt: optionalText(input.prompt) ?? null,
      description: optionalText(input.description) ?? null,
      reviewDomain: optionalText(input.reviewDomain) ?? null,
      rank: input.rank,
      isCompanyBoss: input.isCompanyBoss,
      canDelegateAcrossDepartments: input.canDelegateAcrossDepartments,
      defaultDepartmentId: input.defaultDepartmentId ?? null,
      managerPositionId: input.isCompanyBoss ? null : input.managerPositionId ?? null,
      isActive: input.isActive,
    }).returning();
    if (position) await db.insert(activityLog).values({ companyId: position.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'position.created', entityType: 'position', entityId: position.id, details: { name: position.name } });
    return reply.code(201).send(position);
  });
  app.put('/api/positions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updatePositionSchema.parse(request.body);
    const [existing] = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'position_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'position_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const nextDefaultDepartmentId = input.defaultDepartmentId === undefined ? existing.defaultDepartmentId : input.defaultDepartmentId ?? null;
    const nextManagerPositionId = input.managerPositionId === undefined ? existing.managerPositionId : input.managerPositionId ?? null;
    const nextIsCompanyBoss = input.isCompanyBoss === undefined ? existing.isCompanyBoss : input.isCompanyBoss;
    const nextIsActive = input.isActive === undefined ? existing.isActive : input.isActive;
    if (nextDefaultDepartmentId) {
      try { await ensureCompanyReferences(existing.companyId, { departmentId: nextDefaultDepartmentId }); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' }); }
    }
    if (nextManagerPositionId) {
      if (nextManagerPositionId === id) return reply.code(409).send({ error: 'position_cannot_manage_itself' });
      const [manager] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.id, nextManagerPositionId), eq(positions.companyId, existing.companyId))).limit(1);
      if (!manager) return reply.code(400).send({ error: 'manager_position_company_mismatch' });
    }
    if (nextIsCompanyBoss && nextIsActive) {
      const [existingBoss] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.companyId, existing.companyId), eq(positions.isCompanyBoss, true), eq(positions.isActive, true), ne(positions.id, id))).limit(1);
      if (existingBoss) return reply.code(409).send({ error: 'company_boss_position_exists', existingPositionId: existingBoss.id });
    }
    if (existing.isCompanyBoss && existing.isActive && (!nextIsCompanyBoss || !nextIsActive)) {
      const [replacementBoss] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.companyId, existing.companyId), eq(positions.isCompanyBoss, true), eq(positions.isActive, true), ne(positions.id, id))).limit(1);
      if (!replacementBoss) return reply.code(409).send({ error: 'company_boss_position_required', message: 'Assign another active boss position before disabling this one.' });
    }
    const [position] = await db.update(positions).set({
      name: input.name,
      slug: input.slug,
      prompt: input.prompt === undefined ? undefined : optionalText(input.prompt) ?? null,
      description: input.description === undefined ? undefined : optionalText(input.description) ?? null,
      reviewDomain: input.reviewDomain === undefined ? undefined : optionalText(input.reviewDomain) ?? null,
      rank: input.rank,
      isCompanyBoss: input.isCompanyBoss,
      canDelegateAcrossDepartments: input.canDelegateAcrossDepartments,
      defaultDepartmentId: input.defaultDepartmentId === undefined ? undefined : input.defaultDepartmentId ?? null,
      managerPositionId: nextIsCompanyBoss ? null : input.managerPositionId === undefined ? undefined : input.managerPositionId ?? null,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(positions.id, id)).returning();
    if (!position) return reply.code(404).send({ error: 'position_not_found' });
    await db.insert(activityLog).values({ companyId: position.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'position.updated', entityType: 'position', entityId: position.id, details: { name: position.name } });
    return position;
  });
  app.delete('/api/positions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [position] = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
    if (!position) return reply.code(404).send({ error: 'position_not_found' });
    const user = await requireCompanyRole(request, reply, position.companyId, 'operator'); if (!user) return reply;
    if (position.isCompanyBoss && position.isActive) return reply.code(409).send({ error: 'company_boss_position_required', message: 'Assign another boss position before deleting this one.' });
    await db.update(agents).set({ positionId: null }).where(eq(agents.positionId, id));
    await db.delete(positions).where(eq(positions.id, id));
    await db.insert(activityLog).values({ companyId: position.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'position.deleted', entityType: 'position', entityId: id, details: { name: position.name } });
    return { ok: true };
  });

  app.get('/api/cards', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    const query = request.query as { companyId?: string; status?: string; assigneeId?: string; projectId?: string; tag?: string; priority?: string; limit?: string; offset?: string };
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const status = normalizeCardStatus(query.status);
    const filters = [
      query.companyId ? eq(kanbanCards.companyId, query.companyId) : inArray(kanbanCards.companyId, access.companyIds),
      isNull(kanbanCards.deletedAt),
      status ? eq(kanbanCards.columnStatus, status) : undefined,
      query.assigneeId ? eq(kanbanCards.assigneeId, query.assigneeId) : undefined,
      query.projectId === 'none' ? isNull(kanbanCards.projectId) : query.projectId ? eq(kanbanCards.projectId, query.projectId) : undefined,
      query.priority ? eq(kanbanCards.priority, priorityToNumber(query.priority)) : undefined,
      query.tag ? drizzleSql`${query.tag} = ANY(${kanbanCards.tags})` : undefined,
    ].filter(Boolean);
    const where = filters.length ? and(...filters) : undefined;
    const rows = await db.select().from(kanbanCards).where(where).orderBy(desc(kanbanCards.updatedAt)).limit(Number(query.limit ?? 100)).offset(Number(query.offset ?? 0));
    return hydrateCardWorkflowActors(await hydrateCardDependencyState(rows));
  });

  app.post('/api/cards', async (request, reply) => {
    const input = createCardSchema.parse(request.body);
    const companyId = await resolveMutationCompany(request, reply, input.companyId); if (!companyId) return reply;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    try {
      await ensureCompanyReferences(companyId, {
        departmentId: input.departmentId,
        projectId: input.projectId,
        goalId: input.goalId,
        assigneeId: input.assigneeId,
        reviewerId: input.reviewerId,
        dependencyCardIds: input.dependencyCardIds,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' });
    }
    const reviewerId = normalizedReviewerId(input.assigneeId ?? null, input.reviewerId ?? null);
    const [card] = await db.insert(kanbanCards).values({
      companyId,
      title: input.title,
      body: input.body,
      priority: priorityToNumber(input.priority),
      tags: input.tags,
      departmentId: input.departmentId ?? null,
      assigneeId: input.assigneeId ?? null,
      reviewerId,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      parentCardId: input.parentCardId ?? null,
      dependencyCardIds: input.dependencyCardIds,
      requiresApproval: input.requiresApproval,
      coordinationOnly: input.coordinationOnly,
      reviewMode: input.reviewMode,
      critical: input.critical,
      reviewerIds: input.reviewerIds,
      forceBrainstorm: input.forceBrainstorm,
      brainstormDepartmentIds: input.brainstormDepartmentIds,
      decisionMode: input.decisionMode === undefined ? null : input.decisionMode ?? null,
      rollupStatus: input.rollupStatus ?? null,
      requiredChildPolicy: input.requiredChildPolicy ?? 'manual',
      childRequirementLevel: input.childRequirementLevel ?? 'follow_up',
      estimatedWeight: input.estimatedWeight === undefined || input.estimatedWeight === null ? null : input.estimatedWeight.toString(),
      estimatedDurationMinutes: input.estimatedDurationMinutes ?? null,
      taskBudgetLimit: input.taskBudgetLimit === undefined || input.taskBudgetLimit === null ? null : input.taskBudgetLimit.toString(),
      revisionCount: input.revisionCount,
      maxRevisions: input.maxRevisions,
      maxRetries: input.maxRetries,
      timeoutSeconds: input.timeoutSeconds ?? null,
      scheduleAt: input.scheduleAt ?? null,
      recurEveryMinutes: input.recurEveryMinutes ?? null,
      recurNextAt: input.recurEveryMinutes
        ? input.scheduleAt ?? new Date(Date.now() + input.recurEveryMinutes * 60_000)
        : null,
      createdBy: user.id,
    }).returning();
    if (card) {
      await setCardDependencies(card.id, input.dependencyCardIds);
      // Human splits are not bounded by the agent split rules, but the parent
      // still has to wait on its children like any other split.
      if (card.parentCardId) await ensureParentWaitingOnChildren(card.parentCardId, { childCount: 1, actor: 'user', agentId: null, message: `Child card "${card.title}" created by ${actorLabel(user)}; parent waits on its children.` });
      await recordStageAction({
        cardId: card.id,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus: null,
        toStatus: card.columnStatus ?? 'todo',
        action: 'create',
        detail: `Stage set to ${card.columnStatus ?? 'todo'} by ${actorLabel(user)}.`,
      });
      await recordCardAction({
        companyId: card.companyId,
        cardId: card.id,
        actor: { type: 'user', id: user.id, userId: user.id },
        action: 'card.created',
        toStatus: card.columnStatus,
        detail: `Card created by ${actorLabel(user)}.`,
        metadata: { title: card.title, dependencyCardIds: input.dependencyCardIds },
      });
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'card.created', entityType: 'card', entityId: card.id, details: { title: card.title, stage: card.columnStatus } });
      publishLiveEvent({ type: 'card.created', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId });
      const [hydrated] = await hydrateCardDependencyState([card]);
      return reply.code(201).send(hydrated ?? card);
    }
    return reply.code(201).send(card);
  });

  app.put('/api/cards/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateCardSchema.parse(request.body);
    const rawBody = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    const [existing] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const nextDepartmentId = input.departmentId === undefined ? existing.departmentId : input.departmentId ?? null;
    const nextProjectId = input.projectId === undefined ? existing.projectId : input.projectId ?? null;
    const nextGoalId = input.goalId === undefined ? existing.goalId : input.goalId ?? null;
    const nextAssigneeId = input.assigneeId === undefined ? existing.assigneeId : input.assigneeId ?? null;
    const nextReviewerId = normalizedReviewerId(nextAssigneeId, input.reviewerId === undefined ? existing.reviewerId : input.reviewerId ?? null);
    const nextParentCardId = input.parentCardId === undefined ? existing.parentCardId : input.parentCardId ?? null;
    if (input.parentCardId && input.parentCardId !== existing.parentCardId) {
      return reply.code(410).send({
        error: 'child_cards_disabled',
        message: 'Kanban no longer creates child-card relationships. Use same-card Message Board DELEGATE / REVIEWER records instead.',
      });
    }
    const nextDependencyCardIds = input.dependencyCardIds === undefined ? existing.dependencyCardIds ?? [] : input.dependencyCardIds;
    try {
      await ensureCompanyReferences(existing.companyId, {
        departmentId: nextDepartmentId,
        projectId: nextProjectId,
        goalId: nextGoalId,
        assigneeId: nextAssigneeId,
        reviewerId: nextReviewerId,
        parentCardId: nextParentCardId,
        dependencyCardIds: nextDependencyCardIds,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' });
    }
    if (input.updatedAt && existing.updatedAt && new Date(input.updatedAt).getTime() !== existing.updatedAt.getTime()) return reply.code(409).send({ error: 'card_modified' });
    const fromStatus = normalizeCardStatus(existing.columnStatus) ?? 'todo';
    const toStatus = input.columnStatus ? normalizeCardStatus(input.columnStatus) : undefined;
    const transitionAction = toStatus && toStatus !== fromStatus ? inferCardTransitionAction(fromStatus, toStatus) ?? 'manual_move' : null;
    if (transitionAction && toStatus) {
      const transitionError = validateCardTransition(transitionAction, fromStatus, 'user', toStatus);
      if (transitionError) return reply.code(transitionError.code === 'FORBIDDEN' ? 403 : 409).send({ error: transitionError.message, code: transitionError.code });
    }
    const childBlock = toStatus ? await completionBlockedByChildren(existing, toStatus) : null;
    if (childBlock) {
      return reply.code(409).send({
        error: 'parent_children_incomplete',
        message: childBlock.message,
        childCount: childBlock.childCount,
        incompleteCount: childBlock.incompleteCount,
        incompleteTitles: childBlock.incompleteTitles,
      });
    }
    const manualMergePlan = toStatus === 'done' ? await planMergeGate({ ...existing, projectId: nextProjectId }) : null;
    if (manualMergePlan) input.columnStatus = mergeCompletionStatus(manualMergePlan);
    if (input.dependencyCardIds !== undefined) {
      try {
        await setCardDependencies(id, nextDependencyCardIds);
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'card_dependency_update_failed' });
      }
    }
    const [card] = await db.update(kanbanCards).set({
      title: input.title,
      body: input.body,
      columnStatus: input.columnStatus,
      runRetryState: existing.columnStatus === 'blocked' && input.columnStatus && input.columnStatus !== 'blocked' ? {} : undefined,
      priority: input.priority ? priorityToNumber(input.priority) : undefined,
      tags: input.tags,
      departmentId: nextDepartmentId,
      assigneeId: nextAssigneeId,
      reviewerId: nextReviewerId,
      projectId: nextProjectId,
      goalId: nextGoalId,
      parentCardId: nextParentCardId,
      dependencyCardIds: nextDependencyCardIds,
      requiresApproval: input.requiresApproval,
      coordinationOnly: input.coordinationOnly,
      // The partial schema still fills these with their defaults, so only a
      // request that names them may change them: an unrelated edit must not
      // wipe the composed panel.
      reviewMode: 'reviewMode' in rawBody ? input.reviewMode : undefined,
      critical: 'critical' in rawBody ? input.critical : undefined,
      reviewerIds: 'reviewerIds' in rawBody ? input.reviewerIds : undefined,
      decisionMode: input.decisionMode === undefined ? undefined : input.decisionMode ?? null,
      rollupStatus: input.rollupStatus === undefined ? undefined : input.rollupStatus ?? null,
      requiredChildPolicy: input.requiredChildPolicy,
      childRequirementLevel: input.childRequirementLevel,
      estimatedWeight: input.estimatedWeight === undefined ? undefined : input.estimatedWeight === null ? null : input.estimatedWeight.toString(),
      estimatedDurationMinutes: input.estimatedDurationMinutes === undefined ? undefined : input.estimatedDurationMinutes ?? null,
      taskBudgetLimit: input.taskBudgetLimit === undefined ? undefined : input.taskBudgetLimit === null ? null : input.taskBudgetLimit.toString(),
      revisionCount: input.revisionCount,
      maxRevisions: input.maxRevisions,
      maxRetries: input.maxRetries,
      timeoutSeconds: input.timeoutSeconds === undefined ? undefined : input.timeoutSeconds ?? null,
      scheduleAt: input.scheduleAt === undefined ? undefined : input.scheduleAt ?? null,
      recurEveryMinutes: input.recurEveryMinutes === undefined ? undefined : input.recurEveryMinutes ?? null,
      recurNextAt: input.recurEveryMinutes === undefined
        ? undefined
        : input.recurEveryMinutes
          ? (input.scheduleAt ?? existing.recurNextAt ?? new Date(Date.now() + input.recurEveryMinutes * 60_000))
          : null,
      completedAt: input.columnStatus === 'done' ? new Date() : input.columnStatus ? null : undefined,
      updatedAt: new Date(),
    }).where(manualMergePlan ? completionCondition(existing) : eq(kanbanCards.id, id)).returning();
    if (!card && manualMergePlan) return reply.code(409).send({ error: 'manual_completion_superseded' });
    if (card && nextAssigneeId !== existing.assigneeId) {
      await db.insert(activityLog).values({
        companyId: card.companyId,
        actorType: 'user',
        actorId: user.id,
        userId: user.id,
        agentId: nextAssigneeId,
        action: 'card.assignee_changed',
        entityType: 'card',
        entityId: card.id,
        details: { fromAssigneeId: existing.assigneeId, toAssigneeId: nextAssigneeId },
      });
    }
    if (card && manualMergePlan) await applyMergeGatePlan(card, manualMergePlan, { actor: { type: 'user', id: user.id, userId: user.id }, approvedBy: user.id, fromStatus });
    if (card && transitionAction && toStatus && !manualMergePlan) {
      await recordStageAction({
        cardId: card.id,
        agentId: card.assigneeId,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus,
        toStatus,
        action: transitionAction,
        detail: `Stage changed from ${fromStatus} to ${toStatus} by ${actorLabel(user)}.`,
        metadata: { dependencyCardIds: nextDependencyCardIds },
      });
    } else if (card) {
      await recordCardAction({
        companyId: card.companyId,
        cardId: card.id,
        actor: { type: 'user', id: user.id, userId: user.id },
        action: input.dependencyCardIds !== undefined ? 'card.dependencies_updated' : 'card.updated',
        fromStatus: existing.columnStatus,
        toStatus: card.columnStatus,
        detail: `Card updated by ${actorLabel(user)}.`,
        metadata: { dependencyCardIds: nextDependencyCardIds },
      });
    }
    if (card && nextParentCardId && nextParentCardId !== existing.parentCardId) {
      await ensureParentWaitingOnChildren(nextParentCardId, {
        childCount: 1,
        actor: 'user',
        message: `Parent is waiting on child card: ${card.title}.`,
      });
    }
    const shouldQueueReview = card?.reviewerId && (
      (toStatus && ['in_review', 'needs_review'].includes(toStatus))
      || (!toStatus && ['in_review', 'needs_review'].includes(card.columnStatus ?? '') && card.reviewerId !== existing.reviewerId)
    );
    if (card && shouldQueueReview) {
      try {
        await enqueueTaskRun(card.id, 'review', 'manual', user.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'review_enqueue_failed';
        await db.insert(taskLogs).values({ cardId: card.id, agentId: card.reviewerId, type: 'review', status: 'failed', message });
      }
    }
    if (card) await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: card.assigneeId, action: input.columnStatus && input.columnStatus !== existing.columnStatus ? 'card.stage_changed' : 'card.updated', entityType: 'card', entityId: card.id, details: { from: existing.columnStatus, to: input.columnStatus, title: card.title } });
    if (card) publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: input.columnStatus && input.columnStatus !== existing.columnStatus ? 'card.stage_changed' : 'card.updated' });
    if (card) {
      const [hydrated] = await hydrateCardDependencyState([card]);
      return hydrated ?? card;
    }
    return card;
  });

  app.post('/api/cards/:id/cancel', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = z.object({ reason: z.string().trim().max(1000).optional() }).parse(request.body ?? {});
    const [existing] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const now = new Date();
    const reason = input.reason || `Cancelled by ${actorLabel(user)}.`;
    await db.update(taskRuns).set({
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
      lockedBy: null,
      lockedAt: null,
      error: reason,
    }).where(and(eq(taskRuns.cardId, id), inArray(taskRuns.status, ['queued', 'running'])));
    if (existing.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'cancelled', completedAt: now, error: reason }).where(eq(heartbeatRuns.id, existing.activeHeartbeatRunId));
    if (existing.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, existing.assigneeId));
    if (existing.executionLockedByAgentId && existing.executionLockedByAgentId !== existing.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, existing.executionLockedByAgentId));
    const [card] = await db.update(kanbanCards).set({
      columnStatus: 'cancelled',
      lastError: reason,
      nextRunAt: null,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: now,
    }).where(eq(kanbanCards.id, id)).returning();
    await db.insert(taskLogs).values({ cardId: id, agentId: existing.assigneeId, type: 'cancel', status: 'warning', message: reason });
    if (existing.columnStatus !== 'cancelled') {
      await recordStageAction({
        cardId: id,
        agentId: existing.assigneeId,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus: existing.columnStatus ?? 'todo',
        toStatus: 'cancelled',
        action: 'cancel',
        detail: `Stage changed from ${existing.columnStatus ?? 'todo'} to cancelled by ${actorLabel(user)}.`,
        logStatus: 'warning',
        metadata: { reason },
      });
    }
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: existing.assigneeId, action: 'card.cancelled', entityType: 'card', entityId: id, details: { title: existing.title, reason } });
    publishLiveEvent({ type: 'card.updated', companyId: existing.companyId, entityType: 'card', entityId: id, cardId: id, projectId: existing.projectId, action: 'card.cancelled' });
    return card;
  });

  app.delete('/api/cards/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const now = new Date();
    await db.update(kanbanCards).set({ parentCardId: null }).where(eq(kanbanCards.parentCardId, id));
    await db.update(taskRuns).set({ status: 'cancelled', completedAt: now, updatedAt: now, error: 'card_archived' }).where(and(eq(taskRuns.cardId, id), inArray(taskRuns.status, ['queued', 'running'])));
    if (existing.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'cancelled', completedAt: now, error: 'card_archived' }).where(eq(heartbeatRuns.id, existing.activeHeartbeatRunId));
    if (existing.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, existing.assigneeId));
    if (existing.executionLockedByAgentId && existing.executionLockedByAgentId !== existing.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, existing.executionLockedByAgentId));
    await db.update(kanbanCards).set({
      deletedAt: now,
      executionLockId: null,
      executionLockedByAgentId: null,
      executionLockedAt: null,
      executionLockExpiresAt: null,
      activeHeartbeatRunId: null,
      updatedAt: now,
    }).where(eq(kanbanCards.id, id));
    await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'card.deleted', entityType: 'card', entityId: id, details: { title: existing.title } });
    publishLiveEvent({ type: 'card.deleted', companyId: existing.companyId, entityType: 'card', entityId: id, cardId: id, projectId: existing.projectId });
    return { ok: true };
  });
  app.get('/api/cards/:id/logs', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const query = request.query as { limit?: string; offset?: string };
    return getTaskLogs(card.id, {
      limit: boundedQueryInt(query.limit, 100, 1, 500),
      offset: boundedQueryInt(query.offset, 0, 0, 100_000),
    });
  });
  app.get('/api/cards/:id/subtree', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const query = request.query as { limit?: string };
    return getCardSubtreeRows(card, boundedQueryInt(query.limit, 1000, 1, 5000));
  });
  app.get('/api/cards/:id/actions', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const query = request.query as { limit?: string };
    return getCardActions(card.id, Number(query.limit ?? 200));
  });
  app.get('/api/cards/:id/delegation-summary', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const rows = await db.select({
      id: cardComments.id,
      action: cardComments.action,
      assigneeAgentId: cardComments.assigneeAgentId,
      reviewerAgentId: cardComments.reviewerAgentId,
      reviewerScope: cardComments.reviewerScope,
      delegationStatus: cardComments.delegationStatus,
      createdAt: cardComments.createdAt,
    }).from(cardComments).where(and(
      eq(cardComments.cardId, card.id),
      drizzleSql`(${cardComments.assigneeAgentId} IS NOT NULL OR ${cardComments.reviewerAgentId} IS NOT NULL OR ${cardComments.delegationStatus} IS NOT NULL)`,
    )).orderBy(desc(cardComments.createdAt)).limit(80);
    const activeRows = rows.filter((row) => row.delegationStatus && ACTIVE_DELEGATION_STATUSES.has(row.delegationStatus));
    const phaseAssigneeRow = activeRows.find((row) => row.assigneeAgentId) ?? rows.find((row) => row.assigneeAgentId) ?? null;
    const phaseReviewerRow = activeRows.find((row) => row.reviewerScope === 'phase' && row.reviewerAgentId) ?? rows.find((row) => row.reviewerScope === 'phase' && row.reviewerAgentId) ?? null;
    const sourceRow = phaseAssigneeRow ?? phaseReviewerRow;
    return {
      phaseAssigneeId: phaseAssigneeRow?.assigneeAgentId ?? null,
      phaseReviewerId: phaseReviewerRow?.reviewerAgentId ?? null,
      phaseStatus: sourceRow?.delegationStatus ?? null,
      phaseUpdatedAt: sourceRow?.createdAt ?? null,
      phaseSourceAction: sourceRow?.action ?? null,
      phaseSourceCommentId: sourceRow?.id ?? null,
    };
  });
  app.get('/api/cards/:id/comments', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const comments = await db.select().from(cardComments).where(eq(cardComments.cardId, card.id)).orderBy(desc(cardComments.createdAt));
    const reviewRuns = await db.select({
      agentId: taskRuns.agentId,
      output: taskRuns.output,
      completedAt: taskRuns.completedAt,
    }).from(taskRuns).where(and(eq(taskRuns.cardId, card.id), eq(taskRuns.kind, 'review'))).orderBy(desc(taskRuns.completedAt)).limit(50);
    return hydrateReviewCommentAuthors(card, comments, reviewRuns);
  });
  app.get('/api/cards/:id/review-scores', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select({
      id: agentReviewScores.id,
      score: agentReviewScores.score,
      verdict: agentReviewScores.verdict,
      domain: agentReviewScores.domain,
      reviewerAgentId: agentReviewScores.reviewerId,
      revieweeAgentId: agentReviewScores.agentId,
      createdAt: agentReviewScores.createdAt,
    }).from(agentReviewScores).where(eq(agentReviewScores.cardId, card.id)).orderBy(desc(agentReviewScores.createdAt)).limit(20);
  });
  app.get('/api/cards/:id/review-rounds', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return listReviewRounds(card.id, 20);
  });
  app.post('/api/cards/:id/review-rounds', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = z.object({ kind: z.enum(['panel']).default('panel') }).parse(request.body ?? {});
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    if (card.columnStatus !== 'in_review') return reply.code(409).send({ error: 'card_not_in_review', message: `card_not_in_review: a blind review panel can only be opened on an in_review card; this card is ${card.columnStatus ?? 'todo'}.` });
    if (await hasOpenReviewRound(card.id)) return reply.code(409).send({ error: 'review_round_open', message: 'review_round_open: a blind review round is already open on this card.' });
    const opened = await openPanelRound(card, { kind: input.kind });
    await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'review_round.forced', entityType: 'card', entityId: card.id, details: { outcome: opened.outcome, roundId: opened.roundId, reviewerIds: opened.reviewerIds } });
    const rounds = opened.roundId ? await listReviewRounds(card.id, 5) : [];
    return reply.code(opened.roundId ? 201 : 200).send({ ok: true, cardId: card.id, outcome: opened.outcome, roundId: opened.roundId, reviewerIds: opened.reviewerIds, round: rounds.find((round) => round.id === opened.roundId) ?? null });
  });
  app.get('/api/cards/:id/work-products', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt));
  });
  app.post('/api/cards/:id/work-products', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    const input = createWorkProductSchema.parse(request.body);
    if (input.projectId && input.projectId !== card.projectId) return reply.code(400).send({ error: 'work_product_project_mismatch' });
    if (input.agentId) {
      const company = await agentCompanyId(input.agentId);
      if (company !== card.companyId) return reply.code(400).send({ error: 'work_product_agent_mismatch' });
    }
    if (input.taskRunId) {
      const [run] = await db.select({ cardId: taskRuns.cardId }).from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).limit(1);
      if (!run || run.cardId !== card.id) return reply.code(400).send({ error: 'work_product_task_run_mismatch' });
    }
    const [row] = await db.insert(workProducts).values({
      companyId: card.companyId,
      cardId: card.id,
      projectId: input.projectId ?? card.projectId,
      agentId: input.agentId ?? card.assigneeId,
      taskRunId: input.taskRunId ?? null,
      type: input.type,
      title: input.title,
      summary: input.summary ?? null,
      url: input.url ?? null,
      repoProvider: input.repoProvider ?? null,
      repoUrl: input.repoUrl ?? null,
      branch: input.branch ?? null,
      commitSha: input.commitSha ?? null,
      pullRequestUrl: input.pullRequestUrl ?? null,
      metadata: input.metadata,
    }).returning();
    if (row) publishLiveEvent({ type: 'work_product.created', companyId: card.companyId, entityType: 'work_product', entityId: row.id, cardId: card.id, projectId: row.projectId });
    return reply.code(201).send(row);
  });
  app.post('/api/cards/:id/comments', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createCardCommentSchema.parse(request.body);
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    // Agent bearer path: a runtime with no session cookie leaving a plain
    // message on the conversation (the CSRF origin check already exempts
    // cookie-less requests). Control actions stay with humans; the caller
    // identity comes from the token, never from input.agentId.
    const agentBearer = bearerFromRequest(request);
    if (looksLikeAgentToken(agentBearer)) {
      const callerAgent = await authenticateAgentToken(agentBearer);
      if (!callerAgent) return reply.code(401).send({ error: 'agent_token_invalid' });
      if (callerAgent.companyId !== card.companyId) return reply.code(403).send({ error: 'agent_company_mismatch' });
      if (input.action !== 'comment') return reply.code(403).send({ error: 'agent_comments_cannot_control_task' });
      const [agentComment] = await db.insert(cardComments).values({
        cardId: id,
        authorType: 'agent',
        authorId: null,
        agentId: callerAgent.id,
        body: input.body,
        action: 'comment',
        metadata: { via: 'agent_token' },
      }).returning();
      if (agentComment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: agentComment.id, cardId: card.id, projectId: card.projectId, action: 'comment' });
      await db.insert(taskLogs).values({ cardId: id, agentId: callerAgent.id, type: 'comment', status: 'success', message: `${callerAgent.name} added a comment.`, output: input.body });
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'agent', actorId: callerAgent.id, agentId: callerAgent.id, action: 'comment.comment', entityType: 'card', entityId: card.id, details: { commentId: agentComment?.id, authorAgentId: callerAgent.id, viaAgentToken: true } });
      if (agentComment) {
        try { await processMentionQuestions(card, { agentId: callerAgent.id, userId: null, name: callerAgent.name }, input.body, agentComment.id); }
        catch (error) { app.log.warn({ error, cardId: card.id, commentId: agentComment.id }, 'mention processing failed'); }
      }
      return reply.code(201).send(agentComment);
    }
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    if (input.agentId && !['comment', 'agent_note'].includes(input.action)) return reply.code(400).send({ error: 'agent_comments_cannot_control_task' });
    const [authorAgent] = input.agentId ? await db.select().from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1) : [];
    if (input.agentId && !authorAgent) return reply.code(404).send({ error: 'agent_not_found' });
    if (authorAgent && authorAgent.companyId !== card.companyId) return reply.code(400).send({ error: 'agent_company_mismatch' });
    const [delegateAssignee] = input.assigneeAgentId ? await db.select().from(agents).where(and(eq(agents.id, input.assigneeAgentId), isNull(agents.deletedAt))).limit(1) : [];
    if (input.action === 'delegate_to_agent' && !delegateAssignee) return reply.code(400).send({ error: 'delegate_assignee_required' });
    if (delegateAssignee && delegateAssignee.companyId !== card.companyId) return reply.code(400).send({ error: 'delegate_assignee_company_mismatch' });
    const requestedReviewerId = input.reviewerAgentId ?? card.assigneeId ?? card.reviewerId ?? null;
    const [delegateReviewer] = requestedReviewerId ? await db.select().from(agents).where(and(eq(agents.id, requestedReviewerId), isNull(agents.deletedAt))).limit(1) : [];
    if (requestedReviewerId && !delegateReviewer) return reply.code(400).send({ error: 'delegate_reviewer_not_found' });
    if (delegateReviewer && delegateReviewer.companyId !== card.companyId) return reply.code(400).send({ error: 'delegate_reviewer_company_mismatch' });
    const authorType = authorAgent ? 'agent' : 'user';
    const effectiveAction = input.action === 'delegate_to_agent' ? 'delegate_request' : authorAgent ? 'agent_note' : input.action;
    const effectiveAgentId = input.action === 'delegate_to_agent' ? delegateAssignee?.id : authorAgent?.id ?? card.assigneeId;
    const authorName = authorAgent ? authorAgent.name : actorLabel(user);
    const [comment] = await db.insert(cardComments).values({
      cardId: id,
      authorType,
      authorId: authorAgent ? null : user.id,
      agentId: authorAgent?.id ?? null,
      body: input.action === 'delegate_to_agent'
        ? [`Delegated from Message Board by ${authorName}.`, input.reviewerScope === 'final' ? 'FINAL REVIEWER' : 'PHASE REVIEWER', '', input.body].join('\n')
        : input.body,
      action: effectiveAction,
      assigneeAgentId: input.action === 'delegate_to_agent' ? delegateAssignee?.id ?? null : null,
      reviewerAgentId: input.action === 'delegate_to_agent' ? delegateReviewer?.id ?? null : null,
      reviewerScope: input.action === 'delegate_to_agent' ? input.reviewerScope ?? 'phase' : null,
      delegationStatus: input.action === 'delegate_to_agent' ? 'queued' : null,
      metadata: input.action === 'delegate_to_agent' ? { requestedByUserId: user.id } : {},
    }).returning();
    if (comment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: comment.id, cardId: card.id, projectId: card.projectId, action: effectiveAction });
    await db.insert(taskLogs).values({ cardId: id, agentId: effectiveAgentId, type: 'comment', status: 'success', message: `${authorName} added a ${effectiveAction} message.`, output: input.body });
    await db.insert(activityLog).values({ companyId: card.companyId, actorType: authorType, actorId: authorAgent?.id ?? user.id, userId: user.id, agentId: effectiveAgentId, action: `comment.${effectiveAction}`, entityType: 'card', entityId: card.id, details: { commentId: comment?.id, authorAgentId: authorAgent?.id } });
    // @mentions in the message wake the named agents (peer questions threaded
    // under this comment) and @client pings the human client. Delegation
    // requests are routed by the delegation pipeline instead. Delivery
    // problems are logged, never surfaced as a failed comment.
    if (comment && input.action !== 'delegate_to_agent') {
      try { await processMentionQuestions(card, { agentId: authorAgent?.id ?? null, userId: authorAgent ? null : user.id, name: authorName }, input.body, comment.id); }
      catch (error) { app.log.warn({ error, cardId: card.id, commentId: comment.id }, 'mention processing failed'); }
    }
    if (input.action === 'delegate_to_agent') {
      if (comment) await enqueueMessageTaskRun(comment, 'message');
    } else if (input.action === 'pause_agent') {
      if (card.assigneeId) await db.update(agents).set({ isBusy: false, isActive: false }).where(eq(agents.id, card.assigneeId));
      await db.update(kanbanCards).set({
        columnStatus: 'blocked',
        lastError: `Paused by ${actorLabel(user)}: ${input.body}`,
        executionLockId: null,
        executionLockedByAgentId: null,
        executionLockedAt: null,
        executionLockExpiresAt: null,
        activeHeartbeatRunId: null,
        updatedAt: new Date(),
      }).where(eq(kanbanCards.id, id));
      if (card.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'cancelled', error: `Paused by ${actorLabel(user)}`, completedAt: new Date() }).where(eq(heartbeatRuns.id, card.activeHeartbeatRunId));
      await db.update(taskRuns).set({ status: 'cancelled', error: `Paused by ${actorLabel(user)}`, completedAt: new Date(), updatedAt: new Date() }).where(and(eq(taskRuns.cardId, id), inArray(taskRuns.status, ['queued', 'running'])));
      await recordStageAction({
        cardId: id,
        agentId: card.assigneeId,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus: card.columnStatus ?? 'todo',
        toStatus: 'blocked',
        action: 'block',
        detail: `Stage changed from ${card.columnStatus ?? 'todo'} to blocked by ${actorLabel(user)}.`,
        logStatus: 'warning',
        metadata: { commentId: comment?.id },
      });
      publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'card.blocked' });
    } else if (input.action === 'continue_run') {
      if (card.assigneeId) await db.update(agents).set({ isActive: true, isBusy: false }).where(eq(agents.id, card.assigneeId));
      await db.update(kanbanCards).set({ columnStatus: 'todo', lastError: null, nextRunAt: null, runRetryState: {}, updatedAt: new Date() }).where(eq(kanbanCards.id, id));
      await recordStageAction({
        cardId: id,
        agentId: card.assigneeId,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus: card.columnStatus ?? 'todo',
        toStatus: 'todo',
        action: card.columnStatus === 'blocked' || card.columnStatus === 'cancelled' ? 'resume' : 'manual_move',
        detail: `Stage changed from ${card.columnStatus ?? 'todo'} to todo by ${actorLabel(user)}.`,
        metadata: { commentId: comment?.id },
      });
      publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'card.continue_run' });
    } else if (input.action === 'send_to_agent') {
      await db.insert(taskLogs).values({ cardId: id, agentId: card.assigneeId, type: 'comment', status: 'queued', message: 'Comment queued for agent context on the next run.', output: input.body });
    } else if (input.action === 'escalate_to_reviewer') {
      const reviewerId = await resolveIndependentReviewerForCard(card, card.assigneeId);
      const nextStatus = reviewerId ? 'needs_review' : 'blocked';
      const reason = reviewerId
        ? `Escalated to reviewer by ${actorLabel(user)}.`
        : `Escalation requested by ${actorLabel(user)}, but no independent reviewer or manager is available.`;
      await db.update(taskRuns).set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        error: reason,
      }).where(and(eq(taskRuns.cardId, id), eq(taskRuns.kind, 'dispatch'), inArray(taskRuns.status, ['queued', 'running'])));
      if (card.activeHeartbeatRunId) await db.update(heartbeatRuns).set({ status: 'cancelled', error: reason, completedAt: new Date() }).where(eq(heartbeatRuns.id, card.activeHeartbeatRunId));
      if (card.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, card.assigneeId));
      await db.update(kanbanCards).set({
        columnStatus: nextStatus,
        reviewerId,
        reviewFeedback: input.body,
        lastError: reviewerId ? null : reason,
        executionLockId: null,
        executionLockedByAgentId: null,
        executionLockedAt: null,
        executionLockExpiresAt: null,
        activeHeartbeatRunId: null,
        updatedAt: new Date(),
      }).where(eq(kanbanCards.id, id));
      await recordStageAction({
        cardId: id,
        agentId: reviewerId ?? card.assigneeId,
        actor: { type: 'user', id: user.id, userId: user.id },
        fromStatus: card.columnStatus ?? 'todo',
        toStatus: nextStatus,
        action: reviewerId ? 'request_help' : 'block',
        detail: `Stage changed from ${card.columnStatus ?? 'todo'} to ${nextStatus} by ${actorLabel(user)}.`,
        logStatus: reviewerId ? 'success' : 'warning',
        metadata: { commentId: comment?.id, reviewerId, reason },
      });
      await db.insert(taskLogs).values({ cardId: id, agentId: reviewerId ?? card.assigneeId, type: 'escalation', status: reviewerId ? 'queued' : 'failed', message: reason, output: input.body });
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: reviewerId ?? card.assigneeId, action: reviewerId ? 'card.escalated_to_reviewer' : 'card.escalation_blocked', entityType: 'card', entityId: card.id, details: { commentId: comment?.id, reviewerId, reason } });
      publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: reviewerId ? 'card.escalated_to_reviewer' : 'card.escalation_blocked' });
      if (reviewerId) await enqueueTaskRun(id, 'review', 'manual', user.id);
    }
    return reply.code(201).send(comment);
  });
  app.post('/api/cards/:id/run', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    try { return reply.code(202).send(await enqueueTaskRun(card.id, 'dispatch', 'manual', user.id)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'dispatch_enqueue_failed' }); }
  });
  app.post('/api/cards/:id/review', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    try { return reply.code(202).send(await enqueueTaskRun(card.id, 'review', 'manual', user.id)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'review_enqueue_failed' }); }
  });
  app.post('/api/cards/:id/decompose', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    return reply.code(410).send({
      error: 'child_cards_disabled',
      message: 'This endpoint no longer splits cards. Agents split through report.children; humans create child cards with POST /api/cards and parentCardId; same-card help goes through Message Board DELEGATE records.',
    });
  });
  app.get('/api/cards/:id/assignment-history', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
    return db.select().from(activityLog).where(and(
      eq(activityLog.entityType, 'card'),
      eq(activityLog.entityId, card.id),
      inArray(activityLog.action, ['card.assignee_changed', 'card.auto_assigned']),
    )).orderBy(desc(activityLog.createdAt)).limit(limit);
  });

  app.get('/api/agents', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    const query = request.query as { companyId?: string; view?: string };
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    if (query.view === 'labels') return db.select({ id: agents.id, name: agents.name, companyId: agents.companyId }).from(agents).where(and(
      query.companyId ? eq(agents.companyId, query.companyId) : inArray(agents.companyId, access.companyIds),
      isNull(agents.deletedAt),
    )).orderBy(agents.name);
    const rows = await db.select().from(agents).where(and(
      query.companyId ? eq(agents.companyId, query.companyId) : inArray(agents.companyId, access.companyIds),
      isNull(agents.deletedAt),
    ));
    return rows.map(redactAgent);
  });
  app.post('/api/agents', async (request, reply) => {
    const input = createAgentSchema.parse(request.body);
    const companyId = await resolveMutationCompany(request, reply, input.companyId); if (!companyId) return reply;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    try { await ensureCompanyReferences(companyId, { departmentId: input.departmentId, positionId: input.positionId, bossId: input.bossId, runtimeId: input.runtimeId, adapterType: input.adapterType }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' }); }
    const [agent] = await db.insert(agents).values({ companyId, departmentId: input.departmentId ?? null, positionId: input.positionId ?? null, slug: input.slug, name: input.name, role: input.role, title: input.title, soul: input.soul ?? null, adapterType: input.adapterType, adapterConfig: input.adapterConfig ?? {}, runtimeId: input.runtimeId ?? null, hermesProfile: input.hermesProfile, bossId: input.bossId ?? null, capabilities: input.capabilities ?? [], memoryConfig: input.memoryConfig ?? {}, maxConcurrent: input.maxConcurrent ?? 1, defaultTimeoutSeconds: input.defaultTimeoutSeconds ?? null, budgetPerTask: input.budgetPerTask?.toString(), budgetMonthly: input.budgetMonthly?.toString() }).returning();
    if (agent) await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.created', entityType: 'agent', entityId: agent.id, details: { name: agent.name, adapterType: agent.adapterType } });
    // Best-effort Gitea identity at birth; a failure here is recoverable later
    // via POST /api/agents/:id/gitea and must not fail agent creation.
    const giteaAtCreate = giteaConfigFromEnv();
    if (agent && giteaAtCreate) {
      try { await ensureGiteaAgentAccount(giteaAtCreate, agent); }
      catch (error) { app.log.warn({ error, agentId: agent.id }, 'gitea account provisioning at agent creation failed'); }
    }
    return reply.code(201).send(agent ? redactAgent(agent) : agent);
  });
  app.delete('/api/agents/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, agent.companyId, 'operator'); if (!user) return reply;
    await db.update(kanbanCards).set({ assigneeId: null }).where(eq(kanbanCards.assigneeId, id));
    await db.update(kanbanCards).set({ reviewerId: null }).where(eq(kanbanCards.reviewerId, id));
    await db.update(agents).set({ bossId: null }).where(eq(agents.bossId, id));
    await db.update(agents).set({
      isActive: false,
      isBusy: false,
      slug: `${agent.slug}-deleted-${id.slice(0, 8)}`,
      deletedAt: new Date(),
    }).where(eq(agents.id, id));
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'agent.deleted', entityType: 'agent', entityId: id, details: { name: agent.name } });
    return { ok: true };
  });
  // Per-agent token lifecycle. The raw token is returned exactly once, from
  // the rotate that created it; afterwards only the preview is visible.
  app.post('/api/agents/:id/token', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const rotated = await rotateAgentToken(id);
    if (!rotated) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: id, action: 'agent.token_rotated', entityType: 'agent', entityId: id, details: { preview: previewAgentToken(rotated.token) } });
    return { ok: true, agentId: id, apiToken: rotated.token, apiTokenPreview: previewAgentToken(rotated.token), updatedAt: rotated.updatedAt };
  });
  app.delete('/api/agents/:id/token', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const revoked = await revokeAgentToken(id);
    if (!revoked) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: id, action: 'agent.token_revoked', entityType: 'agent', entityId: id, details: {} });
    return { ok: true, agentId: id };
  });
  app.post('/api/agents/:id/pause', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.paused', entityType: 'agent', entityId: agent.id, details: { name: agent.name } });
    return redactAgent(agent);
  });
  app.post('/api/agents/:id/resume', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.update(agents).set({ isActive: true }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.resumed', entityType: 'agent', entityId: agent.id, details: { name: agent.name } });
    return redactAgent(agent);
  });
  app.post('/api/agents/:id/maintenance', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    // Manual trigger skips idle/new-work checks but still respects paused,
    // busy, budget, and adapter-support guards inside runAgentMaintenance.
    const result = await runAgentMaintenance(app, agent, { source: 'manual', requestedByUserId: user.id });
    if (result.status === 'skipped') return reply.code(409).send({ error: result.reason ?? 'maintenance_skipped', result });
    if (result.status === 'failed') return reply.code(502).send({ error: result.reason ?? 'maintenance_failed', result });
    return { ok: true, result };
  });
  app.post('/api/agents/:id/reset-session', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.update(agents).set({ currentSessionId: null, isBusy: false }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await resetAdapterSessionsForAgent(id);
    await db.update(chatSessions).set({ agentSessionId: null, updatedAt: new Date() }).where(eq(chatSessions.agentId, id));
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.session_reset', entityType: 'agent', entityId: agent.id, details: { name: agent.name } });
    return redactAgent(agent);
  });
  app.put('/api/agents/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateAgentSchema.parse(request.body);
    const [existing] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const referenceInput: CompanyReferenceInput = { departmentId: input.departmentId, positionId: input.positionId, bossId: input.bossId };
    if (input.adapterType !== undefined || input.runtimeId !== undefined) {
      referenceInput.adapterType = input.adapterType ?? existing.adapterType;
      referenceInput.runtimeId = input.runtimeId === undefined ? existing.runtimeId : input.runtimeId;
    }
    try { await ensureCompanyReferences(existing.companyId, referenceInput); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' }); }
    const nextAdapterConfig = input.adapterConfig === undefined ? undefined : preserveRedactedSecrets(input.adapterConfig, existing.adapterConfig);
    const [agent] = await db.update(agents).set({
      name: input.name,
      slug: input.slug,
      role: input.role,
      title: input.title,
      soul: input.soul,
      departmentId: input.departmentId,
      positionId: input.positionId,
      adapterType: input.adapterType,
      adapterConfig: nextAdapterConfig,
      runtimeId: input.runtimeId,
      hermesProfile: input.hermesProfile,
      bossId: input.bossId,
      capabilities: input.capabilities,
      memoryConfig: input.memoryConfig,
      maxConcurrent: input.maxConcurrent,
      defaultTimeoutSeconds: input.defaultTimeoutSeconds,
      budgetPerTask: input.budgetPerTask?.toString(),
      budgetMonthly: input.budgetMonthly?.toString(),
    }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.updated', entityType: 'agent', entityId: agent.id, details: { name: agent.name, adapterType: agent.adapterType } });
    return redactAgent(agent);
  });

  app.get('/api/agent-runtimes', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    const query = request.query as { companyId?: string };
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const rows = await db.select().from(agentRuntimes).where(query.companyId ? eq(agentRuntimes.companyId, query.companyId) : inArray(agentRuntimes.companyId, access.companyIds)).orderBy(desc(agentRuntimes.createdAt));
    return rows.map(redactRuntime);
  });
  app.get('/api/agent-runtimes/health', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    const [runtimeRows, agentRows, recentRuns] = await Promise.all([
      db.select().from(agentRuntimes).where(inArray(agentRuntimes.companyId, access.companyIds)).orderBy(desc(agentRuntimes.createdAt)),
      db.select().from(agents).where(inArray(agents.companyId, access.companyIds)),
      db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.companyId, access.companyIds)).orderBy(desc(heartbeatRuns.createdAt)).limit(300),
    ]);
    return runtimeRows.map((runtime) => {
      const attachedAgents = agentRows.filter((agent) => agent.runtimeId === runtime.id);
      const attachedIds = new Set(attachedAgents.map((agent) => agent.id));
      const run = recentRuns.find((item) => item.agentId && attachedIds.has(item.agentId));
      const activeAgents = attachedAgents.filter((agent) => agent.isActive !== false);
      const busyAgents = attachedAgents.filter((agent) => agent.isBusy);
      const failedRecently = run?.status === 'failed';
      return {
        runtimeId: runtime.id,
        name: runtime.name,
        adapterType: runtime.adapterType,
        status: runtime.isActive === false ? 'disabled' : failedRecently ? 'degraded' : busyAgents.length > 0 ? 'busy' : 'ready',
        isActive: runtime.isActive !== false,
        agents: attachedAgents.length,
        activeAgents: activeAgents.length,
        busyAgents: busyAgents.length,
        lastRunAt: run?.completedAt ?? run?.startedAt ?? null,
        lastRunStatus: run?.status ?? null,
        lastError: run?.error ?? null,
        capabilities: runtime.adapterType === 'hermes-ssh'
          ? ['ssh', 'hermes-cli', 'stdout-capture']
          : runtime.adapterType === 'hermes-gateway'
            ? ['http-dispatch', 'polling']
            : runtime.adapterType === 'codex-app'
              ? ['codex-app-server', 'json-rpc', 'thread-turn-session']
              : ['webhook'],
      };
    });
  });
  app.post('/api/agent-runtimes', async (request, reply) => {
    const input = createAgentRuntimeSchema.parse(request.body);
    const companyId = await resolveMutationCompany(request, reply, input.companyId); if (!companyId) return reply;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [row] = await db.insert(agentRuntimes).values({
      ...input,
      companyId,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot) ?? null,
      localScratchRoot: optionalText(input.localScratchRoot) ?? null,
      nfsMountRoot: optionalText(input.nfsMountRoot) ?? null,
    }).returning();
    return reply.code(201).send(row ? redactRuntime(row) : row);
  });
  app.put('/api/agent-runtimes/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateAgentRuntimeSchema.parse(request.body);
    const [existing] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, id)).limit(1);
    if (!existing?.companyId) return reply.code(404).send({ error: 'runtime_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'runtime_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const nextConfig = input.config === undefined ? undefined : preserveRedactedSecrets(input.config, existing.config);
    const [row] = await db.update(agentRuntimes).set({
      name: input.name,
      adapterType: input.adapterType,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot),
      localScratchRoot: optionalText(input.localScratchRoot),
      nfsMountRoot: optionalText(input.nfsMountRoot),
      config: nextConfig,
      isActive: input.isActive,
      updatedAt: new Date(),
    }).where(eq(agentRuntimes.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'runtime_not_found' });
    return redactRuntime(row);
  });
  app.delete('/api/agent-runtimes/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, id)).limit(1);
    if (!runtime?.companyId) return reply.code(404).send({ error: 'runtime_not_found' });
    const user = await requireCompanyRole(request, reply, runtime.companyId, 'operator'); if (!user) return reply;
    await db.update(agents).set({ runtimeId: null }).where(eq(agents.runtimeId, id));
    await db.delete(agentRuntimes).where(eq(agentRuntimes.id, id));
    return { ok: true };
  });

  app.post('/api/agents/:id/test-connection', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, agent.companyId, 'operator'); if (!user) return reply;
    const fingerprint = await setupConnectionFingerprint(id);
    try {
      const adapter = getAdapter(agent.adapterType ?? 'hermes-ssh');
      const executionAgent = await buildExecutionAgent(agent);
      const task = { id: 'test', title: 'Connection test', body: 'Return OK.', timeoutSeconds: 300 };
      await recordPromptLog({
        companyId: agent.companyId,
        agentId: agent.id,
        source: 'test',
        adapterType: agent.adapterType ?? 'hermes-ssh',
        title: task.title,
        prompt: promptSnapshotForAdapter(executionAgent, task),
        metadata: { requestedByUserId: user.id, megacorpsPromptChars: task.body.length },
      });
      const result = await adapter.dispatch(executionAgent, task);
      if (fingerprint) await recordSetupConnectionCheck(id, fingerprint, result.success === true && !result.needsInput, 'execution');
      return result;
    }
    catch (error) { if (fingerprint) await recordSetupConnectionCheck(id, fingerprint, false, 'execution'); return reply.code(502).send({ error: error instanceof Error ? error.message : 'connection_failed' }); }
  });

  app.get('/api/projects', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const rows = await db.select().from(projects).where(and(query.companyId ? eq(projects.companyId, query.companyId) : inArray(projects.companyId, access.companyIds), isNull(projects.deletedAt))).orderBy(desc(projects.createdAt));
    return rows.map(redactProject);
  });
  app.post('/api/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const companyId = await resolveMutationCompany(request, reply, input.companyId); if (!companyId) return reply;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    // Built-in Gitea provisioning: a gitea-local project gets its org and repo
    // created (and every active company agent added as a collaborator) before
    // the row is written, so the repoUrl is real from the very first dispatch.
    let provisionedRepoUrl: string | null = null;
    if (input.repoProvider === 'gitea-local' && !input.repoUrl) {
      const gitea = giteaConfigFromEnv();
      if (!gitea) return reply.code(503).send({ error: 'gitea_not_configured', detail: 'Set GITEA_URL (and admin credentials) to use the built-in Gitea provider.' });
      try {
        const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
        if (!company) return reply.code(404).send({ error: 'company_not_found' });
        const orgSlug = await ensureGiteaOrg(gitea, company);
        const repo = await ensureGiteaRepo(gitea, orgSlug, { name: input.name }, { defaultBranch: input.defaultBranch });
        const companyAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
        for (const companyAgent of companyAgents) {
          try {
            const account = await ensureGiteaAgentAccount(gitea, companyAgent);
            await addGiteaCollaborator(gitea, orgSlug, repo.repoSlug, account.username);
          } catch (error) {
            app.log.warn({ error, agentId: companyAgent.id }, 'gitea agent provisioning failed; agent can be provisioned later via POST /api/agents/:id/gitea');
          }
        }
        try {
          await ensureGiteaRepoWebhook(gitea, orgSlug, repo.repoSlug, giteaWebhookCallbackUrl(process.env, await ensureGiteaWebhookToken()));
        } catch (error) {
          app.log.warn({ error }, 'gitea webhook registration failed; push events will not reach MegaCorps');
        }
        provisionedRepoUrl = repo.cloneUrl;
      } catch (error) {
        return reply.code(502).send({ error: 'gitea_provisioning_failed', detail: error instanceof Error ? error.message : 'unknown Gitea error' });
      }
    }
    const completionRequiresMerge = input.completionRequiresMerge ?? input.repoProvider === 'gitea-local';
    const autoMergeAfterApproval = input.autoMergeAfterApproval ?? (Boolean(provisionedRepoUrl) && completionRequiresMerge);
    const policy = { ...input, companyId, repoUrl: input.repoUrl ?? provisionedRepoUrl, completionRequiresMerge, autoMergeAfterApproval };
    const managedRepoFullName = autoMergeAfterApproval ? optInManagedBinding(policy) : null;
    const mergeReadiness = autoMergeAfterApproval ? await inspectManagedProject({ ...policy, managedRepoFullName }, { establish: true }) : null;
    const [row] = await db.insert(projects).values({
      companyId,
      name: input.name,
      description: input.description,
      repoProvider: input.repoProvider,
      repoUrl: input.repoUrl ?? provisionedRepoUrl,
      workPath: input.workPath || null,
      defaultBranch: input.defaultBranch,
      protectedBranches: input.protectedBranches,
      workBranchPattern: input.workBranchPattern,
      pullBeforeRun: input.pullBeforeRun,
      pushAfterRun: input.pushAfterRun,
      completionPolicy: input.completionPolicy,
      // Merge closure (§19): the bundled Gitea is the version control MegaCorps
      // administers, so a new gitea-local project defaults to the merge gate;
      // every other provider keeps today's behaviour unless asked.
      completionRequiresMerge,
      autoMergeAfterApproval,
      managedRepoFullName,
      mergeReadiness,
      setupCommand: input.setupCommand ?? null,
      testCommand: input.testCommand ?? null,
      runtimeServices: input.runtimeServices,
      workspacePathHint: input.workspacePathHint ?? null,
      publishRepoUrl: input.publishRepoUrl ?? null,
      publishToken: input.publishToken ?? null,
    }).returning();
    if (row) publishLiveEvent({ type: 'project.created', companyId: row.companyId, entityType: 'project', entityId: row.id });
    return reply.code(201).send(row ? redactProject(row) : row);
  });
  app.get('/api/projects/:id/merge-readiness', async (request, reply) => {
    const [project] = await db.select().from(projects).where(and(eq(projects.id, (request.params as { id: string }).id), isNull(projects.deletedAt))).limit(1);
    if (!project) return reply.code(404).send({ error: 'project_not_found' });
    if (!(await requireVisibleCompany(request, reply, project.companyId))) return reply;
    return { autoMergeAfterApproval: project.autoMergeAfterApproval, completionRequiresMerge: project.completionRequiresMerge, ...(await inspectManagedProject(project)) };
  });
  app.get('/api/cards/:id/merge-intents', async (request, reply) => {
    const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, (request.params as { id: string }).id)).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    if (!(await requireVisibleCompany(request, reply, card.companyId))) return reply;
    return db.select().from(mergeIntents).where(eq(mergeIntents.cardId, card.id));
  });
  app.put('/api/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateProjectSchema.parse(request.body);
    const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'project_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'project_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const policy = { ...existing, ...input };
    const managedRepoFullName = input.autoMergeAfterApproval === true ? optInManagedBinding(policy) : existing.managedRepoFullName;
    const mergeReadiness = policy.autoMergeAfterApproval ? await inspectManagedProject({ ...policy, managedRepoFullName }, { establish: input.autoMergeAfterApproval === true }) : null;
    const [row] = await retryMergeGateWrite(() => db.update(projects).set({
      name: input.name,
      description: input.description,
      repoProvider: input.repoProvider,
      repoUrl: input.repoUrl,
      workPath: input.workPath === undefined ? undefined : input.workPath || null,
      defaultBranch: input.defaultBranch,
      protectedBranches: input.protectedBranches,
      workBranchPattern: input.workBranchPattern,
      pullBeforeRun: input.pullBeforeRun,
      pushAfterRun: input.pushAfterRun,
      completionPolicy: input.completionPolicy,
      completionRequiresMerge: input.completionRequiresMerge,
      autoMergeAfterApproval: input.autoMergeAfterApproval,
      managedRepoFullName,
      mergeReadiness,
      setupCommand: input.setupCommand,
      testCommand: input.testCommand,
      runtimeServices: input.runtimeServices,
      workspacePathHint: input.workspacePathHint,
      publishRepoUrl: input.publishRepoUrl,
      publishToken: input.publishToken === '[redacted]' ? existing.publishToken : input.publishToken,
      updatedAt: new Date(),
    }).where(eq(projects.id, id)).returning());
    if (!row) return reply.code(404).send({ error: 'project_not_found' });
    publishLiveEvent({ type: 'project.updated', companyId: row.companyId, entityType: 'project', entityId: row.id });
    return redactProject(row);
  });
  // Deleting a project used to be a hard delete gated on the project being
  // completely empty, so any project that had ever run a task was permanently
  // undeletable. It is now an archive: reversible from the trash, and nothing
  // referencing it is destroyed. ?purge=true still does the irreversible
  // delete, and keeps the emptiness check for exactly that reason.
  app.delete('/api/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const purge = (request.query as { purge?: string }).purge === 'true';
    const [existing] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'project_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, purge ? 'admin' : 'operator'); if (!user) return reply;

    if (!purge) {
      const now = new Date();
      await retryMergeGateWrite(() => db.update(projects).set({ deletedAt: now, updatedAt: now }).where(eq(projects.id, id)));
      await db.insert(activityLog).values({ companyId: existing.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'project.archived', entityType: 'project', entityId: id, details: { name: existing.name } });
      publishLiveEvent({ type: 'project.deleted', companyId: existing.companyId, entityType: 'project', entityId: id });
      return { ok: true, archived: true };
    }

    const [
      [cardUsage],
      [workProductUsage],
      [chatSessionUsage],
      [costUsage],
      [promptLogUsage],
      [workspaceFileUsage],
    ] = await Promise.all([
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(kanbanCards).where(and(eq(kanbanCards.projectId, id), isNull(kanbanCards.deletedAt))),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(workProducts).where(eq(workProducts.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(chatSessions).where(eq(chatSessions.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(costEvents).where(eq(costEvents.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(promptLogs).where(eq(promptLogs.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(projectWorkspaceFiles).where(eq(projectWorkspaceFiles.projectId, id)),
    ]);
    const blocking = Object.entries({
      cards: cardUsage?.count ?? 0,
      workProducts: workProductUsage?.count ?? 0,
      chatSessions: chatSessionUsage?.count ?? 0,
      costEvents: costUsage?.count ?? 0,
      promptLogs: promptLogUsage?.count ?? 0,
      workspaceFiles: workspaceFileUsage?.count ?? 0,
    }).filter(([, count]) => Number(count) > 0);
    if (blocking.length > 0) return reply.code(409).send({ error: 'project_not_empty', blocking: Object.fromEntries(blocking) });
    await retryMergeGateWrite(() => db.transaction(async (tx) => {
      await tx.delete(goals).where(eq(goals.projectId, id));
      await tx.delete(projects).where(eq(projects.id, id));
    }));
    publishLiveEvent({ type: 'project.deleted', companyId: existing.companyId, entityType: 'project', entityId: id });
    return { ok: true };
  });
  app.get('/api/goals', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; departmentId?: string; projectId?: string; scope?: 'company' | 'department' | 'project' };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(goals.companyId, query.companyId) : inArray(goals.companyId, access.companyIds),
      query.scope === 'company' ? isNull(goals.departmentId) : undefined,
      query.scope === 'company' ? isNull(goals.projectId) : undefined,
      query.scope === 'department' ? drizzleSql`${goals.departmentId} IS NOT NULL` : undefined,
      query.scope === 'project' ? drizzleSql`${goals.projectId} IS NOT NULL` : undefined,
      query.departmentId ? eq(goals.departmentId, query.departmentId) : undefined,
      query.projectId ? eq(goals.projectId, query.projectId) : undefined,
    ].filter(Boolean);
    return db.select().from(goals).where(filters.length ? and(...filters) : undefined).orderBy(desc(goals.createdAt));
  });
  app.post('/api/goals', async (request, reply) => {
    const input = createGoalSchema.parse(request.body);
    const companyId = await resolveMutationCompany(request, reply, input.companyId); if (!companyId) return reply;
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    if (input.departmentId && input.projectId) return reply.code(400).send({ error: 'goal_scope_conflict' });
    try {
      await ensureCompanyReferences(companyId, { departmentId: input.departmentId, projectId: input.projectId });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' });
    }
    const [row] = await db.insert(goals).values({ companyId, departmentId: input.departmentId ?? null, projectId: input.projectId ?? null, title: input.title, body: input.body }).returning();
    return reply.code(201).send(row);
  });
  app.get('/api/knowledge-docs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; tag?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(knowledgeDocs.companyId, query.companyId) : inArray(knowledgeDocs.companyId, access.companyIds),
      query.tag ? drizzleSql`${query.tag} = ANY(${knowledgeDocs.tags})` : undefined,
    ].filter(Boolean);
    return db.select().from(knowledgeDocs).where(filters.length ? and(...filters) : undefined).orderBy(desc(knowledgeDocs.updatedAt));
  });
  app.post('/api/knowledge-docs', async (request, reply) => {
    const input = createKnowledgeDocSchema.parse(request.body);
    const user = await requireCompanyRole(request, reply, input.companyId, 'operator'); if (!user) return reply;
    const [row] = await db.insert(knowledgeDocs).values({ ...input, createdBy: user.id }).returning();
    return reply.code(201).send(row);
  });
  app.put('/api/knowledge-docs/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = updateKnowledgeDocSchema.parse(request.body);
    const [existing] = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'knowledge_doc_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'knowledge_doc_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const { companyId: _companyId, ...updates } = input;
    const [row] = await db.update(knowledgeDocs).set({ ...updates, updatedAt: new Date() }).where(eq(knowledgeDocs.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'knowledge_doc_not_found' });
    return row;
  });
  app.delete('/api/knowledge-docs/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'knowledge_doc_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    await db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id));
    return { ok: true };
  });

  // A2A push notifications (Hermes gateway → MegaCorps). Reconciliation
  // accelerator only: correlates by contextId and clears a retry backoff so
  // the next cron tick re-dispatches immediately. It never completes runs or
  // moves cards directly — results flow through the single adapter channel.
  app.post('/api/a2a/push', async (request, reply) => {
    const event = parseA2aPushPayload(request.body);
    if (!event) return reply.code(400).send({ error: 'invalid_push_payload' });
    const [session] = event.contextId
      ? await db.select().from(adapterSessions).where(and(
        eq(adapterSessions.adapterType, 'a2a'),
        eq(adapterSessions.adapterSessionId, event.contextId),
      )).orderBy(desc(adapterSessions.updatedAt)).limit(1)
      : [];
    if (!session) return reply.code(202).send({ ok: true, matched: false });
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, session.agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(202).send({ ok: true, matched: false });
    const configValue = (key: string) => {
      const raw = (agent.adapterConfig as Record<string, unknown> | null)?.[key];
      return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    };
    const pushSecret = configValue('a2aPushSecret') ?? configValue('a2aBearerToken');
    if (pushSecret) {
      const header = request.headers['x-a2a-signature'];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!verifyA2aPushSignature(request.body, pushSecret, signature)) return reply.code(401).send({ error: 'invalid_push_signature' });
    }
    let accelerated = false;
    if (session.scopeType === 'card' && event.state && ['completed', 'input_required', 'failed'].includes(event.state)) {
      const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, session.scopeId), isNull(kanbanCards.deletedAt))).limit(1);
      if (card && card.columnStatus === 'todo' && card.nextRunAt && card.nextRunAt > new Date()) {
        await db.update(kanbanCards).set({ nextRunAt: null, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
        accelerated = true;
      }
    }
    await db.insert(activityLog).values({
      companyId: agent.companyId,
      actorType: 'system',
      actorId: 'a2a-push',
      agentId: agent.id,
      action: 'a2a.push_received',
      entityType: 'agent',
      entityId: agent.id,
      details: { taskId: event.taskId, contextId: event.contextId, state: event.state, scopeType: session.scopeType, scopeId: session.scopeId, accelerated, signed: Boolean(pushSecret) },
    });
    return { ok: true, matched: true, accelerated };
  });

  // Push and pull_request events from the bundled Gitea. Auth is a URL token
  // (set when the webhook is registered) rather than HMAC, because Fastify has
  // already consumed the raw body here; the token is random and intranet-only.
  // Merge closure (§19): after the activity record, the payload is routed to
  // the merge gate, which only recognises the exact head review authorized.
  app.post('/api/gitea/events', async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    const expected = await ensureGiteaWebhookToken();
    if (!token || !safeSecretEqual(token, expected)) return reply.code(401).send({ error: 'gitea_webhook_auth_required' });
    const header = request.headers['x-gitea-event'];
    const eventName = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase() || 'push';
    const body = request.body as { ref?: string; repository?: { full_name?: string }; commits?: Array<{ id?: string; message?: string }>; pusher?: { username?: string }; action?: string; number?: number; pull_request?: { number?: number; merged?: boolean; html_url?: string; head?: { sha?: string; ref?: string } | null; base?: { sha?: string; ref?: string } | null } | null } | null;
    const repoFullName = body?.repository?.full_name ?? 'unknown/unknown';
    const orgSlug = repoFullName.split('/')[0] ?? '';
    const [company] = await db.select().from(companies).where(eq(companies.slug, orgSlug)).limit(1);
    const companyId = company?.id ?? null;
    await db.insert(activityLog).values({
      companyId,
      actorType: 'system',
      actorId: 'gitea',
      action: eventName === 'pull_request' ? 'gitea.pull_request' : 'gitea.push',
      entityType: 'repository',
      entityId: repoFullName,
      details: eventName === 'pull_request'
        ? {
          repository: repoFullName,
          prAction: body?.action ?? null,
          pullRequest: body?.pull_request?.number ?? body?.number ?? null,
          merged: body?.pull_request?.merged ?? false,
          head: body?.pull_request?.head?.sha ?? null,
          base: body?.pull_request?.base?.ref ?? null,
        }
        : {
          repository: repoFullName,
          ref: body?.ref ?? null,
          commits: body?.commits?.length ?? 0,
          pusher: body?.pusher?.username ?? null,
          lastCommit: body?.commits?.[body.commits.length - 1]?.message?.slice(0, 200) ?? null,
        },
    });
    if (companyId) publishLiveEvent({ type: eventName === 'pull_request' ? 'gitea.pull_request' : 'gitea.push', companyId, entityType: 'repository', entityId: companyId });
    let merge: Awaited<ReturnType<typeof handleGiteaWebhookEvent>> = { event: eventName, matched: 0, outcomes: [] };
    try {
      merge = await handleGiteaWebhookEvent({ eventName, payload: body ?? {}, app });
    } catch (error) {
      app.log.warn({ error, repository: repoFullName, eventName }, 'gitea merge closure could not process the event');
    }
    return { ok: true, event: merge.event, matchedWaits: merge.matched, outcomes: merge.outcomes };
  });

  // Provision (or re-provision) the Gitea identity for one agent and grant it
  // write access to every gitea-local project repo in its company. Returns the
  // token so an operator can hand it to an externally-managed runtime; task
  // prompts inject it automatically either way.
  app.post('/api/agents/:id/gitea', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    const bearer = bearerFromRequest(request);
    let actorType: 'user' | 'agent' = 'user';
    let actorId: string;
    let userId: string | null = null;
    if (looksLikeAgentToken(bearer)) {
      const caller = await authenticateAgentToken(bearer);
      const decision = decideGiteaProvisionAuth(id, bearer, caller?.id ?? null);
      if ('error' in decision) return reply.code(decision.status).send({ error: decision.error });
      actorType = 'agent';
      actorId = id;
    } else {
      const user = await requireCompanyRole(request, reply, agent.companyId, 'operator'); if (!user) return reply;
      actorType = 'user';
      actorId = user.id;
      userId = user.id;
    }
    const gitea = giteaConfigFromEnv();
    if (!gitea) return reply.code(503).send({ error: 'gitea_not_configured' });
    try {
      const account = await ensureGiteaAgentAccount(gitea, agent);
      const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId)).limit(1);
      const giteaProjects = await db.select().from(projects).where(and(eq(projects.companyId, agent.companyId), eq(projects.repoProvider, 'gitea-local'), isNull(projects.deletedAt)));
      if (company) {
        const orgSlug = await ensureGiteaOrg(gitea, company);
        for (const project of giteaProjects) {
          const repo = await ensureGiteaRepo(gitea, orgSlug, { name: project.name }, { defaultBranch: project.defaultBranch ?? 'main' });
          await addGiteaCollaborator(gitea, orgSlug, repo.repoSlug, account.username);
        }
      }
      await db.insert(activityLog).values({ companyId: agent.companyId, actorType, actorId, userId, agentId: agent.id, action: 'agent.gitea_provisioned', entityType: 'agent', entityId: agent.id, details: { username: account.username, repos: giteaProjects.length } });
      return { ok: true, agentId: agent.id, username: account.username, token: account.token, repos: giteaProjects.length };
    } catch (error) {
      return reply.code(502).send({ error: 'gitea_provisioning_failed', detail: error instanceof Error ? error.message : 'unknown Gitea error' });
    }
  });

  app.post('/api/webhook/task-complete', async (request, reply) => {
    const headerSecret = request.headers['x-megacorps-webhook-secret'];
    const bearer = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : undefined;
    const providedSecret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;

    // A per-agent token authenticates the specific agent; the legacy shared
    // secret authenticates "some runtime of ours" with no identity. Prefer the
    // former — it makes the caller's identity trustworthy in logs and lets a
    // single compromised agent be revoked alone.
    let callerAgent: Awaited<ReturnType<typeof authenticateAgentToken>> = null;
    if (looksLikeAgentToken(bearer)) {
      callerAgent = await authenticateAgentToken(bearer);
      if (!callerAgent) return reply.code(401).send({ error: 'agent_token_invalid' });
    } else {
      const expectedSecret = await configuredWebhookSharedSecret();
      if (!expectedSecret) return reply.code(503).send({ error: 'webhook_secret_not_configured' });
      if (expectedSecret.length < 16) return reply.code(503).send({ error: 'webhook_secret_too_short' });
      if (!safeSecretEqual(providedSecret, expectedSecret) && !safeSecretEqual(bearer, expectedSecret)) return reply.code(401).send({ error: 'webhook_auth_required' });
    }
    const parsedBody = z.object({
      cardId: z.string().uuid(),
      taskRunId: z.string().uuid().optional(),
      idempotencyKey: z.string().uuid().optional(),
      status: z.string(),
      summary: z.string().optional(),
      output: z.string().optional(),
      costUsd: z.number().nonnegative().optional(),
      pollIntervalSeconds: z.number().int().min(30).max(86_400).nullable().optional(),
      workProducts: z.array(createWorkProductSchema).default([]),
      report: z.unknown().optional(),
    }).safeParse(request.body);
    if (!parsedBody.success) return reply.code(400).send({
      error: 'invalid_body',
      message: 'invalid_body: expected JSON body with cardId, status, and optional taskRunId, summary, output, costUsd, pollIntervalSeconds, workProducts. Example: { "cardId": "<uuid>", "taskRunId": "<task-run uuid>", "status": "done", "summary": "...", "output": "..." }',
      issues: parsedBody.error.issues,
    });
    const [outputCard] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, parsedBody.data.cardId)).limit(1);
    if (!outputCard) return reply.code(404).send({ error: 'card_not_found' });
    if (callerAgent && callerAgent.companyId !== outputCard.companyId) return reply.code(403).send({ error: 'company_access_denied' });
    parsedBody.data = await sanitizeCompanyOutput(outputCard.companyId, parsedBody.data);
    const normalizedResult = normalizeAgentResult({ output: [parsedBody.data.summary, parsedBody.data.output].filter(Boolean).join('\n\n'), report: parsedBody.data.report, workProducts: parsedBody.data.workProducts });
    const body = { ...parsedBody.data, report: normalizedResult.report ?? undefined, workProducts: normalizedResult.workProducts };
    const taskRunId = body.taskRunId ?? body.idempotencyKey;
    let requestedStatus = normalizeCardStatus(body.status);
    if (!requestedStatus) return reply.code(400).send({
      error: 'invalid_status',
      message: `invalid_status: "${body.status}" is not allowed. Use one of: ${cardStatuses.join(', ')}. Use status="in_progress" with a DELEGATE block when delegating; use status="needs_review" when you need reviewer guidance.`,
      allowed: cardStatuses,
      legacyAliases: { backlog: 'todo' },
    });
    if (normalizedResult.outcome === 'permission' || normalizedResult.outcome === 'failed' || normalizedResult.outcome === 'rejected') requestedStatus = 'blocked';
    else if (normalizedResult.outcome === 'input_required') requestedStatus = 'needs_review';
    else if (normalizedResult.source === 'report' && normalizedResult.outcome === 'progress') requestedStatus = 'in_progress';
    // A completed report describes the agent's work, not completion of an
    // explicitly requested external/client/brainstorm wait or other stop.
    else if (normalizedResult.source === 'report' && ['done', 'in_review', 'in_progress'].includes(requestedStatus)) requestedStatus = requestedStatus === 'in_review' ? 'in_review' : 'done';
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, body.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    // An agent token is scoped to its own company; a report against another
    // company's card is refused outright, whatever the payload claims.
    if (callerAgent && callerAgent.companyId !== card.companyId) {
      return reply.code(403).send({ error: 'agent_company_mismatch', detail: 'This agent token belongs to a different company than the card.' });
    }
    if (callerAgent) {
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'agent', actorId: callerAgent.id, agentId: callerAgent.id, action: 'webhook.agent_report', entityType: 'card', entityId: card.id, details: { status: body.status, taskRunId: taskRunId ?? null, viaAgentToken: true } });
    }
    if (parsedBody.data.workProducts.some((product) => product.projectId && product.projectId !== card.projectId)) return reply.code(400).send({ error: 'work_product_project_mismatch' });
    if (body.workProducts.some((product) => product.repoUrl) && card.projectId) {
      const [projectForRepo] = await db.select({ repoUrl: projects.repoUrl }).from(projects).where(and(eq(projects.id, card.projectId), isNull(projects.deletedAt))).limit(1);
      if (projectForRepo?.repoUrl && body.workProducts.some((product) => product.repoUrl && !gitRemoteMatchesProjectRepo(product.repoUrl, projectForRepo.repoUrl))) {
        return reply.code(400).send({ error: 'work_product_repo_mismatch', detail: 'workProduct.repoUrl must match project.repo_url (same org/repo).' });
      }
    }
    const [webhookTaskRun] = taskRunId ? await db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1) : [];
    if (taskRunId && !webhookTaskRun) return reply.code(404).send({ error: 'task_run_not_found' });
    if (webhookTaskRun && webhookTaskRun.cardId !== card.id) return reply.code(409).send({ error: 'task_run_card_mismatch' });
    if ((webhookTaskRun && !['queued', 'running'].includes(webhookTaskRun.status)) || (!['message', 'message_review', 'panel_review'].includes(webhookTaskRun?.kind ?? '') && ['done', 'cancelled'].includes(card.columnStatus ?? ''))) return { ok: true, stale: true, cardId: card.id, taskRunId, newStatus: card.columnStatus };
    const protocolGuidance = webhookTaskRun?.kind === 'review' && Boolean(protocolHelpOrigin(card, webhookTaskRun.agentId ?? ''));
    if (normalizedResult.outcome === 'invalid' || (webhookTaskRun?.kind === 'review' && (normalizedResult.verdictError || (!protocolGuidance && normalizedResult.source === 'report' && normalizedResult.outcome === 'completed' && !normalizedResult.verdict)))) {
      const reason = normalizedResult.reason ?? normalizedResult.verdictError ?? 'review_verdict_missing: return one evidence-supported current verdict.';
      const actorId = webhookTaskRun?.agentId ?? callerAgent?.id ?? card.assigneeId;
      const [actor] = actorId ? await db.select().from(agents).where(and(eq(agents.id, actorId), eq(agents.companyId, card.companyId), isNull(agents.deletedAt))).limit(1) : [];
      if (actor && (!webhookTaskRun || ['dispatch', 'review'].includes(webhookTaskRun.kind))) await sendAgentFeedbackAndRequeue({ card, agent: actor, kind: webhookTaskRun?.kind === 'review' ? 'review' : 'dispatch', message: reason, taskRunId, runId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId, result: { sessionId: actor.currentSessionId ?? '' } });
      return reply.code(409).send({ error: 'agent_report_invalid', message: reason });
    }
    const reviewRevisionRequested = webhookTaskRun?.kind === 'review' && normalizedResult.verdict === 'revision_requested';
    if (webhookTaskRun?.kind === 'review' && !protocolGuidance) {
      if (normalizedResult.verdictError || (normalizedResult.source === 'report' && normalizedResult.outcome === 'completed' && !normalizedResult.verdict)) return reply.code(409).send({ error: 'review_verdict_invalid', message: normalizedResult.verdictError ?? 'review_verdict_missing: return an explicit current verdict in your report.' });
      if (reviewRevisionRequested && normalizedResult.outcome === 'completed') requestedStatus = 'todo';
      else if (normalizedResult.verdict === 'escalate' && normalizedResult.outcome === 'completed') requestedStatus = 'needs_review';
    }
    if (webhookTaskRun && (webhookTaskRun.kind === 'message' || webhookTaskRun.kind === 'message_review')) {
      try {
        return await completeMessageTaskRunFromWebhook(webhookTaskRun.id, {
          status: requestedStatus,
          summary: body.summary ?? null,
          output: body.output ?? null,
          costUsd: body.costUsd,
          report: body.report ?? null,
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'message_task_webhook_failed' });
      }
    }
    // A blind review slot answered through the webhook: same slot logic as the
    // adapter path; a malformed answer is a 400 and the slot stays open.
    if (webhookTaskRun && webhookTaskRun.kind === 'panel_review') {
      try {
        return await completePanelReviewFromWebhook(webhookTaskRun.id, {
          status: requestedStatus,
          summary: body.summary ?? null,
          output: body.output ?? null,
          costUsd: body.costUsd,
          report: body.report ?? null,
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'panel_review_webhook_failed' });
      }
    }
    const executionLog = agentResultExecutionLog(body.summary ? `${body.summary}\n\n${body.output || ''}` : (body.output || ''), normalizedResult);
    const actorAgentId = webhookTaskRun?.agentId ?? callerAgent?.id ?? card.assigneeId;
    const blockedResult = ['permission', 'failed', 'rejected'].includes(normalizedResult.outcome);
    const structuredDelegations = blockedResult ? [] : body.report?.delegations ?? null;
    const handoffItems = structuredDelegations?.filter((item) => item.mode === 'handoff') ?? [];
    if (handoffItems.length > 0) {
      const [handoffAgent] = actorAgentId ? await db.select().from(agents).where(and(eq(agents.id, actorAgentId), eq(agents.companyId, card.companyId), isNull(agents.deletedAt))).limit(1) : [];
      if (!handoffAgent) return reply.code(409).send({ error: 'handoff_agent_unknown', message: 'handoff_agent_unknown: the reporting agent could not be resolved for this card.' });
      if (handoffItems.length > 1 || (structuredDelegations?.length ?? 0) > 1) {
        return reply.code(409).send({ error: 'handoff_must_be_sole_delegation', message: 'handoff_must_be_sole_delegation: A handoff transfers card ownership; send it as the only delegation item.' });
      }
      try {
        const updated = await performWebhookHandoff(card, handoffAgent, handoffItems[0]!, {
          taskRunId,
          heartbeatRunId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId,
          sourceOutput: executionLog,
          costUsd: body.costUsd,
        });
        return { ok: true, cardId: card.id, taskRunId: taskRunId ?? null, newStatus: updated.columnStatus, handoff: true, assigneeId: updated.assigneeId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'handoff_failed';
        return reply.code(409).send({ error: 'handoff_failed', message });
      }
    }
    const requestedDelegation = structuredDelegations
      ? structuredDelegations.map(delegationLineFromReportItem)
      : delegationItems(executionLog);
    const escalation = !blockedResult && isGuidanceEscalation(requestedStatus, executionLog);
    const escalationReviewerId = escalation ? await resolveIndependentReviewerForCard(card, actorAgentId) : null;
    const guidanceDecision = webhookCompletionDecision({
      requestedStatus,
      text: executionLog,
      reviewerId: escalationReviewerId,
      requiresApproval: card.requiresApproval === true,
    });
    const topLevelGuidanceAccepted = guidanceDecision.topLevelGuidanceAccepted;
    const preDelegationStatus = requestedDelegation.length > 0 ? 'in_progress' : escalation ? guidanceDecision.nextStatus : requestedStatus;
    if (taskRunId && (requestedDelegation.length > 0 || preDelegationStatus !== 'in_progress')) {
      const [existingWebhook] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.entityId, card.id),
        eq(activityLog.actorId, 'webhook'),
        ne(activityLog.action, 'webhook.task_in_progress'),
        drizzleSql`${activityLog.details}->>'taskRunId' = ${taskRunId}`,
      )).limit(1);
      if (existingWebhook) return { ok: true, duplicate: true, cardId: body.cardId, taskRunId, newStatus: card.columnStatus };
    }
    const [actorAgent] = actorAgentId ? await db.select().from(agents).where(and(eq(agents.id, actorAgentId), eq(agents.companyId, card.companyId), isNull(agents.deletedAt))).limit(1) : [];
    const [productProject] = card.projectId ? await db.select().from(projects).where(and(eq(projects.id, card.projectId), isNull(projects.deletedAt))).limit(1) : [];
    await persistAgentWorkProducts(card, actorAgentId, taskRunId ?? null, body.workProducts, productProject, normalizedResult.report);
    const protocolHelp = actorAgent && webhookTaskRun?.kind === 'review' ? await finishProtocolHelp(card, actorAgent.id, executionLog, taskRunId) : null;
    if (protocolHelp) {
      await completeTaskRun(taskRunId, { status: 'success', preserveCard: true, output: executionLog });
      if (protocolHelp.continueKind) await enqueueTaskRun(card.id, protocolHelp.continueKind, 'queue');
      return { ok: true, cardId: card.id, taskRunId, newStatus: protocolHelp.card.columnStatus };
    }
    if (!webhookTaskRun || ['dispatch', 'review'].includes(webhookTaskRun.kind)) await resetProtocolRepair(card.id, webhookTaskRun?.kind === 'review' ? 'review' : 'dispatch', normalizedResult, true, card, taskRunId);
    const webhookNotes = actorAgent && !blockedResult ? reportNotesFromOutput(executionLog, body.report ?? null) : [];
    if (actorAgent && webhookNotes.length) {
      try { await processReportNotes(card, actorAgent, webhookNotes); } catch (error) { app.log.warn({ error, cardId: card.id }, 'report note processing failed'); }
    }
    const webhookPeerMentions = actorAgent && !blockedResult ? peerMentionsFromOutput(executionLog, body.report ?? null) : [];
    if (actorAgent && webhookPeerMentions.length) {
      try { await processPeerMentions(card, actorAgent, webhookPeerMentions); } catch (error) { app.log.warn({ error, cardId: card.id }, 'peer mention processing failed'); }
    }
    const webhookChildren = actorAgent && !blockedResult ? childrenFromOutput(executionLog, body.report ?? null) : [];
    if (actorAgent && webhookChildren.length) {
      try {
        const split = await processChildSplits(card, actorAgent, webhookChildren);
        if (split.errors.length) { await sendAgentFeedbackAndRequeue({ card, agent: actorAgent, kind: 'dispatch', message: split.errors.join('\n'), taskRunId, runId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId, output: executionLog }); return reply.code(409).send({ error: 'child_split_rejected', message: split.errors.join('\n') }); }
      } catch (error) { await sendAgentFeedbackAndRequeue({ card, agent: actorAgent, kind: 'dispatch', message: String(error), taskRunId, runId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId, output: executionLog }); return reply.code(409).send({ error: 'child_split_rejected', message: String(error) }); }
    }
    // Client checkpoint: park the card and ask the client instead of completing.
    const webhookCheckpoint = actorAgent && !blockedResult ? await resolveClientCheckpointRequest(card, actorAgent, checkpointFromOutput(executionLog, body.report ?? null), normalizedResult.question) : null;
    if (webhookCheckpoint && actorAgent) {
      const parked = await finishRunWaitingOnClient(card, actorAgent, webhookCheckpoint, { taskRunId: taskRunId ?? null, heartbeatRunId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId ?? null, output: executionLog, costUsd: body.costUsd });
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'system', actorId: 'webhook', agentId: actorAgentId, action: 'webhook.client_checkpoint', entityType: 'card', entityId: card.id, details: { taskRunId, requestedStatus, approvalId: parked.approvalId } });
      publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: 'webhook.client_checkpoint' });
      return { ok: true, cardId: card.id, taskRunId: taskRunId ?? null, requestedStatus, newStatus: 'waiting_on_client', checkpointId: parked.approvalId };
    }
    // A reviewer reporting through the webhook: keep the author's score.
    if (actorAgent && webhookTaskRun?.kind === 'review') {
      const verdict = normalizedResult.verdict ?? (requestedStatus === 'done' || requestedStatus === 'in_review' ? 'approved' : requestedStatus === 'needs_review' || requestedStatus === 'blocked' ? 'escalate' : 'revision_requested');
      try { await recordReviewScore(card, actorAgent, verdict, executionLog, body.report?.score ?? null); } catch (error) { app.log.warn({ error, cardId: card.id }, 'review score recording failed'); }
    }
    // Brainstorm broadcast: open the round and park the card.
    const webhookBrainstorm = actorAgent && !blockedResult ? await resolveBrainstormRequest(card, actorAgent, brainstormFromOutput(executionLog, body.report ?? null)) : null;
    if (webhookBrainstorm && actorAgent) {
      const round = await finishRunWaitingOnBrainstorm(card, actorAgent, webhookBrainstorm, { taskRunId: taskRunId ?? null, heartbeatRunId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId ?? null, output: executionLog, costUsd: body.costUsd });
      await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'system', actorId: 'webhook', agentId: actorAgentId, action: 'webhook.brainstorm', entityType: 'card', entityId: card.id, details: { taskRunId, requestedStatus, round } });
      return { ok: true, cardId: card.id, taskRunId: taskRunId ?? null, requestedStatus, newStatus: 'waiting_on_brainstorm', brainstormRound: round };
    }
    if (requestedStatus === 'waiting_on_brainstorm') {
      return reply.code(400).send({ error: 'broadcast_required', message: 'broadcast_required: status="waiting_on_brainstorm" needs a report.broadcast { departments: [slugs], question }, and only the CEO or a department head who owns the card may open a round.' });
    }
    if (requestedStatus === 'waiting_on_client') {
      return reply.code(400).send({ error: 'checkpoint_required', message: 'checkpoint_required: status="waiting_on_client" needs a report.checkpoint { kind, question, options?, recommendation?, artifactRefs? }, and only the CEO or a department head who owns the card may ask the client.' });
    }
    let delegationError: string | null = null;
    let delegatedRows: Awaited<ReturnType<typeof createMessageDelegations>> = [];
    try {
      delegatedRows = actorAgent ? await createMessageDelegations(card, actorAgent, requestedDelegation, { reviewerScope: 'final', sourceTaskRunId: taskRunId ?? null, sourceOutput: executionLog }) : [];
    } catch (error) {
      delegationError = error instanceof Error ? error.message : 'delegation_failed';
    }
    const delegatedViaWebhook = delegatedRows.length > 0;
    const delegationFailed = requestedDelegation.length > 0 && !delegatedViaWebhook;
    const activeDirectReports = actorAgent ? await activeDirectReportsForAgent(card.companyId, actorAgent.id) : [];
    const requiredDelegation = actorAgent ? await collaborationDelegationRequirement(card, actorAgent.id, null) : { required: false, alreadyDelegated: false, reports: [] };
    const delegationFailureReason = delegationFailed ? delegationError ?? 'delegation_requested_but_no_available_direct_reports' : null;
    const delegationFailureGuidance = delegationFailed ? (collaborationModeRequiresDelegation(card) ? collaborationDelegationInstructions(activeDirectReports) : optionalDelegationInstructions(activeDirectReports)) : null;
    const delegationFailureMessage = delegationFailed ? `${delegationFailureReason}\n\n${delegationFailureGuidance}` : null;
    const structuralIssue = actorAgent && webhookTaskRun?.kind !== 'review' ? await structuralCompletionIssue(card, actorAgent.id, normalizedResult) : null;
    if (actorAgent && webhookTaskRun?.kind !== 'review' && normalizedResult.outcome === 'completed' && (requiredDelegation.required || structuralIssue || delegationFailed)) {
      const message = structuralIssue ?? delegationFailureMessage ?? 'structural_delegation_required: Route execution to eligible department heads/employees with scope and acceptance criteria.';
      const corrected = await sendAgentFeedbackAndRequeue({ card, agent: actorAgent, kind: 'dispatch', message, taskRunId, runId: webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId, output: executionLog, result: { sessionId: actorAgent.currentSessionId ?? '' } });
      return reply.code(409).send({ error: 'structural_delivery_required', message, cardId: card.id, newStatus: corrected.columnStatus });
    }
    // Blind review panel (§17): an author answering panel findings must
    // disposition every one of them (or escalate) before the run counts as a
    // fix; the errors come back synchronously so the agent can resend.
    const fixRound = actorAgent && !escalation && requestedDelegation.length === 0 && (requestedStatus === 'done' || requestedStatus === 'in_review') ? await openFixRound(card) : null;
    const fixEscalation = fixRound ? body.report?.escalation ?? null : null;
    if (fixRound && !fixEscalation) {
      const errors = dispositionErrors(fixRound.findings, body.report?.dispositions ?? []);
      if (errors.length > 0) {
        return reply.code(409).send({
          error: 'fix_dispositions_invalid',
          message: ['fix_dispositions_invalid: answer every open review finding before reporting completion.', ...errors, formatDispositionRules()].join('\n'),
          errors,
          findingKeys: fixRound.findings.map((finding) => finding.key),
          cardId: card.id,
          taskRunId,
        });
      }
    }
    const qualityReviewerId = !delegatedViaWebhook && !delegationFailed && !escalation && (requestedStatus === 'done' || requestedStatus === 'in_review')
      ? webhookTaskRun?.kind === 'review' ? null : actorAgentId ? await structuralReviewer(card.companyId, actorAgentId, card.reviewerId) : await resolveIndependentReviewerForCard(card, actorAgentId)
      : null;
    // Human approval is the last gate (§17.6): guidance with no reviewer, and
    // any requiresApproval card with no reviewer, wait for the client instead of auto-closing.
    const humanGate = !delegatedViaWebhook && !delegationFailed && !fixRound && (
      escalation
        ? guidanceDecision.humanGate
        : (requestedStatus === 'done' || requestedStatus === 'in_review') && !qualityReviewerId && card.requiresApproval === true
    );
    const requestedNextStatus = delegatedViaWebhook
      ? 'in_progress'
      : delegationFailed
        ? 'todo'
        : escalation
          ? guidanceDecision.nextStatus
          : fixRound || humanGate
            ? 'in_review'
            : completionStatusForQualityGate(requestedStatus, qualityReviewerId);
    const childBlock = await completionBlockedByChildren(card, requestedNextStatus);
    const mergePlan = !childBlock && requestedNextStatus === 'done' ? await planMergeGate({ ...card, executionLog: body.report ? JSON.stringify(body.report) : executionLog }) : null;
    const nextStatus = childBlock ? 'in_progress' : mergePlan ? mergeCompletionStatus(mergePlan) : requestedNextStatus;
    const completesRun = delegatedViaWebhook || delegationFailed || Boolean(childBlock) || nextStatus !== 'in_progress';
    const webhookAction = childBlock ? 'webhook.waiting_on_children' : delegatedViaWebhook ? 'webhook.message_delegated' : delegationFailed ? 'webhook.delegation_failed' : `webhook.task_${nextStatus}`;
    const updatedCard = await guardedCompletionUpdate(card, {
      columnStatus: nextStatus,
      rollupStatus: childBlock ? 'waiting_on_children' : nextStatus === 'done' ? 'done' : undefined,
      executionLog,
      reviewFeedback: reviewRevisionRequested ? body.report?.summary ?? executionLog : undefined,
      reviewerId: escalation ? escalationReviewerId : qualityReviewerId ?? undefined,
      costUsd: completesRun ? body.costUsd?.toString() : undefined,
      completedAt: nextStatus === 'done' ? new Date() : completesRun ? null : undefined,
      retryCount: nextStatus === 'done' || delegatedViaWebhook ? 0 : undefined,
      nextRunAt: completesRun ? null : undefined,
      lastError: delegationFailed ? delegationFailureReason : nextStatus === 'blocked' || nextStatus === 'cancelled' ? normalizedResult.reason ?? body.summary ?? `webhook_${nextStatus}` : escalation ? null : undefined,
      executionLockId: completesRun ? null : undefined,
      executionLockedByAgentId: completesRun ? null : undefined,
      executionLockedAt: completesRun ? null : undefined,
      executionLockExpiresAt: completesRun ? null : undefined,
      activeHeartbeatRunId: completesRun ? null : undefined,
      updatedAt: new Date(),
    }, taskRunId);
    if (!updatedCard) {
      // The gate can be created after the initial read. Settle this callback
      // without clearing or rewriting any current card/approval state.
      const [parked] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, card.id)).limit(1);
      if (!parked) return reply.code(404).send({ error: 'card_not_found' });
      const reason = normalizedResult.reason ?? 'agent_permission_blocked';
      const heartbeatRunId = webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId;
      if (actorAgentId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, actorAgentId));
      if (heartbeatRunId) await db.update(heartbeatRuns).set({ status: 'failed', completedAt: new Date(), error: reason }).where(eq(heartbeatRuns.id, heartbeatRunId));
      await completeTaskRun(taskRunId, { status: 'failed', preserveCard: true, error: reason, output: executionLog, costUsd: body.costUsd });
      await db.insert(taskLogs).values({ cardId: card.id, agentId: actorAgentId, type: 'webhook', status: 'warning', message: 'Pending human gate preserved; late permission blocker was not applied to the card.', output: reason });
      return { ok: true, cardId: card.id, taskRunId, newStatus: parked.columnStatus, preservedHumanGate: true };
    }
    let externalWaitId: string | null = null;
    if (nextStatus === 'waiting_on_external' && !mergePlan) {
      const externalProduct = body.workProducts.find((product) => product.pullRequestUrl || product.url || product.commitSha || product.branch);
      const waitValues = {
        waitingFor: body.summary ?? externalProduct?.title ?? 'external completion',
        provider: externalProduct?.repoProvider ?? (externalProduct?.pullRequestUrl ? 'git' : 'external'),
        externalId: externalProduct?.commitSha ?? externalProduct?.branch ?? null,
        externalUrl: externalProduct?.pullRequestUrl ?? externalProduct?.url ?? null,
        pollIntervalSeconds: body.pollIntervalSeconds ?? null,
      };
      // A polled owner that reports "still running" parks the same wait again:
      // update it instead of stacking a second row, so the poll budget keeps
      // counting and the sweep does not check twice per interval.
      const existingWait = await openExternalWait(card.id);
      if (existingWait) {
        const [wait] = await db.update(externalWaits).set(waitValues).where(eq(externalWaits.id, existingWait.id)).returning();
        externalWaitId = wait?.id ?? existingWait.id;
      } else {
        const [wait] = await db.insert(externalWaits).values({ companyId: card.companyId, cardId: card.id, status: 'waiting', ...waitValues }).returning();
        externalWaitId = wait?.id ?? null;
      }
    }
    if (nextStatus !== card.columnStatus) {
      const fromStatus = normalizeCardStatus(card.columnStatus) ?? 'todo';
      const toStatus = normalizeCardStatus(nextStatus) ?? fromStatus;
      await recordStageAction({
        cardId: body.cardId,
        agentId: actorAgentId,
        actor: { type: 'system', id: 'webhook' },
        fromStatus,
        toStatus,
        action: delegatedViaWebhook ? 'delegate' : inferCardTransitionAction(fromStatus, toStatus) ?? `webhook.task_${nextStatus}`,
        detail: `Stage changed from ${card.columnStatus ?? 'todo'} to ${nextStatus} by webhook.`,
        metadata: { taskRunId, requestedStatus, externalWaitId, pollIntervalSeconds: body.pollIntervalSeconds ?? null },
        logStatus: delegationFailed || nextStatus === 'blocked' ? 'failed' : nextStatus === 'cancelled' ? 'warning' : 'success',
      });
    }
    const webhookLogType = childBlock ? 'children' : delegatedViaWebhook || delegationFailed ? 'message_delegation' : escalation ? 'escalation' : webhookTaskRun?.kind === 'review' ? 'review' : 'webhook';
    await db.insert(taskLogs).values({ cardId: body.cardId, agentId: actorAgentId, type: webhookLogType, status: childBlock ? 'queued' : delegationFailed || nextStatus === 'blocked' ? 'failed' : nextStatus === 'cancelled' ? 'warning' : nextStatus === 'needs_review' || nextStatus === 'in_review' ? 'queued' : 'success', message: childBlock ? childBlock.message : delegatedViaWebhook ? `Webhook delegation plan accepted; ${delegatedRows.length} Message Board delegation(s) queued for direct reports.` : delegationFailed ? delegationFailureReason ?? 'Webhook delegation plan could not create Message Board delegations because the actor has no available direct reports.' : escalation ? (nextStatus === 'needs_review' ? 'Webhook requested reviewer guidance; help review queued.' : 'Webhook requested guidance but no reviewer is available; the card waits for client approval.') : fixRound ? 'Webhook reported the fix; verification round queued.' : humanGate ? 'Webhook reported completion; the card waits for client approval.' : qualityReviewerId ? 'Webhook reported completion; quality review queued.' : body.summary ?? `Webhook marked card ${nextStatus}`, output: body.output, costUsd: completesRun ? body.costUsd?.toString() : undefined });
    const webhookCommentAction = delegatedViaWebhook
      ? 'agent_delegated'
      : nextStatus === 'needs_review'
        ? 'agent_escalated'
        : nextStatus === 'blocked'
          ? 'agent_blocked'
          : nextStatus === 'cancelled'
            ? 'agent_cancelled'
            : webhookTaskRun?.kind === 'review'
              ? 'review_note'
              : 'agent_update';
    const [webhookComment] = await db.insert(cardComments).values({
      cardId: body.cardId,
      agentId: actorAgentId,
      authorType: actorAgentId ? 'agent' : 'system',
      action: webhookCommentAction,
      body: delegationFailed ? [delegationFailureReason, body.summary, body.output].filter(Boolean).join('\n\n') : childBlock ? [childBlock.message, body.summary, body.output].filter(Boolean).join('\n\n') : [body.summary, body.output].filter(Boolean).join('\n\n') || `Webhook marked card ${nextStatus}`,
    }).returning();
    publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: webhookAction });
    if (webhookComment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: webhookComment.id, cardId: card.id, projectId: card.projectId, action: webhookComment.action });
    if (completesRun && actorAgentId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, actorAgentId));
    if (completesRun && actorAgentId && body.costUsd) {
      await db.update(agents).set({ spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${body.costUsd}` }).where(eq(agents.id, actorAgentId));
      await db.insert(costEvents).values({ companyId: card.companyId, agentId: actorAgentId, cardId: card.id, projectId: card.projectId, goalId: card.goalId, provider: 'webhook', model: 'external', costUsd: body.costUsd.toString() });
    }
    const heartbeatRunId = webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId;
    if (completesRun) {
      const runStatus = delegationFailed || reviewRevisionRequested ? 'failed' : webhookRunStatus(nextStatus);
      const error = delegationFailed ? delegationFailureReason : runStatus === 'failed' || runStatus === 'cancelled' ? body.summary ?? `webhook_${nextStatus}` : null;
      if (heartbeatRunId) await db.update(heartbeatRuns).set({ status: runStatus, completedAt: new Date(), error, costUsd: body.costUsd?.toString() }).where(eq(heartbeatRuns.id, heartbeatRunId));
      if (taskRunId) {
        await completeTaskRun(taskRunId, { status: runStatus, releaseLock: true, retryableFailure: delegationFailed, error, output: executionLog, costUsd: body.costUsd });
      } else if (heartbeatRunId) {
        const heartbeatTaskRuns = await db.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.heartbeatRunId, heartbeatRunId));
        for (const run of heartbeatTaskRuns) await completeTaskRun(run.id, { status: runStatus, releaseLock: true, retryableFailure: delegationFailed, error, output: executionLog, costUsd: body.costUsd });
      }
    }
    await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'system', actorId: 'webhook', agentId: actorAgentId, action: webhookAction, entityType: 'card', entityId: card.id, details: { summary: body.summary, costUsd: body.costUsd, taskRunId, requestedStatus, requestedNextStatus, nextStatus, escalation, reviewerId: escalationReviewerId ?? qualityReviewerId, topLevelGuidanceAccepted, externalWaitId, pollIntervalSeconds: body.pollIntervalSeconds ?? null, delegatedViaWebhook, delegationFailed, delegationFailureReason, messageDelegationCount: delegatedRows.length, childBlock, reportFormat: body.report ? 'structured' : 'legacy', humanGate, fixRound: Boolean(fixRound) } });
    if (nextStatus === 'in_review' && fixRound && actorAgent) {
      await afterAuthorFix(updatedCard ?? { ...card, columnStatus: nextStatus }, actorAgent, fixRound, { escalation: fixEscalation, dispositions: body.report?.dispositions ?? [] });
    } else if (nextStatus === 'in_review' && humanGate) {
      await ensureHumanGate(updatedCard ?? { ...card, columnStatus: nextStatus }, actorAgentId ?? card.assigneeId, 'Client approval required', { kind: 'client_approval' });
    } else if (nextStatus === 'in_review' && qualityReviewerId) {
      const gateCard = updatedCard ?? { ...card, columnStatus: nextStatus, reviewerId: qualityReviewerId };
      await createPendingApproval(gateCard, actorAgentId ?? card.assigneeId, 'Webhook completion requires quality review.');
      if (await panelRequiredForCard(gateCard)) await openPanelRound(gateCard, { kind: 'panel' });
      else await enqueueTaskRun(card.id, 'review', 'queue');
    }
    if (nextStatus === 'needs_review') await enqueueTaskRun(card.id, 'review', 'queue');
    if (nextStatus === 'todo' && reviewRevisionRequested) await enqueueTaskRun(card.id, 'dispatch', 'queue');
    if (nextStatus === 'done') { await sealDeliveryAcceptance(card.id); await cascadeParentStatus(card.parentCardId); }
    if (delegationFailed) {
      await enqueueTaskRun(body.cardId, 'dispatch', 'queue');
      return reply.code(409).send({
        error: 'delegation_failed',
        message: delegationFailureMessage,
        cardId: body.cardId,
        taskRunId,
        requestedStatus,
        newStatus: nextStatus,
        availableDirectReports: activeDirectReports.map((report) => ({
          id: report.id,
          name: report.name,
          slug: report.slug,
          position: report.positionName ?? null,
          department: report.departmentName ?? null,
        })),
      });
    }
    if (mergePlan) await applyMergeGatePlan(updatedCard, mergePlan);
    return { ok: true, cardId: body.cardId, taskRunId, requestedStatus, requestedNextStatus, newStatus: nextStatus, reviewerId: escalationReviewerId ?? qualityReviewerId, delegated: delegatedViaWebhook, delegationFailed, messageDelegationCount: delegatedRows.length, childBlock };
  });
}
