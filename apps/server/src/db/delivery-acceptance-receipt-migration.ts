// Migration 26: preserve published migrations 1-25.
export const deliveryAcceptanceReceiptMigration = `
CREATE OR REPLACE FUNCTION mc_merge_card_gate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE before_row JSONB; after_row JSONB; target UUID;
BEGIN
 before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 -- Receipt mint/refresh is server bookkeeping, not a change in authority.
 -- Revocation still fences the card and parent, as evidence/gate triggers rely
 -- on that propagation. Other columns retain the published gate behavior.
 IF TG_OP = 'UPDATE' AND (NEW.delivery_acceptance IS NOT NULL OR OLD.delivery_acceptance IS NULL) AND (before_row - ARRAY['updated_at','last_error','execution_log','cost_usd','merge_gate_version','execution_lock_id','execution_locked_by_agent_id','execution_locked_at','execution_lock_expires_at','active_heartbeat_run_id','session_id','started_at','next_run_at','delivery_acceptance']) =
 (after_row - ARRAY['updated_at','last_error','execution_log','cost_usd','merge_gate_version','execution_lock_id','execution_locked_by_agent_id','execution_locked_at','execution_lock_expires_at','active_heartbeat_run_id','session_id','started_at','next_run_at','delivery_acceptance']) THEN RETURN NEW; END IF;
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
`;
