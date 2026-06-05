import { sql } from './client.ts';

export async function migrate(): Promise<void> {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT, avatar_url TEXT, role TEXT DEFAULT 'viewer', locale TEXT DEFAULT 'zh-TW', theme TEXT DEFAULT 'system', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS companies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID REFERENCES groups(id), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, mission TEXT, dispatch_interval_seconds INTEGER DEFAULT 10, auto_dispatch_enabled BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE companies ADD COLUMN IF NOT EXISTS mission TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS dispatch_interval_seconds INTEGER DEFAULT 10;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN DEFAULT true;
CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), name TEXT NOT NULL, slug TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), name TEXT NOT NULL, description TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS goals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), title TEXT NOT NULL, body TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), department_id UUID REFERENCES departments(id), slug TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, title TEXT, adapter_type TEXT NOT NULL DEFAULT 'hermes', adapter_config JSONB DEFAULT '{}', runtime_id UUID, hermes_profile TEXT, boss_id UUID REFERENCES agents(id), budget_per_task NUMERIC(10,4), budget_monthly NUMERIC(10,4), spent_this_month NUMERIC(10,4) DEFAULT 0, capabilities TEXT[] DEFAULT '{}', is_busy BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true, current_session_id TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(company_id, slug));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS runtime_id UUID;
CREATE TABLE IF NOT EXISTS agent_runtimes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, adapter_type TEXT NOT NULL, config JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE agent_runtimes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE TABLE IF NOT EXISTS kanban_cards (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), department_id UUID REFERENCES departments(id), project_id UUID REFERENCES projects(id), goal_id UUID REFERENCES goals(id), parent_card_id UUID REFERENCES kanban_cards(id), title TEXT NOT NULL, body TEXT NOT NULL, column_status TEXT DEFAULT 'backlog', priority INTEGER DEFAULT 0, tags TEXT[] DEFAULT '{}', assignee_id UUID REFERENCES agents(id), reviewer_id UUID REFERENCES agents(id), dependency_card_ids UUID[] DEFAULT '{}', requires_approval BOOLEAN DEFAULT false, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, next_run_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, last_error TEXT, review_feedback TEXT, created_by UUID REFERENCES users(id), execution_log TEXT, session_id TEXT, cost_usd NUMERIC(10,4), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS review_feedback TEXT;
CREATE TABLE IF NOT EXISTS task_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), card_id UUID NOT NULL REFERENCES kanban_cards(id), agent_id UUID REFERENCES agents(id), type TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, output TEXT, cost_usd NUMERIC(10,4), duration_seconds INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS task_logs_card_id_created_at_idx ON task_logs(card_id, created_at DESC);
CREATE TABLE IF NOT EXISTS card_comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), card_id UUID NOT NULL REFERENCES kanban_cards(id), author_type TEXT NOT NULL DEFAULT 'user', author_id UUID REFERENCES users(id), body TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'comment', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS card_comments_card_id_created_at_idx ON card_comments(card_id, created_at DESC);
CREATE TABLE IF NOT EXISTS api_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER, request_body JSONB, response_body JSONB, error TEXT, duration_ms INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS api_events_created_at_idx ON api_events(created_at DESC);
CREATE INDEX IF NOT EXISTS api_events_user_id_created_at_idx ON api_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id), title TEXT NOT NULL, tags TEXT[] DEFAULT '{}', body TEXT NOT NULL, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS knowledge_docs_company_id_updated_at_idx ON knowledge_docs(company_id, updated_at DESC);
INSERT INTO task_logs (card_id, type, status, message, created_at)
SELECT kc.id, 'stage', 'success', 'Initial stage recorded: ' || kc.column_status, kc.created_at
FROM kanban_cards kc
WHERE NOT EXISTS (SELECT 1 FROM task_logs tl WHERE tl.card_id = kc.id AND tl.type = 'stage');`);
  const companies = await sql`SELECT id FROM companies WHERE slug = 'default' LIMIT 1`;
  if (companies.length === 0) await sql`INSERT INTO companies (name, slug) VALUES ('Default Company', 'default')`;
  const runtimes = await sql`SELECT id FROM agent_runtimes WHERE name = 'Local Mock Runtime' LIMIT 1`;
  if (runtimes.length === 0) await sql`INSERT INTO agent_runtimes (name, adapter_type, config, is_active) VALUES ('Local Mock Runtime', 'mock', '{}', true)`;
}
