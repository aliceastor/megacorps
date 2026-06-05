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
  hermesProfile: text('hermes_profile'),
  bossId: uuid('boss_id'),
  budgetPerTask: numeric('budget_per_task', { precision: 10, scale: 4 }),
  budgetMonthly: numeric('budget_monthly', { precision: 10, scale: 4 }),
  spentThisMonth: numeric('spent_this_month', { precision: 10, scale: 4 }).default('0'),
  capabilities: text('capabilities').array().default([]),
  isBusy: boolean('is_busy').default(false),
  isActive: boolean('is_active').default(true),
  currentSessionId: text('current_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({ companySlugUnique: unique().on(table.companyId, table.slug) }));

export const agentRuntimes = pgTable('agent_runtimes', { id: uuid('id').primaryKey().defaultRandom(), name: text('name').notNull(), adapterType: text('adapter_type').notNull(), config: jsonb('config').default({}), isActive: boolean('is_active').default(true), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow() });

export const kanbanCards = pgTable('kanban_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  departmentId: uuid('department_id').references(() => departments.id),
  projectId: uuid('project_id').references(() => projects.id),
  goalId: uuid('goal_id').references(() => goals.id),
  parentCardId: uuid('parent_card_id'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  columnStatus: text('column_status').default('backlog'),
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
  body: text('body').notNull(),
  action: text('action').notNull().default('comment'),
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
