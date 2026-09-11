export const a2aPollingMigrationSql = `
CREATE TABLE IF NOT EXISTS a2a_executions (
  key TEXT PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  record JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS a2a_executions_active_scope_idx ON a2a_executions(scope) WHERE active;
CREATE TABLE IF NOT EXISTS a2a_execution_aliases (
  key TEXT PRIMARY KEY,
  execution_key TEXT NOT NULL REFERENCES a2a_executions(key) ON DELETE CASCADE
);
`;
