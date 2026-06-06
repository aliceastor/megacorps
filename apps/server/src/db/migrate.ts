import { sql } from './client.ts';

export async function migrate(): Promise<void> {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT, avatar_url TEXT, role TEXT DEFAULT 'viewer', status TEXT NOT NULL DEFAULT 'active', locale TEXT DEFAULT 'zh-TW', theme TEXT DEFAULT 'system', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO app_settings (key, value) VALUES ('auth.signup_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('auth.jwt_secret', encode(gen_random_bytes(32), 'base64')) ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS companies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID REFERENCES groups(id), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, mission TEXT, dispatch_interval_seconds INTEGER DEFAULT 10, auto_dispatch_enabled BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE companies ADD COLUMN IF NOT EXISTS mission TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS dispatch_interval_seconds INTEGER DEFAULT 10;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN DEFAULT true;
CREATE TABLE IF NOT EXISTS company_memberships (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), user_id UUID NOT NULL REFERENCES users(id), role TEXT NOT NULL DEFAULT 'viewer', status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(company_id, user_id));
CREATE INDEX IF NOT EXISTS company_memberships_user_status_idx ON company_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS company_memberships_company_role_idx ON company_memberships(company_id, role);
CREATE TABLE IF NOT EXISTS user_invites (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), email TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'viewer', token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', invited_by_user_id UUID REFERENCES users(id), accepted_by_user_id UUID REFERENCES users(id), expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS user_invites_company_status_idx ON user_invites(company_id, status);
CREATE INDEX IF NOT EXISTS user_invites_email_status_idx ON user_invites(email, status);
CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), name TEXT NOT NULL, slug TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), name TEXT NOT NULL, description TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS goals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), title TEXT NOT NULL, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), department_id UUID REFERENCES departments(id), slug TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, title TEXT, adapter_type TEXT NOT NULL DEFAULT 'hermes', adapter_config JSONB DEFAULT '{}', runtime_id UUID, hermes_profile TEXT, boss_id UUID REFERENCES agents(id), budget_per_task NUMERIC(10,4), budget_monthly NUMERIC(10,4), spent_this_month NUMERIC(10,4) DEFAULT 0, capabilities TEXT[] DEFAULT '{}', is_busy BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true, current_session_id TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(company_id, slug));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_id UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS agents_company_deleted_at_idx ON agents(company_id, deleted_at);
CREATE TABLE IF NOT EXISTS agent_runtimes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID REFERENCES companies(id), name TEXT NOT NULL, adapter_type TEXT NOT NULL, config JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE agent_runtimes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE agent_runtimes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE TABLE IF NOT EXISTS kanban_cards (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), department_id UUID REFERENCES departments(id), project_id UUID REFERENCES projects(id), goal_id UUID REFERENCES goals(id), parent_card_id UUID REFERENCES kanban_cards(id), title TEXT NOT NULL, body TEXT NOT NULL, column_status TEXT DEFAULT 'todo', priority INTEGER DEFAULT 0, tags TEXT[] DEFAULT '{}', assignee_id UUID REFERENCES agents(id), reviewer_id UUID REFERENCES agents(id), dependency_card_ids UUID[] DEFAULT '{}', requires_approval BOOLEAN DEFAULT false, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, next_run_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, last_error TEXT, review_feedback TEXT, created_by UUID REFERENCES users(id), execution_log TEXT, session_id TEXT, cost_usd NUMERIC(10,4), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE kanban_cards ALTER COLUMN column_status SET DEFAULT 'todo';
UPDATE kanban_cards SET column_status = 'todo', updated_at = now() WHERE column_status = 'backlog';
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS review_feedback TEXT;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS execution_lock_id UUID;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS execution_locked_by_agent_id UUID REFERENCES agents(id);
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS execution_locked_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS execution_lock_expires_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS active_heartbeat_run_id UUID;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS kanban_cards_execution_lock_expires_at_idx ON kanban_cards(execution_lock_expires_at);
CREATE INDEX IF NOT EXISTS kanban_cards_company_deleted_at_idx ON kanban_cards(company_id, deleted_at);
CREATE TABLE IF NOT EXISTS heartbeat_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), card_id UUID REFERENCES kanban_cards(id), agent_id UUID REFERENCES agents(id), source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', lock_acquired_at TIMESTAMPTZ, started_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ, duration_seconds INTEGER, error TEXT, cost_usd NUMERIC(10,4), input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS heartbeat_runs_company_created_at_idx ON heartbeat_runs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS heartbeat_runs_card_created_at_idx ON heartbeat_runs(card_id, created_at DESC);
CREATE TABLE IF NOT EXISTS task_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), card_id UUID NOT NULL REFERENCES kanban_cards(id), agent_id UUID REFERENCES agents(id), heartbeat_run_id UUID REFERENCES heartbeat_runs(id), kind TEXT NOT NULL DEFAULT 'dispatch', source TEXT NOT NULL DEFAULT 'queue', status TEXT NOT NULL DEFAULT 'queued', priority INTEGER DEFAULT 0, attempt_number INTEGER DEFAULT 1, max_attempts INTEGER DEFAULT 1, requested_by_user_id UUID REFERENCES users(id), locked_by TEXT, locked_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, duration_seconds INTEGER, error TEXT, output TEXT, cost_usd NUMERIC(10,4), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS task_runs_company_created_at_idx ON task_runs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_runs_card_created_at_idx ON task_runs(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_runs_status_created_at_idx ON task_runs(status, created_at ASC);
CREATE TABLE IF NOT EXISTS cron_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'loop', status TEXT NOT NULL DEFAULT 'running', started_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ, duration_seconds INTEGER, error TEXT, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS cron_runs_name_created_at_idx ON cron_runs(name, created_at DESC);
CREATE TABLE IF NOT EXISTS task_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), card_id UUID NOT NULL REFERENCES kanban_cards(id), agent_id UUID REFERENCES agents(id), type TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, output TEXT, cost_usd NUMERIC(10,4), duration_seconds INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS task_logs_card_id_created_at_idx ON task_logs(card_id, created_at DESC);
CREATE TABLE IF NOT EXISTS card_comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), card_id UUID NOT NULL REFERENCES kanban_cards(id), author_type TEXT NOT NULL DEFAULT 'user', author_id UUID REFERENCES users(id), body TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'comment', created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE card_comments ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
CREATE INDEX IF NOT EXISTS card_comments_card_id_created_at_idx ON card_comments(card_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chat_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), agent_id UUID NOT NULL REFERENCES agents(id), user_id UUID REFERENCES users(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', agent_session_id TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_sessions_company_agent_updated_at_idx ON chat_sessions(company_id, agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_at_idx ON chat_sessions(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL REFERENCES chat_sessions(id), company_id UUID NOT NULL REFERENCES companies(id), agent_id UUID NOT NULL REFERENCES agents(id), user_id UUID REFERENCES users(id), author_type TEXT NOT NULL, body TEXT NOT NULL, metadata JSONB DEFAULT '{}', cost_usd NUMERIC(10,4), duration_seconds INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_messages_session_created_at_idx ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS chat_messages_agent_created_at_idx ON chat_messages(agent_id, created_at DESC);
CREATE TABLE IF NOT EXISTS api_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER, request_body JSONB, response_body JSONB, error TEXT, duration_ms INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS api_events_created_at_idx ON api_events(created_at DESC);
CREATE INDEX IF NOT EXISTS api_events_user_id_created_at_idx ON api_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS activity_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), actor_type TEXT NOT NULL DEFAULT 'system', actor_id TEXT NOT NULL DEFAULT 'system', agent_id UUID REFERENCES agents(id), user_id UUID REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS activity_log_company_created_at_idx ON activity_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_entity_idx ON activity_log(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS cost_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), agent_id UUID NOT NULL REFERENCES agents(id), card_id UUID REFERENCES kanban_cards(id), project_id UUID REFERENCES projects(id), goal_id UUID REFERENCES goals(id), provider TEXT NOT NULL DEFAULT 'unknown', model TEXT NOT NULL DEFAULT 'unknown', input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_usd NUMERIC(10,4) NOT NULL, billing_code TEXT, occurred_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS cost_events_company_occurred_at_idx ON cost_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_agent_occurred_at_idx ON cost_events(agent_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS budget_policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), agent_id UUID REFERENCES agents(id), name TEXT NOT NULL, monthly_limit_usd NUMERIC(10,4), per_task_limit_usd NUMERIC(10,4), warn_at_percent INTEGER DEFAULT 80, hard_stop BOOLEAN DEFAULT true, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS budget_policies_company_active_idx ON budget_policies(company_id, is_active);
CREATE TABLE IF NOT EXISTS approvals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), card_id UUID REFERENCES kanban_cards(id), type TEXT NOT NULL DEFAULT 'task_review', status TEXT NOT NULL DEFAULT 'pending', requested_by_agent_id UUID REFERENCES agents(id), requested_by_user_id UUID REFERENCES users(id), payload JSONB DEFAULT '{}', decision_note TEXT, decided_by_user_id UUID REFERENCES users(id), decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS approvals_company_status_idx ON approvals(company_id, status);
CREATE INDEX IF NOT EXISTS approvals_card_status_idx ON approvals(card_id, status);
CREATE TABLE IF NOT EXISTS knowledge_docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), title TEXT NOT NULL, tags TEXT[] DEFAULT '{}', body TEXT NOT NULL, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS knowledge_docs_company_id_updated_at_idx ON knowledge_docs(company_id, updated_at DESC);
INSERT INTO task_logs (card_id, type, status, message, created_at)
SELECT kc.id, 'stage', 'success', 'Initial stage recorded: ' || kc.column_status, kc.created_at
FROM kanban_cards kc
WHERE NOT EXISTS (SELECT 1 FROM task_logs tl WHERE tl.card_id = kc.id AND tl.type = 'stage');`);
const companies = await sql`SELECT id FROM companies WHERE slug = 'default' LIMIT 1`;
  if (companies.length === 0) await sql`INSERT INTO companies (name, slug) VALUES ('Default Company', 'default')`;
  await sql`INSERT INTO company_memberships (company_id, user_id, role, status)
SELECT (SELECT id FROM companies WHERE slug = 'default' LIMIT 1), u.id, CASE WHEN u.role IN ('admin', 'operator') THEN u.role ELSE 'viewer' END, 'active'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM company_memberships cm WHERE cm.user_id = u.id
)`;
  await sql`UPDATE agent_runtimes SET company_id = (SELECT id FROM companies WHERE slug = 'default' LIMIT 1) WHERE company_id IS NULL`;
  const runtimes = await sql`SELECT id FROM agent_runtimes WHERE name = 'Local Mock Runtime' LIMIT 1`;
  if (runtimes.length === 0) await sql`INSERT INTO agent_runtimes (company_id, name, adapter_type, config, is_active) VALUES ((SELECT id FROM companies WHERE slug = 'default' LIMIT 1), 'Local Mock Runtime', 'mock', '{}', true)`;
}
