import { pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents, chatMessages, chatSessions, companies, heartbeatRuns, users } from './schema.ts';

export const chatJobs = pgTable('chat_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userMessageId: uuid('user_message_id').notNull().unique().references(() => chatMessages.id, { onDelete: 'cascade' }),
  responseMessageId: uuid('response_message_id').notNull().defaultRandom(),
  heartbeatRunId: uuid('heartbeat_run_id').notNull().references(() => heartbeatRuns.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('chat_jobs_active_session').on(table.sessionId).where(sql`${table.status} in ('queued', 'running')`),
  uniqueIndex('chat_jobs_active_agent').on(table.agentId).where(sql`${table.status} in ('queued', 'running')`),
]);
export type ChatJob = typeof chatJobs.$inferSelect;
