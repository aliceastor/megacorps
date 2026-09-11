export const chatJobsMigrationSql = `
CREATE TABLE IF NOT EXISTS chat_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  response_message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  heartbeat_run_id uuid NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_jobs_active_session ON chat_jobs(session_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS chat_jobs_active_agent ON chat_jobs(agent_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS chat_jobs_poll ON chat_jobs(status, lease_expires_at);
`;
