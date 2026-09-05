// Every gate writer joins the card lock used by claim. Claim does not lock
// approval/wait/child/project rows, avoiding lock inversions with their triggers.
export const managedMergeMigration = `
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_merge_after_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_repo_full_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS merge_readiness JSONB;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS merge_gate_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS merge_intents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), card_id UUID NOT NULL REFERENCES kanban_cards(id),
 project_id UUID NOT NULL, wait_id UUID NOT NULL UNIQUE, head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
 repo_full_name TEXT NOT NULL, default_branch TEXT NOT NULL, gate_version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared', attempt_count INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TIMESTAMPTZ, last_result TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merge_intents_active_card_idx ON merge_intents(card_id, state);
CREATE OR REPLACE FUNCTION mc_merge_gate_fence(target UUID, invalidate BOOLEAN DEFAULT true) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF target IS NULL THEN RETURN; END IF;
 PERFORM id FROM kanban_cards WHERE id = target FOR UPDATE;
 IF EXISTS (SELECT 1 FROM merge_intents WHERE card_id = target AND state IN ('in_flight','accepted','uncertain')) THEN
   RAISE EXCEPTION USING ERRCODE = 'MC409', MESSAGE = 'merge_in_flight: Gitea may already have accepted the authorized merge. This gate change cannot guarantee cancellation; reconcile the merge before changing authorization.';
 END IF;
 IF invalidate THEN UPDATE kanban_cards SET merge_gate_version = merge_gate_version + 1 WHERE id = target; END IF;
END $$;
CREATE OR REPLACE FUNCTION mc_merge_card_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; target UUID;
BEGIN
 before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 -- Logs, heartbeat settlement and diagnostics do not alter product authority.
 IF TG_OP = 'UPDATE' AND (before_row - ARRAY['updated_at','last_error','execution_log','cost_usd','merge_gate_version','execution_lock_id','execution_locked_by_agent_id','execution_locked_at','execution_lock_expires_at','active_heartbeat_run_id','session_id','started_at','next_run_at']) =
 (after_row - ARRAY['updated_at','last_error','execution_log','cost_usd','merge_gate_version','execution_lock_id','execution_locked_by_agent_id','execution_locked_at','execution_lock_expires_at','active_heartbeat_run_id','session_id','started_at','next_run_at']) THEN RETURN NEW; END IF;
 IF TG_OP <> 'INSERT' THEN
   PERFORM mc_merge_gate_fence(OLD.id, false);
   IF TG_OP = 'UPDATE' THEN NEW.merge_gate_version := OLD.merge_gate_version + 1; END IF;
 END IF;
 FOR target IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'parent_card_id', after_row->>'parent_card_id')) WHERE value IS NOT NULL ORDER BY value::uuid LOOP
   PERFORM mc_merge_gate_fence(target);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_merge_card_gate ON kanban_cards;
CREATE TRIGGER mc_merge_card_gate BEFORE INSERT OR UPDATE OR DELETE ON kanban_cards FOR EACH ROW EXECUTE FUNCTION mc_merge_card_gate();
CREATE OR REPLACE FUNCTION mc_merge_related_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID; before_row JSONB; after_row JSONB; invalidates BOOLEAN;
BEGIN
 before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME = 'external_waits' AND TG_OP = 'UPDATE' AND
 (before_row - ARRAY['poll_count','last_polled_at','poll_interval_seconds']) = (after_row - ARRAY['poll_count','last_polled_at','poll_interval_seconds']) THEN RETURN NEW; END IF;
 -- Settling an approval/round which preceded authorization does not invalidate
 -- it. Opening/changing a gate does, even if later settled back to the same shape.
 invalidates := TG_TABLE_NAME = 'external_waits' OR TG_OP = 'DELETE' OR
   (TG_TABLE_NAME = 'approvals' AND after_row->>'status' = 'pending') OR
   (TG_TABLE_NAME = 'review_rounds' AND after_row->>'status' IN ('open','closing'));
 FOR target IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'card_id', after_row->>'card_id')) WHERE value IS NOT NULL ORDER BY value::uuid LOOP
   PERFORM mc_merge_gate_fence(target, invalidates);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_merge_approval_gate ON approvals;
CREATE TRIGGER mc_merge_approval_gate BEFORE INSERT OR UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION mc_merge_related_gate();
DROP TRIGGER IF EXISTS mc_merge_review_gate ON review_rounds;
CREATE TRIGGER mc_merge_review_gate BEFORE INSERT OR UPDATE OR DELETE ON review_rounds FOR EACH ROW EXECUTE FUNCTION mc_merge_related_gate();
DROP TRIGGER IF EXISTS mc_merge_wait_gate ON external_waits;
CREATE TRIGGER mc_merge_wait_gate BEFORE INSERT OR UPDATE OR DELETE ON external_waits FOR EACH ROW EXECUTE FUNCTION mc_merge_related_gate();
CREATE OR REPLACE FUNCTION mc_merge_project_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
 IF TG_OP = 'UPDATE' AND ROW(OLD.repo_provider,OLD.repo_url,OLD.default_branch,OLD.auto_merge_after_approval,OLD.completion_requires_merge,OLD.managed_repo_full_name,OLD.deleted_at) IS NOT DISTINCT FROM ROW(NEW.repo_provider,NEW.repo_url,NEW.default_branch,NEW.auto_merge_after_approval,NEW.completion_requires_merge,NEW.managed_repo_full_name,NEW.deleted_at) THEN RETURN NEW; END IF;
 FOR target IN SELECT id FROM kanban_cards WHERE project_id = OLD.id ORDER BY id LOOP
  PERFORM mc_merge_gate_fence(target);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_merge_project_gate ON projects;
CREATE TRIGGER mc_merge_project_gate BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION mc_merge_project_gate();
`;

