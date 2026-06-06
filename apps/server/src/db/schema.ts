import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  avatarUrl: text('avatar_url'),
  role: text('role').default('viewer'),
  locale: text('locale').default('zh-TW'),
  theme: text('theme').default('system'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const groups = pgTable('groups', { id: uuid('id').primaryKey().defaultRandom(), name: text('name').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow() });
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').references(() => groups.id),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  mission: text('mission'),
  dispatchIntervalSeconds: integer('dispatch_interval_seconds').default(10),
  autoDispatchEnabled: boolean('auto_dispatch_enabled').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const companyMemberships = pgTable('company_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull().default('viewer'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({ companyUserUnique: unique().on(table.companyId, table.userId) }));

export const userInvites = pgTable('user_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').notNull().default('viewer'),
  tokenHash: text('token_hash').notNull().unique(),
  status: text('status').notNull().default('pending'),
  invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const departments = pgTable('departments', { id: uuid('id').primaryKey().defaultRandom(), companyId: uuid('company_id').notNull().references(() => companies.id), name: text('name').notNull(), slug: text('slug').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow() });
export const projects = pgTable('projects', { id: uuid('id').primaryKey().defaultRandom(), companyId: uuid('company_id').notNull().references(() => companies.id), name: text('name').notNull(), description: text('description'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow() });
export const goals = pgTable('goals', { id: uuid('id').primaryKey().defaultRandom(), companyId: uuid('company_id').notNull().references(() => companies.id), title: text('title').notNull(), body: text('body'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow() });

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  departmentId: uuid('department_id').references(() => departments.id),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  title: text('title'),
  adapterType: text('adapter_type').notNull().default('hermes'),
  adapterConfig: jsonb('adapter_config').default({}),
  runtimeId: uuid('runtime_id'),
  hermesProfile: text('hermes_profile'),
  bossId: uuid('boss_id'),
  budgetPerTask: numeric('budget_per_task', { precision: 10, scale: 4 }),
  budgetMonthly: numeric('budget_monthly', { precision: 10, scale: 4 }),
  spentThisMonth: numeric('spent_this_month', { precision: 10, scale: 4 }).default('0'),
  capabilities: text('capabilities').array().default([]),
  isBusy: boolean('is_busy').default(false),
  isActive: boolean('is_active').default(true),
  currentSessionId: text('current_session_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({ companySlugUnique: unique().on(table.companyId, table.slug) }));

export const agentRuntimes = pgTable('agent_runtimes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id),
  name: text('name').notNull(),
  adapterType: text('adapter_type').notNull(),
  config: jsonb('config').default({}),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const kanbanCards = pgTable('kanban_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  departmentId: uuid('department_id').references(() => departments.id),
  projectId: uuid('project_id').references(() => projects.id),
  goalId: uuid('goal_id').references(() => goals.id),
  parentCardId: uuid('parent_card_id'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  columnStatus: text('column_status').default('todo'),
  priority: integer('priority').default(0),
  tags: text('tags').array().default([]),
  assigneeId: uuid('assignee_id').references(() => agents.id),
  reviewerId: uuid('reviewer_id').references(() => agents.id),
  dependencyCardIds: uuid('dependency_card_ids').array().default([]),
  requiresApproval: boolean('requires_approval').default(false),
  retryCount: integer('retry_count').default(0),
  maxRetries: integer('max_retries').default(3),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastError: text('last_error'),
  reviewFeedback: text('review_feedback'),
  createdBy: uuid('created_by').references(() => users.id),
  executionLog: text('execution_log'),
  sessionId: text('session_id'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  executionLockId: uuid('execution_lock_id'),
  executionLockedByAgentId: uuid('execution_locked_by_agent_id').references(() => agents.id),
  executionLockedAt: timestamp('execution_locked_at', { withTimezone: true }),
  executionLockExpiresAt: timestamp('execution_lock_expires_at', { withTimezone: true }),
  activeHeartbeatRunId: uuid('active_heartbeat_run_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const heartbeatRuns = pgTable('heartbeat_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  cardId: uuid('card_id').references(() => kanbanCards.id),
  agentId: uuid('agent_id').references(() => agents.id),
  source: text('source').notNull(),
  status: text('status').notNull().default('running'),
  lockAcquiredAt: timestamp('lock_acquired_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  error: text('error'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const taskRuns = pgTable('task_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  cardId: uuid('card_id').notNull().references(() => kanbanCards.id),
  agentId: uuid('agent_id').references(() => agents.id),
  heartbeatRunId: uuid('heartbeat_run_id').references(() => heartbeatRuns.id),
  kind: text('kind').notNull().default('dispatch'),
  source: text('source').notNull().default('queue'),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').default(0),
  attemptNumber: integer('attempt_number').default(1),
  maxAttempts: integer('max_attempts').default(1),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  error: text('error'),
  output: text('output'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const taskLogs = pgTable('task_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => kanbanCards.id),
  agentId: uuid('agent_id').references(() => agents.id),
  type: text('type').notNull(),
  status: text('status').notNull(),
  message: text('message').notNull(),
  output: text('output'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  durationSeconds: integer('duration_seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const cardComments = pgTable('card_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => kanbanCards.id),
  authorType: text('author_type').notNull().default('user'),
  authorId: uuid('author_id').references(() => users.id),
  agentId: uuid('agent_id').references(() => agents.id),
  body: text('body').notNull(),
  action: text('action').notNull().default('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  userId: uuid('user_id').references(() => users.id),
  title: text('title').notNull(),
  status: text('status').notNull().default('active'),
  agentSessionId: text('agent_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => chatSessions.id),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  userId: uuid('user_id').references(() => users.id),
  authorType: text('author_type').notNull(),
  body: text('body').notNull(),
  metadata: jsonb('metadata').default({}),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
  durationSeconds: integer('duration_seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const apiEvents = pgTable('api_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  method: text('method').notNull(),
  path: text('path').notNull(),
  statusCode: integer('status_code'),
  requestBody: jsonb('request_body'),
  responseBody: jsonb('response_body'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const cronRuns = pgTable('cron_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  source: text('source').notNull().default('loop'),
  status: text('status').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  error: text('error'),
  details: jsonb('details').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id').notNull().default('system'),
  agentId: uuid('agent_id').references(() => agents.id),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  details: jsonb('details').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const costEvents = pgTable('cost_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  cardId: uuid('card_id').references(() => kanbanCards.id),
  projectId: uuid('project_id').references(() => projects.id),
  goalId: uuid('goal_id').references(() => goals.id),
  provider: text('provider').notNull().default('unknown'),
  model: text('model').notNull().default('unknown'),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull(),
  billingCode: text('billing_code'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow(),
});

export const budgetPolicies = pgTable('budget_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  agentId: uuid('agent_id').references(() => agents.id),
  name: text('name').notNull(),
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 10, scale: 4 }),
  perTaskLimitUsd: numeric('per_task_limit_usd', { precision: 10, scale: 4 }),
  warnAtPercent: integer('warn_at_percent').default(80),
  hardStop: boolean('hard_stop').default(true),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  cardId: uuid('card_id').references(() => kanbanCards.id),
  type: text('type').notNull().default('task_review'),
  status: text('status').notNull().default('pending'),
  requestedByAgentId: uuid('requested_by_agent_id').references(() => agents.id),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
  payload: jsonb('payload').default({}),
  decisionNote: text('decision_note'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const knowledgeDocs = pgTable('knowledge_docs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  tags: text('tags').array().default([]),
  body: text('body').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
