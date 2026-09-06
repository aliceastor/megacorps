/** Additive migration: published versions 1–29 remain immutable. */
export const usageLedgerMigration = `
ALTER TABLE cost_events ALTER COLUMN cost_usd TYPE NUMERIC(20,8), ALTER COLUMN cost_usd DROP NOT NULL;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS attempt_key TEXT UNIQUE;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS task_run_id UUID REFERENCES task_runs(id);
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS heartbeat_run_id UUID REFERENCES heartbeat_runs(id);
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS runtime_id UUID REFERENCES agent_runtimes(id);
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS reporting_source TEXT;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS provider_event_id TEXT;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS usage JSONB;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy_fixed_rate';
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'estimated';
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS reservation_usd NUMERIC(20,8);
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS cost_events_provider_event_unique ON cost_events(reporting_source, provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_events_task_run_idx ON cost_events(task_run_id);
CREATE INDEX IF NOT EXISTS cost_events_heartbeat_idx ON cost_events(heartbeat_run_id);
CREATE INDEX IF NOT EXISTS cost_events_card_occurred_idx ON cost_events(card_id, occurred_at);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cost_events'::regclass AND conname = 'cost_events_usage_status') THEN
    ALTER TABLE cost_events ADD CONSTRAINT cost_events_usage_status CHECK (cost_status IN ('actual','estimated','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cost_events'::regclass AND conname = 'cost_events_nonnegative') THEN
    ALTER TABLE cost_events ADD CONSTRAINT cost_events_nonnegative CHECK ((cost_usd IS NULL OR cost_usd >= 0) AND (reservation_usd IS NULL OR reservation_usd >= 0));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS budget_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id),
  threshold_key TEXT NOT NULL UNIQUE, details JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE agents ALTER COLUMN budget_per_task TYPE NUMERIC(20,8), ALTER COLUMN budget_monthly TYPE NUMERIC(20,8), ALTER COLUMN spent_this_month TYPE NUMERIC(20,8);
ALTER TABLE kanban_cards ALTER COLUMN cost_usd TYPE NUMERIC(20,8), ALTER COLUMN task_budget_limit TYPE NUMERIC(20,8);
ALTER TABLE task_runs ALTER COLUMN cost_usd TYPE NUMERIC(20,8);
ALTER TABLE heartbeat_runs ALTER COLUMN cost_usd TYPE NUMERIC(20,8);
ALTER TABLE task_logs ALTER COLUMN cost_usd TYPE NUMERIC(20,8);
ALTER TABLE chat_messages ALTER COLUMN cost_usd TYPE NUMERIC(20,8);
ALTER TABLE budget_policies ALTER COLUMN monthly_limit_usd TYPE NUMERIC(20,8), ALTER COLUMN per_task_limit_usd TYPE NUMERIC(20,8);
`;
