import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, sql as drizzleSql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { acceptInviteSchema, adminUpdateSettingsSchema, adminUpdateUserSchema, approvalDecisionSchema, cardStatuses, createAgentRuntimeSchema, createAgentSchema, createBudgetPolicySchema, createCardCommentSchema, createCardSchema, createCompanyMembershipSchema, createCompanySchema, createDepartmentSchema, createGoalSchema, createInviteSchema, createKnowledgeDocSchema, createPositionSchema, createProjectSchema, createWorkProductSchema, inferCardTransitionAction, loginSchema, normalizeCardStatus, signupSchema, updateAgentSchema, updateCardSchema, updateCompanyMembershipSchema, validateCardTransition } from '@megacorps/shared';
import { assertSessionSecretReady, signSession, requireAuth, requireRole } from './auth.ts';
import { requireAnyVisibleCompany, requireCompanyRole, requireVisibleCompany } from './access.ts';
import { db } from './db/client.ts';
import { activityLog, adapterSessions, agentRuntimes, agents, apiEvents, appSettings, approvals, budgetPolicies, cardComments, chatMessages, chatSessions, companies, companyMemberships, costEvents, departments, goals, heartbeatRuns, kanbanCards, knowledgeDocs, positions, projects, promptLogs, taskLogs, taskRuns, userInvites, users, workProducts } from './db/schema.ts';
import { getAdapter } from './adapters/registry.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import { buildExecutionAgent, cascadeParentStatus, decomposeCard, enqueueTaskRun, getTaskLogs } from './dispatch.ts';
import { registerChatRoutes } from './chat.ts';
import { registerCronRoutes } from './cron-routes.ts';
import { registerRunnerRoutes } from './runner-routes.ts';
import { apiHelpCatalog, apiHelpMarkdown } from './api-help.ts';
import { configuredWebhookSharedSecret } from './webhook-secret.ts';
import { publishLiveEvent } from './live.ts';
import { resetAdapterSessionsForAgent } from './adapter-sessions.ts';
import { getCardActions, recordCardAction, recordStageAction } from './card-actions.ts';
import { hydrateCardDependencyState, setCardDependencies } from './card-dependencies.ts';
import { promptSnapshotForAdapter, recordPromptLog } from './prompt-logs.ts';

async function defaultCompanyId(): Promise<string> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
  if (!company) throw new Error('Default company missing. Run migrations.');
  return company.id;
}

function priorityToNumber(priority: string | undefined): number { return priority === 'urgent' ? 3 : priority === 'high' ? 2 : priority === 'low' ? -1 : 0; }
function actorLabel(user: { email?: string; id?: string } | null): string { return user?.email ?? user?.id ?? 'system'; }
function normalizedReviewerId(assigneeId: string | null | undefined, reviewerId: string | null | undefined): string | null {
  if (!reviewerId) return null;
  return reviewerId === assigneeId ? null : reviewerId;
}

function isGuidanceEscalation(status: string, text: string): boolean {
  if (status === 'needs_review') return true;
  if (status !== 'blocked') return false;
  return /\b(needs[_ -]?review|needs[_ -]?guidance|needs[_ -]?reviewer|escalat(?:e|ed|ion)|cannot[_ -]?complete|unable[_ -]?to[_ -]?complete|stuck)\b/i.test(text);
}

async function resolveIndependentReviewerForCard(card: typeof kanbanCards.$inferSelect, actorAgentId?: string | null): Promise<string | null> {
  if (card.reviewerId && card.reviewerId !== card.assigneeId && card.reviewerId !== actorAgentId) return card.reviewerId;
  if (!card.assigneeId) return null;
  const [assignee] = await db.select({ bossId: agents.bossId }).from(agents).where(and(eq(agents.id, card.assigneeId), isNull(agents.deletedAt))).limit(1);
  if (assignee?.bossId && assignee.bossId !== card.assigneeId && assignee.bossId !== actorAgentId) return assignee.bossId;
  return null;
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
  reply.setCookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/', secure: sessionCookieSecure() });
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
  return { ...agent, adapterConfig: redactSecrets(agent.adapterConfig) } as T;
}