// Additive: migration 22 was already published and executed by the PG CI.
export const managedMergeRunFenceMigration = `
ALTER TABLE merge_intents ADD COLUMN IF NOT EXISTS originating_task_run_id UUID;
CREATE OR REPLACE FUNCTION mc_merge_task_run_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; target UUID;
BEGIN
 before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF TG_OP <> 'DELETE' AND NEW.kind IN ('dispatch','review','panel_review') AND NEW.status IN ('queued','running') AND
   (TG_OP = 'INSERT' OR before_row->>'status' NOT IN ('queued','running') OR
    before_row->>'card_id' IS DISTINCT FROM after_row->>'card_id' OR before_row->>'kind' IS DISTINCT FROM after_row->>'kind' OR before_row->>'agent_id' IS DISTINCT FROM after_row->>'agent_id') THEN
   FOR target IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'card_id', after_row->>'card_id')) WHERE value IS NOT NULL ORDER BY value::uuid LOOP
     PERFORM mc_merge_gate_fence(target);
   END LOOP;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_merge_task_run_gate ON task_runs;
CREATE TRIGGER mc_merge_task_run_gate BEFORE INSERT OR UPDATE ON task_runs FOR EACH ROW EXECUTE FUNCTION mc_merge_task_run_gate();
`;

// Migration 24: UPDATE already owns its project/task row. Acquire every card
// without waiting, so a child->parent or card->run writer can finish after the
// failed statement/transaction rolls back. Callers retry the whole DB operation.
export const managedMergeLockOrderMigration = `
CREATE OR REPLACE FUNCTION mc_merge_project_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target UUID; targets UUID[];
BEGIN
 IF TG_OP = 'UPDATE' AND ROW(OLD.repo_provider,OLD.repo_url,OLD.default_branch,OLD.auto_merge_after_approval,OLD.completion_requires_merge,OLD.managed_repo_full_name,OLD.deleted_at) IS NOT DISTINCT FROM ROW(NEW.repo_provider,NEW.repo_url,NEW.default_branch,NEW.auto_merge_after_approval,NEW.completion_requires_merge,NEW.managed_repo_full_name,NEW.deleted_at) THEN RETURN NEW; END IF;
 SELECT array_agg(id ORDER BY id) INTO targets FROM kanban_cards WHERE project_id = OLD.id;
 IF targets IS NOT NULL THEN
  PERFORM id FROM kanban_cards WHERE id = ANY(targets) ORDER BY id FOR UPDATE NOWAIT;
  -- Use exactly the locked set, not a new query that could see unlocked cards.
  FOREACH target IN ARRAY targets LOOP PERFORM mc_merge_gate_fence(target); END LOOP;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION mc_merge_task_run_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; target UUID; targets UUID[];
BEGIN
 before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := to_jsonb(NEW);
 IF NEW.kind IN ('dispatch','review','panel_review') AND NEW.status IN ('queued','running') AND
   (TG_OP = 'INSERT' OR before_row->>'status' NOT IN ('queued','running') OR
    before_row->>'card_id' IS DISTINCT FROM after_row->>'card_id' OR before_row->>'kind' IS DISTINCT FROM after_row->>'kind' OR before_row->>'agent_id' IS DISTINCT FROM after_row->>'agent_id') THEN
   SELECT array_agg(value::uuid ORDER BY value::uuid) INTO targets FROM
     (SELECT DISTINCT value FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'card_id', after_row->>'card_id')) WHERE value IS NOT NULL) ids;
   IF targets IS NOT NULL THEN
     IF TG_OP = 'UPDATE' THEN
       PERFORM id FROM kanban_cards WHERE id = ANY(targets) ORDER BY id FOR UPDATE NOWAIT;
     END IF;
     FOREACH target IN ARRAY targets LOOP PERFORM mc_merge_gate_fence(target); END LOOP;
   END IF;
 END IF;
 RETURN NEW;
END $$;
`;