function redactRuntime<T extends { config?: unknown }>(runtime: T): T {
  return { ...runtime, config: redactSecrets(runtime.config) } as T;
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
    const [row] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId))).limit(1);
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));
  await registerChatRoutes(app);
  await registerCronRoutes(app);
  await registerRunnerRoutes(app);
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
      const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
      if (!company) throw new Error('Default company missing. Run migrations.');
      const [existingUser] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
      const [user] = existingUser
        ? await tx.update(users).set({ name: input.name, passwordHash, role: 'admin', status: 'active', updatedAt: now }).where(eq(users.id, existingUser.id)).returning()
        : await tx.insert(users).values({ email: input.email, name: input.name, passwordHash, role: 'admin', status: 'active' }).returning();
      if (!user) throw new Error('bootstrap_user_failed');
      const [membership] = await tx.insert(companyMemberships).values({ companyId: company.id, userId: user.id, role: 'admin', status: 'active' }).onConflictDoUpdate({
        target: [companyMemberships.companyId, companyMemberships.userId],
        set: { role: 'admin', status: 'active', updatedAt: now },
      }).returning();
      await tx.insert(activityLog).values({ companyId: company.id, actorType: 'system', actorId: 'bootstrap', userId: user.id, action: existingUser ? 'auth.bootstrap_admin_promoted' : 'auth.bootstrap_admin_created', entityType: 'user', entityId: user.id, details: { email: user.email } });
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
      const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.slug, 'default')).limit(1);
      if (!company) throw new Error('Default company missing. Run migrations.');
      const [created] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash, role, status: 'active' }).returning();
      if (!created) throw new Error('signup_failed');
      const [membership] = await tx.insert(companyMemberships).values({ companyId: company.id, userId: created.id, role: companyRole, status: 'active' }).onConflictDoNothing().returning();
      await tx.insert(activityLog).values({ companyId: company.id, actorType: 'user', actorId: created.id, userId: created.id, action: nextSignupAdmin ? 'auth.first_admin_signup' : 'auth.signup', entityType: 'user', entityId: created.id, details: { email: created.email, role, companyRole, firstAccount } });
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
    return { signupEnabled: await signupEnabled() };
  });

  app.put('/api/admin/settings', async (request, reply) => {
    const user = await requireRole(request, reply, 'admin'); if (!user) return reply;
    const input = adminUpdateSettingsSchema.parse(request.body);
    if (input.signupEnabled !== undefined) await setSettingValue(SIGNUP_ENABLED_SETTING, input.signupEnabled ? 'true' : 'false');
    const companyId = await defaultCompanyId();
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'admin.settings.updated', entityType: 'app_settings', entityId: SIGNUP_ENABLED_SETTING, details: { signupEnabled: input.signupEnabled } });
    return { signupEnabled: await signupEnabled() };
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
    const companyId = await defaultCompanyId();
    await db.insert(activityLog).values({ companyId, actorType: 'user', actorId: actor.id, userId: actor.id, action: 'admin.user.updated', entityType: 'user', entityId: id, details: { email: updated?.email, role: input.role, status: input.status, passwordReset: input.password !== undefined } });
    return { user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, status: updated.status, createdAt: updated.createdAt, updatedAt: updated.updatedAt } };
  });

  app.get('/api/system-logs', async (request, reply) => {
    const user = await requireAuth(request, reply); if (!user) return reply;
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
    return db.select().from(apiEvents).where(eq(apiEvents.userId, user.id)).orderBy(desc(apiEvents.createdAt)).limit(limit);
  });
  app.get('/api/prompt-logs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; cardId?: string; agentId?: string; source?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(promptLogs.companyId, query.companyId) : inArray(promptLogs.companyId, access.companyIds),
      query.cardId ? eq(promptLogs.cardId, query.cardId) : undefined,
      query.agentId ? eq(promptLogs.agentId, query.agentId) : undefined,
      query.source ? eq(promptLogs.source, query.source) : undefined,
    ].filter(Boolean);
    return db.select().from(promptLogs).where(filters.length ? and(...filters) : undefined).orderBy(desc(promptLogs.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.get('/api/activity', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; entityType?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(activityLog.companyId, query.companyId) : inArray(activityLog.companyId, access.companyIds),
      query.entityType ? eq(activityLog.entityType, query.entityType) : undefined,
    ].filter(Boolean);
    return db.select().from(activityLog).where(filters.length ? and(...filters) : undefined).orderBy(desc(activityLog.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.get('/api/heartbeat-runs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; cardId?: string; agentId?: string; status?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(heartbeatRuns.companyId, query.companyId) : inArray(heartbeatRuns.companyId, access.companyIds),
      query.cardId ? eq(heartbeatRuns.cardId, query.cardId) : undefined,
      query.agentId ? eq(heartbeatRuns.agentId, query.agentId) : undefined,
      query.status ? eq(heartbeatRuns.status, query.status) : undefined,
    ].filter(Boolean);
    return db.select().from(heartbeatRuns).where(filters.length ? and(...filters) : undefined).orderBy(desc(heartbeatRuns.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.get('/api/task-runs', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string; cardId?: string; agentId?: string; kind?: string; status?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(taskRuns.companyId, query.companyId) : inArray(taskRuns.companyId, access.companyIds),
      query.cardId ? eq(taskRuns.cardId, query.cardId) : undefined,
      query.agentId ? eq(taskRuns.agentId, query.agentId) : undefined,
      query.kind ? eq(taskRuns.kind, query.kind) : undefined,
      query.status ? eq(taskRuns.status, query.status) : undefined,
    ].filter(Boolean);
    return db.select().from(taskRuns).where(filters.length ? and(...filters) : undefined).orderBy(desc(taskRuns.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
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
    const query = request.query as { companyId?: string; status?: string; cardId?: string; limit?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    const filters = [
      query.companyId ? eq(approvals.companyId, query.companyId) : inArray(approvals.companyId, access.companyIds),
      query.status ? eq(approvals.status, query.status) : undefined,
      query.cardId ? eq(approvals.cardId, query.cardId) : undefined,
    ].filter(Boolean);
    return db.select().from(approvals).where(filters.length ? and(...filters) : undefined).orderBy(desc(approvals.createdAt)).limit(Math.min(Math.max(Number(query.limit ?? 200), 1), 500));
  });
  app.put('/api/approvals/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = approvalDecisionSchema.parse(request.body);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!approval) return reply.code(404).send({ error: 'approval_not_found' });
    const user = await requireCompanyRole(request, reply, approval.companyId, 'operator'); if (!user) return reply;
    const [updatedApproval] = await db.update(approvals).set({
      status: input.status,
      decisionNote: input.decisionNote ?? null,
      decidedByUserId: user.id,
      decidedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(approvals.id, id)).returning();
    if (approval.cardId) {
        const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, approval.cardId), isNull(kanbanCards.deletedAt))).limit(1);
      if (card && input.status !== 'cancelled') {
        const nextStatus = input.status === 'approved' ? 'done' : 'todo';
        await db.update(kanbanCards).set({ columnStatus: nextStatus, completedAt: nextStatus === 'done' ? new Date() : null, reviewFeedback: input.decisionNote ?? card.reviewFeedback, updatedAt: new Date() }).where(eq(kanbanCards.id, card.id));
        await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'approval', status: input.status === 'approved' ? 'success' : 'failed', message: `Approval ${input.status} by ${actorLabel(user)}.`, output: input.decisionNote });
        await db.insert(taskLogs).values({ cardId: card.id, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'todo'} to ${nextStatus} by approval.` });
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
    const input = createBudgetPolicySchema.partial().parse(request.body);
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
    const [cards, agentRows, companyRows, recentTaskLogs, recentApiEvents, recentActivity, recentRuns, pendingApprovals, policyRows] = await Promise.all([
      db.select().from(kanbanCards).where(inArray(kanbanCards.companyId, access.companyIds)),
      db.select().from(agents).where(inArray(agents.companyId, access.companyIds)),
      db.select().from(companies).where(inArray(companies.id, access.companyIds)),
      db.select().from(taskLogs).innerJoin(kanbanCards, eq(taskLogs.cardId, kanbanCards.id)).where(inArray(kanbanCards.companyId, access.companyIds)).orderBy(desc(taskLogs.createdAt)).limit(20),
      db.select().from(apiEvents).where(eq(apiEvents.userId, access.user.id)).orderBy(desc(apiEvents.createdAt)).limit(20),
      db.select().from(activityLog).where(inArray(activityLog.companyId, access.companyIds)).orderBy(desc(activityLog.createdAt)).limit(20),
      db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.companyId, access.companyIds)).orderBy(desc(heartbeatRuns.createdAt)).limit(20),
      db.select().from(approvals).where(and(inArray(approvals.companyId, access.companyIds), eq(approvals.status, 'pending'))).orderBy(desc(approvals.createdAt)).limit(50),
      db.select().from(budgetPolicies).where(and(inArray(budgetPolicies.companyId, access.companyIds), eq(budgetPolicies.isActive, true))),
    ]);
    const openCards = cards.filter((card) => !['done', 'blocked', 'cancelled'].includes(card.columnStatus ?? 'todo'));
    const completedCards = cards.filter((card) => card.columnStatus === 'done');
    const blockedCards = cards.filter((card) => card.columnStatus === 'blocked');
    const cancelledCards = cards.filter((card) => card.columnStatus === 'cancelled');
    const activeAgents = agentRows.filter((agent) => agent.isActive !== false);
    const busyAgents = agentRows.filter((agent) => agent.isBusy);
    const monthlyCost = cards.reduce((sum, card) => sum + Number(card.costUsd ?? 0), 0);
    return {
      stats: {
        companies: companyRows.length,
        tasks: cards.length,
        openTasks: openCards.length,
        completedTasks: completedCards.length,
        blockedTasks: blockedCards.length,
        cancelledTasks: cancelledCards.length,
        agents: agentRows.length,
        activeAgents: activeAgents.length,
        busyAgents: busyAgents.length,
        activeRuns: recentRuns.filter((run) => run.status === 'running').length,
        pendingApprovals: pendingApprovals.length,
        budgetPolicies: policyRows.length,
        monthlyCost: Number(monthlyCost.toFixed(4)),
      },
      stages: cards.reduce<Record<string, number>>((acc, card) => {
        const key = card.columnStatus ?? 'todo';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      recentTaskLogs: recentTaskLogs.map((row) => row.task_logs),
      recentApiEvents,
      recentActivity,
      recentRuns,
      pendingApprovals,
    };
  });

  app.get('/api/companies', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    return db.select().from(companies).where(inArray(companies.id, access.companyIds)).orderBy(desc(companies.createdAt));
  });
  app.post('/api/companies', async (request, reply) => {
    const user = await requireRole(request, reply, 'operator'); if (!user) return reply;
    const input = createCompanySchema.parse(request.body);
    const [company] = await db.insert(companies).values({
      name: input.name,
      slug: input.slug,
      mission: input.mission ?? null,
      dispatchIntervalSeconds: input.dispatchIntervalSeconds,
      autoDispatchEnabled: input.autoDispatchEnabled,
    }).returning();
    if (company) await db.insert(companyMemberships).values({ companyId: company.id, userId: user.id, role: 'admin', status: 'active' }).onConflictDoNothing();
    return reply.code(201).send(company);
  });
  app.put('/api/companies/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = await requireCompanyRole(request, reply, id, 'operator'); if (!user) return reply;
    const input = createCompanySchema.partial().parse(request.body);
    const [company] = await db.update(companies).set({
      name: input.name,
      slug: input.slug,
      mission: input.mission,
      dispatchIntervalSeconds: input.dispatchIntervalSeconds,
      autoDispatchEnabled: input.autoDispatchEnabled,
    }).where(eq(companies.id, id)).returning();
    if (!company) return reply.code(404).send({ error: 'company_not_found' });
    return company;
  });
  app.delete('/api/companies/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = await requireCompanyRole(request, reply, id, 'admin'); if (!user) return reply;
    const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).limit(1);
    if (!company) return reply.code(404).send({ error: 'company_not_found' });
    const [
      [departmentUsage],
      [positionUsage],
      [projectUsage],
      [goalUsage],
      [runtimeUsage],
      [agentUsage],
      [cardUsage],
      [knowledgeUsage],
      [budgetUsage],
      [approvalUsage],
      [inviteUsage],
      [activityUsage],
      [costUsage],
      [heartbeatUsage],
      [taskRunUsage],
      [adapterSessionUsage],
      [workProductUsage],
      [chatSessionUsage],
      [chatMessageUsage],
      [promptLogUsage],
    ] = await Promise.all([
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(departments).where(eq(departments.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(positions).where(eq(positions.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(projects).where(eq(projects.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(goals).where(eq(goals.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(agentRuntimes).where(eq(agentRuntimes.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(agents).where(eq(agents.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(kanbanCards).where(eq(kanbanCards.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(knowledgeDocs).where(eq(knowledgeDocs.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(budgetPolicies).where(eq(budgetPolicies.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(approvals).where(eq(approvals.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(userInvites).where(eq(userInvites.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(activityLog).where(eq(activityLog.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(costEvents).where(eq(costEvents.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(taskRuns).where(eq(taskRuns.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(adapterSessions).where(eq(adapterSessions.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(workProducts).where(eq(workProducts.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(chatSessions).where(eq(chatSessions.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(chatMessages).where(eq(chatMessages.companyId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(promptLogs).where(eq(promptLogs.companyId, id)),
    ]);
    const usage = {
      departments: departmentUsage?.count ?? 0,
      positions: positionUsage?.count ?? 0,
      projects: projectUsage?.count ?? 0,
      goals: goalUsage?.count ?? 0,
      agentRuntimes: runtimeUsage?.count ?? 0,
      agents: agentUsage?.count ?? 0,
      cards: cardUsage?.count ?? 0,
      knowledgeDocs: knowledgeUsage?.count ?? 0,
      budgetPolicies: budgetUsage?.count ?? 0,
      approvals: approvalUsage?.count ?? 0,
      invites: inviteUsage?.count ?? 0,
      activity: activityUsage?.count ?? 0,
      costEvents: costUsage?.count ?? 0,
      heartbeatRuns: heartbeatUsage?.count ?? 0,
      taskRuns: taskRunUsage?.count ?? 0,
      adapterSessions: adapterSessionUsage?.count ?? 0,
      workProducts: workProductUsage?.count ?? 0,
      chatSessions: chatSessionUsage?.count ?? 0,
      chatMessages: chatMessageUsage?.count ?? 0,
      promptLogs: promptLogUsage?.count ?? 0,
    };
    const blocking = Object.entries(usage ?? {}).filter(([, count]) => Number(count) > 0);
    if (blocking.length > 0) return reply.code(409).send({ error: 'company_not_empty', blocking: Object.fromEntries(blocking) });
    await db.transaction(async (tx) => {
      await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
      await tx.delete(companies).where(eq(companies.id, id));
    });
    return { ok: true };
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
    const [department] = await db.insert(departments).values(input).returning();
    return reply.code(201).send(department);
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
    const [position] = await db.insert(positions).values({ ...input, prompt: optionalText(input.prompt) ?? null }).returning();
    if (position) await db.insert(activityLog).values({ companyId: position.companyId, actorType: 'user', actorId: user.id, userId: user.id, action: 'position.created', entityType: 'position', entityId: position.id, details: { name: position.name } });
    return reply.code(201).send(position);
  });
  app.put('/api/positions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createPositionSchema.partial().parse(request.body);
    const [existing] = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'position_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'position_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [position] = await db.update(positions).set({
      name: input.name,
      slug: input.slug,
      prompt: input.prompt === undefined ? undefined : optionalText(input.prompt) ?? null,
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
    return hydrateCardDependencyState(rows);
  });

  app.post('/api/cards', async (request, reply) => {
    const input = createCardSchema.parse(request.body);
    const companyId = input.companyId ?? await defaultCompanyId();
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    try {
      await ensureCompanyReferences(companyId, {
        departmentId: input.departmentId,
        projectId: input.projectId,
        goalId: input.goalId,
        assigneeId: input.assigneeId,
        reviewerId: input.reviewerId,
        parentCardId: input.parentCardId,
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
      maxRetries: input.maxRetries,
      createdBy: user.id,
    }).returning();
    if (card) {
      await setCardDependencies(card.id, input.dependencyCardIds);
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
    const [existing] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, id), isNull(kanbanCards.deletedAt))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'card_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const nextDepartmentId = input.departmentId === undefined ? existing.departmentId : input.departmentId ?? null;
    const nextProjectId = input.projectId === undefined ? existing.projectId : input.projectId ?? null;
    const nextGoalId = input.goalId === undefined ? existing.goalId : input.goalId ?? null;
    const nextAssigneeId = input.assigneeId === undefined ? existing.assigneeId : input.assigneeId ?? null;
    const nextReviewerId = normalizedReviewerId(nextAssigneeId, input.reviewerId === undefined ? existing.reviewerId : input.reviewerId ?? null);
    const nextParentCardId = input.parentCardId === undefined ? existing.parentCardId : input.parentCardId ?? null;
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
      maxRetries: input.maxRetries,
      completedAt: input.columnStatus === 'done' ? new Date() : input.columnStatus ? null : undefined,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, id)).returning();
    if (card && transitionAction && toStatus) {
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
    return getTaskLogs(card.id);
  });
  app.get('/api/cards/:id/actions', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    const query = request.query as { limit?: string };
    return getCardActions(card.id, Number(query.limit ?? 200));
  });
  app.get('/api/cards/:id/comments', async (request, reply) => {
    const card = await ensureVisibleCard(request, reply, (request.params as { id: string }).id);
    if (!card) return reply;
    return db.select().from(cardComments).where(eq(cardComments.cardId, card.id)).orderBy(desc(cardComments.createdAt));
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
    const user = await requireCompanyRole(request, reply, card.companyId, 'operator'); if (!user) return reply;
    if (input.agentId && !['comment', 'agent_note'].includes(input.action)) return reply.code(400).send({ error: 'agent_comments_cannot_control_task' });
    const [authorAgent] = input.agentId ? await db.select().from(agents).where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt))).limit(1) : [];
    if (input.agentId && !authorAgent) return reply.code(404).send({ error: 'agent_not_found' });
    if (authorAgent && authorAgent.companyId !== card.companyId) return reply.code(400).send({ error: 'agent_company_mismatch' });
    const authorType = authorAgent ? 'agent' : 'user';
    const effectiveAction = authorAgent ? 'agent_note' : input.action;
    const effectiveAgentId = authorAgent?.id ?? card.assigneeId;
    const authorName = authorAgent ? authorAgent.name : actorLabel(user);
    const [comment] = await db.insert(cardComments).values({ cardId: id, authorType, authorId: authorAgent ? null : user.id, agentId: authorAgent?.id ?? null, body: input.body, action: effectiveAction }).returning();
    if (comment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: comment.id, cardId: card.id, projectId: card.projectId, action: effectiveAction });
    await db.insert(taskLogs).values({ cardId: id, agentId: effectiveAgentId, type: 'comment', status: 'success', message: `${authorName} added a ${effectiveAction} message.`, output: input.body });
    await db.insert(activityLog).values({ companyId: card.companyId, actorType: authorType, actorId: authorAgent?.id ?? user.id, userId: user.id, agentId: effectiveAgentId, action: `comment.${effectiveAction}`, entityType: 'card', entityId: card.id, details: { commentId: comment?.id, authorAgentId: authorAgent?.id } });
    if (input.action === 'pause_agent') {
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
      await db.update(kanbanCards).set({ columnStatus: 'todo', lastError: null, nextRunAt: null, updatedAt: new Date() }).where(eq(kanbanCards.id, id));
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
    try { return reply.code(201).send(await decomposeCard(card.id)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'decompose_failed' }); }
  });

  app.get('/api/agents', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    if (access.companyIds.length === 0) return [];
    const query = request.query as { companyId?: string };
    if (query.companyId && !access.companyIds.includes(query.companyId)) return [];
    const rows = await db.select().from(agents).where(and(
      query.companyId ? eq(agents.companyId, query.companyId) : inArray(agents.companyId, access.companyIds),
      isNull(agents.deletedAt),
    ));
    return rows.map(redactAgent);
  });
  app.post('/api/agents', async (request, reply) => {
    const input = createAgentSchema.parse(request.body);
    const companyId = input.companyId ?? await defaultCompanyId();
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    try { await ensureCompanyReferences(companyId, { departmentId: input.departmentId, positionId: input.positionId, bossId: input.bossId, runtimeId: input.runtimeId, adapterType: input.adapterType }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'company_reference_mismatch' }); }
    const [agent] = await db.insert(agents).values({ companyId, departmentId: input.departmentId ?? null, positionId: input.positionId ?? null, slug: input.slug, name: input.name, role: input.role, title: input.title, soul: input.soul ?? null, adapterType: input.adapterType, adapterConfig: input.adapterConfig ?? {}, runtimeId: input.runtimeId ?? null, hermesProfile: input.hermesProfile, bossId: input.bossId ?? null, capabilities: input.capabilities ?? [], budgetPerTask: input.budgetPerTask?.toString(), budgetMonthly: input.budgetMonthly?.toString() }).returning();
    if (agent) await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.created', entityType: 'agent', entityId: agent.id, details: { name: agent.name, adapterType: agent.adapterType } });
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
  app.post('/api/agents/:id/pause', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.update(agents).set({ isActive: false, isBusy: false }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.paused', entityType: 'agent', entityId: agent.id, details: { name: agent.name } });
    return agent;
  });
  app.post('/api/agents/:id/resume', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const companyId = await agentCompanyId(id);
    if (!companyId) return reply.code(404).send({ error: 'agent_not_found' });
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [agent] = await db.update(agents).set({ isActive: true }).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    await db.insert(activityLog).values({ companyId: agent.companyId, actorType: 'user', actorId: user.id, userId: user.id, agentId: agent.id, action: 'agent.resumed', entityType: 'agent', entityId: agent.id, details: { name: agent.name } });
    return agent;
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
    return agent;
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
          : runtime.adapterType === 'hermes'
            ? ['portainer-exec', 'hermes-cli']
            : runtime.adapterType === 'hermes-gateway'
              ? ['http-dispatch', 'polling']
              : runtime.adapterType === 'codex-app'
                ? ['codex-app-server', 'json-rpc', 'thread-turn-session']
                : runtime.adapterType === 'mock'
                  ? ['local-debug']
                  : ['webhook'],
      };
    });
  });
  app.post('/api/agent-runtimes', async (request, reply) => {
    const input = createAgentRuntimeSchema.parse(request.body);
    const companyId = input.companyId ?? await defaultCompanyId();
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [row] = await db.insert(agentRuntimes).values({
      ...input,
      companyId,
      localWorkspaceRoot: optionalText(input.localWorkspaceRoot) ?? null,
      localScratchRoot: optionalText(input.localScratchRoot) ?? null,
    }).returning();
    return reply.code(201).send(row ? redactRuntime(row) : row);
  });
  app.put('/api/agent-runtimes/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createAgentRuntimeSchema.partial().parse(request.body);
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
    try {
      const adapter = getAdapter(agent.adapterType ?? 'hermes');
      const executionAgent = await buildExecutionAgent(agent);
      const task = { id: 'test', title: 'Connection test', body: 'Return OK.', timeoutSeconds: 300 };
      await recordPromptLog({
        companyId: agent.companyId,
        agentId: agent.id,
        source: 'test',
        adapterType: agent.adapterType ?? 'hermes',
        title: task.title,
        prompt: promptSnapshotForAdapter(executionAgent, task),
        metadata: { requestedByUserId: user.id, megacorpsPromptChars: task.body.length },
      });
      return await adapter.dispatch(executionAgent, task);
    }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'connection_failed' }); }
  });

  app.get('/api/projects', async (request, reply) => {
    const access = await requireAnyVisibleCompany(request, reply); if (!access) return reply;
    const query = request.query as { companyId?: string };
    if (access.companyIds.length === 0 || (query.companyId && !access.companyIds.includes(query.companyId))) return [];
    return db.select().from(projects).where(query.companyId ? eq(projects.companyId, query.companyId) : inArray(projects.companyId, access.companyIds)).orderBy(desc(projects.createdAt));
  });
  app.post('/api/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const companyId = input.companyId ?? await defaultCompanyId();
    const user = await requireCompanyRole(request, reply, companyId, 'operator'); if (!user) return reply;
    const [row] = await db.insert(projects).values({
      companyId,
      name: input.name,
      description: input.description,
      repoProvider: input.repoProvider,
      repoUrl: input.repoUrl ?? null,
      workPath: input.workPath || null,
      defaultBranch: input.defaultBranch,
      protectedBranches: input.protectedBranches,
      workBranchPattern: input.workBranchPattern,
      pullBeforeRun: input.pullBeforeRun,
      pushAfterRun: input.pushAfterRun,
      completionPolicy: input.completionPolicy,
      setupCommand: input.setupCommand ?? null,
      testCommand: input.testCommand ?? null,
      runtimeServices: input.runtimeServices,
      workspacePathHint: input.workspacePathHint ?? null,
    }).returning();
    if (row) publishLiveEvent({ type: 'project.created', companyId: row.companyId, entityType: 'project', entityId: row.id });
    return reply.code(201).send(row);
  });
  app.put('/api/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const input = createProjectSchema.partial().parse(request.body);
    const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'project_not_found' });
    if (input.companyId && input.companyId !== existing.companyId) return reply.code(400).send({ error: 'project_company_immutable' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [row] = await db.update(projects).set({
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
      setupCommand: input.setupCommand,
      testCommand: input.testCommand,
      runtimeServices: input.runtimeServices,
      workspacePathHint: input.workspacePathHint,
      updatedAt: new Date(),
    }).where(eq(projects.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'project_not_found' });
    publishLiveEvent({ type: 'project.updated', companyId: row.companyId, entityType: 'project', entityId: row.id });
    return row;
  });
  app.delete('/api/projects/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'project_not_found' });
    const user = await requireCompanyRole(request, reply, existing.companyId, 'operator'); if (!user) return reply;
    const [
      [cardUsage],
      [workProductUsage],
      [chatSessionUsage],
      [costUsage],
      [promptLogUsage],
    ] = await Promise.all([
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(kanbanCards).where(eq(kanbanCards.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(workProducts).where(eq(workProducts.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(chatSessions).where(eq(chatSessions.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(costEvents).where(eq(costEvents.projectId, id)),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(promptLogs).where(eq(promptLogs.projectId, id)),
    ]);
    const blocking = Object.entries({
      cards: cardUsage?.count ?? 0,
      workProducts: workProductUsage?.count ?? 0,
      chatSessions: chatSessionUsage?.count ?? 0,
      costEvents: costUsage?.count ?? 0,
      promptLogs: promptLogUsage?.count ?? 0,
    }).filter(([, count]) => Number(count) > 0);
    if (blocking.length > 0) return reply.code(409).send({ error: 'project_not_empty', blocking: Object.fromEntries(blocking) });
    await db.transaction(async (tx) => {
      await tx.delete(goals).where(eq(goals.projectId, id));
      await tx.delete(projects).where(eq(projects.id, id));
    });
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
    const companyId = input.companyId ?? await defaultCompanyId();
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
    const input = createKnowledgeDocSchema.partial().parse(request.body);
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

  app.post('/api/webhook/task-complete', async (request, reply) => {
    const expectedSecret = await configuredWebhookSharedSecret();
    if (!expectedSecret) return reply.code(503).send({ error: 'webhook_secret_not_configured' });
    if (expectedSecret.length < 16) return reply.code(503).send({ error: 'webhook_secret_too_short' });
    const headerSecret = request.headers['x-megacorps-webhook-secret'];
    const bearer = typeof request.headers.authorization === 'string' && request.headers.authorization.startsWith('Bearer ')
      ? request.headers.authorization.slice('Bearer '.length)
      : undefined;
    const providedSecret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;
    if (!safeSecretEqual(providedSecret, expectedSecret) && !safeSecretEqual(bearer, expectedSecret)) return reply.code(401).send({ error: 'webhook_auth_required' });
    const parsedBody = z.object({
      cardId: z.string().uuid(),
      taskRunId: z.string().uuid().optional(),
      idempotencyKey: z.string().uuid().optional(),
      status: z.string(),
      summary: z.string().optional(),
      output: z.string().optional(),
      costUsd: z.number().nonnegative().optional(),
      workProducts: z.array(createWorkProductSchema).default([]),
    }).safeParse(request.body);
    if (!parsedBody.success) return reply.code(400).send({ error: 'invalid_body', issues: parsedBody.error.issues });
    const body = parsedBody.data;
    const taskRunId = body.taskRunId ?? body.idempotencyKey;
    const requestedStatus = normalizeCardStatus(body.status);
    if (!requestedStatus) return reply.code(400).send({ error: 'invalid_status', allowed: cardStatuses, legacyAliases: { backlog: 'todo' } });
    const [card] = await db.select().from(kanbanCards).where(and(eq(kanbanCards.id, body.cardId), isNull(kanbanCards.deletedAt))).limit(1);
    if (!card) return reply.code(404).send({ error: 'card_not_found' });
    if (body.workProducts.some((product) => product.projectId && product.projectId !== card.projectId)) return reply.code(400).send({ error: 'work_product_project_mismatch' });
    const [webhookTaskRun] = taskRunId ? await db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1) : [];
    if (taskRunId && !webhookTaskRun) return reply.code(404).send({ error: 'task_run_not_found' });
    if (webhookTaskRun && webhookTaskRun.cardId !== card.id) return reply.code(409).send({ error: 'task_run_card_mismatch' });
    const executionLog = body.summary ? `${body.summary}\n\n${body.output || ''}` : (body.output || '');
    const actorAgentId = webhookTaskRun?.agentId ?? card.assigneeId;
    const escalation = isGuidanceEscalation(requestedStatus, executionLog);
    const escalationReviewerId = escalation ? await resolveIndependentReviewerForCard(card, actorAgentId) : null;
    const topLevelGuidanceAccepted = escalation && !escalationReviewerId;
    const nextStatus = escalation ? escalationReviewerId ? 'needs_review' : 'done' : requestedStatus;
    const completesRun = nextStatus !== 'in_progress';
    if (taskRunId && completesRun) {
      const [existingWebhook] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.entityId, card.id),
        eq(activityLog.actorId, 'webhook'),
        ne(activityLog.action, 'webhook.task_in_progress'),
        drizzleSql`${activityLog.details}->>'taskRunId' = ${taskRunId}`,
      )).limit(1);
      if (existingWebhook) return { ok: true, duplicate: true, cardId: body.cardId, taskRunId, newStatus: card.columnStatus };
    }
    await db.update(kanbanCards).set({
      columnStatus: nextStatus,
      executionLog,
      reviewerId: escalation ? escalationReviewerId : undefined,
      costUsd: completesRun ? body.costUsd?.toString() : undefined,
      completedAt: nextStatus === 'done' ? new Date() : completesRun ? null : undefined,
      retryCount: nextStatus === 'done' ? 0 : undefined,
      nextRunAt: completesRun ? null : undefined,
      lastError: nextStatus === 'blocked' || nextStatus === 'cancelled' ? body.summary ?? `webhook_${nextStatus}` : escalation ? null : undefined,
      executionLockId: completesRun ? null : undefined,
      executionLockedByAgentId: completesRun ? null : undefined,
      executionLockedAt: completesRun ? null : undefined,
      executionLockExpiresAt: completesRun ? null : undefined,
      activeHeartbeatRunId: completesRun ? null : undefined,
      updatedAt: new Date(),
    }).where(eq(kanbanCards.id, body.cardId));
    if (nextStatus !== card.columnStatus) await db.insert(taskLogs).values({ cardId: body.cardId, agentId: card.assigneeId, type: 'stage', status: 'success', message: `Stage changed from ${card.columnStatus ?? 'todo'} to ${nextStatus} by webhook` });
    await db.insert(taskLogs).values({ cardId: body.cardId, agentId: card.assigneeId, type: escalation ? 'escalation' : 'webhook', status: nextStatus === 'blocked' ? 'failed' : nextStatus === 'cancelled' ? 'warning' : nextStatus === 'needs_review' ? 'queued' : 'success', message: escalation ? (nextStatus === 'needs_review' ? 'Webhook requested reviewer guidance; help review queued.' : 'Webhook requested guidance but no reviewer is available; output accepted as final and card marked done.') : body.summary ?? `Webhook marked card ${nextStatus}`, output: body.output, costUsd: completesRun ? body.costUsd?.toString() : undefined });
    const [webhookComment] = await db.insert(cardComments).values({
      cardId: body.cardId,
      agentId: card.assigneeId,
      authorType: card.assigneeId ? 'agent' : 'system',
      action: nextStatus === 'needs_review' ? 'agent_escalated' : nextStatus === 'blocked' ? 'agent_blocked' : nextStatus === 'cancelled' ? 'agent_cancelled' : 'agent_update',
      body: [body.summary, body.output].filter(Boolean).join('\n\n') || `Webhook marked card ${nextStatus}`,
    }).returning();
    publishLiveEvent({ type: 'card.updated', companyId: card.companyId, entityType: 'card', entityId: card.id, cardId: card.id, projectId: card.projectId, action: `webhook.task_${nextStatus}` });
    if (webhookComment) publishLiveEvent({ type: 'card.comment.created', companyId: card.companyId, entityType: 'card_comment', entityId: webhookComment.id, cardId: card.id, projectId: card.projectId, action: webhookComment.action });
    if (completesRun && card.assigneeId) await db.update(agents).set({ isBusy: false }).where(eq(agents.id, card.assigneeId));
    if (completesRun && card.assigneeId && body.costUsd) {
      await db.update(agents).set({ spentThisMonth: drizzleSql`${agents.spentThisMonth} + ${body.costUsd}` }).where(eq(agents.id, card.assigneeId));
      await db.insert(costEvents).values({ companyId: card.companyId, agentId: card.assigneeId, cardId: card.id, projectId: card.projectId, goalId: card.goalId, provider: 'webhook', model: 'external', costUsd: body.costUsd.toString() });
    }
    if (body.workProducts.length > 0) {
      const [project] = card.projectId ? await db.select().from(projects).where(eq(projects.id, card.projectId)).limit(1) : [];
      const insertedProducts = await db.insert(workProducts).values(body.workProducts.map((product) => ({
        companyId: card.companyId,
        cardId: card.id,
        projectId: product.projectId ?? card.projectId,
        agentId: product.agentId ?? actorAgentId,
        taskRunId: product.taskRunId ?? taskRunId ?? null,
        type: product.type,
        title: product.title,
        summary: product.summary ?? null,
        url: product.url ?? null,
        repoProvider: product.repoProvider ?? project?.repoProvider ?? null,
        repoUrl: product.repoUrl ?? project?.repoUrl ?? null,
        branch: product.branch ?? null,
        commitSha: product.commitSha ?? null,
        pullRequestUrl: product.pullRequestUrl ?? null,
        metadata: product.metadata,
      }))).returning();
      for (const product of insertedProducts) publishLiveEvent({ type: 'work_product.created', companyId: card.companyId, entityType: 'work_product', entityId: product.id, cardId: card.id, projectId: product.projectId });
    }
    const heartbeatRunId = webhookTaskRun?.heartbeatRunId ?? card.activeHeartbeatRunId;
    if (completesRun) {
      const runStatus = webhookRunStatus(nextStatus);
      const error = runStatus === 'failed' || runStatus === 'cancelled' ? body.summary ?? `webhook_${nextStatus}` : null;
      if (heartbeatRunId) await db.update(heartbeatRuns).set({ status: runStatus, completedAt: new Date(), error, costUsd: body.costUsd?.toString() }).where(eq(heartbeatRuns.id, heartbeatRunId));
      if (taskRunId) {
        await db.update(taskRuns).set({ status: runStatus, completedAt: new Date(), lockedBy: null, lockedAt: null, error, output: executionLog, costUsd: body.costUsd?.toString(), updatedAt: new Date() }).where(eq(taskRuns.id, taskRunId));
      } else if (heartbeatRunId) {
        await db.update(taskRuns).set({ status: runStatus, completedAt: new Date(), lockedBy: null, lockedAt: null, error, output: executionLog, costUsd: body.costUsd?.toString(), updatedAt: new Date() }).where(eq(taskRuns.heartbeatRunId, heartbeatRunId));
      }
    }
    await db.insert(activityLog).values({ companyId: card.companyId, actorType: 'system', actorId: 'webhook', agentId: card.assigneeId, action: `webhook.task_${nextStatus}`, entityType: 'card', entityId: card.id, details: { summary: body.summary, costUsd: body.costUsd, taskRunId, requestedStatus, escalation, reviewerId: escalationReviewerId, topLevelGuidanceAccepted } });
    if (nextStatus === 'needs_review') await enqueueTaskRun(card.id, 'review', 'queue');
    if (nextStatus === 'done') await cascadeParentStatus(card.parentCardId);
    return { ok: true, cardId: body.cardId, taskRunId, requestedStatus, newStatus: nextStatus, reviewerId: escalationReviewerId };
  });
}
