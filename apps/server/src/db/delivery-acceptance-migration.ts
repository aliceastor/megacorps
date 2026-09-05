// Acceptance is server-authored. Clearing is monotonic across reopen/restore:
// restoring an old assignee/evidence payload cannot revive old approval.
export const deliveryAcceptanceMigration = `
ALTER TABLE card_comments ADD COLUMN IF NOT EXISTS accepted_delivery TEXT;
CREATE OR REPLACE FUNCTION mc_invalidate_delegated_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF COALESCE(CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.action END, '') NOT IN ('delegate_request','delegate_report') AND COALESCE(CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.action END, '') NOT IN ('delegate_request','delegate_report') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['accepted_delivery','updated_at']) = (to_jsonb(OLD) - ARRAY['accepted_delivery','updated_at']) THEN RETURN NEW; END IF;
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END;
  PERFORM id FROM kanban_cards WHERE id = target FOR UPDATE NOWAIT;
  UPDATE kanban_cards SET delivery_acceptance = NULL WHERE id = target AND delivery_acceptance IS NOT NULL;
  IF TG_OP <> 'INSERT' THEN
    UPDATE card_comments SET accepted_delivery = NULL WHERE parent_comment_id = OLD.id AND accepted_delivery IS NOT NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.accepted_delivery := NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_delivery_comment_changed ON card_comments;
CREATE TRIGGER mc_delivery_comment_changed BEFORE INSERT OR UPDATE OR DELETE ON card_comments FOR EACH ROW EXECUTE FUNCTION mc_invalidate_delegated_delivery();
CREATE OR REPLACE FUNCTION mc_invalidate_delivery_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merge_gate_version IS DISTINCT FROM OLD.merge_gate_version OR ROW(NEW.column_status, NEW.company_id, NEW.project_id, NEW.parent_card_id, NEW.title, NEW.body,
         NEW.assignee_id, NEW.reviewer_id, NEW.requires_approval, NEW.review_mode, NEW.critical,
         NEW.decision_mode, NEW.coordination_only, NEW.required_child_policy, NEW.child_requirement_level, NEW.dependency_card_ids, NEW.tags, NEW.deleted_at)
     IS DISTINCT FROM
     ROW(OLD.column_status, OLD.company_id, OLD.project_id, OLD.parent_card_id, OLD.title, OLD.body,
         OLD.assignee_id, OLD.reviewer_id, OLD.requires_approval, OLD.review_mode, OLD.critical,
         OLD.decision_mode, OLD.coordination_only, OLD.required_child_policy, OLD.child_requirement_level, OLD.dependency_card_ids, OLD.tags, OLD.deleted_at)
  THEN NEW.delivery_acceptance := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_delivery_card_changed ON kanban_cards;
CREATE TRIGGER mc_delivery_card_changed BEFORE UPDATE ON kanban_cards FOR EACH ROW EXECUTE FUNCTION mc_invalidate_delivery_acceptance();
CREATE OR REPLACE FUNCTION mc_invalidate_delivery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; targets uuid[];
BEGIN
  SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO targets FROM jsonb_array_elements_text(jsonb_build_array(
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.card_id END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.card_id END)) WHERE value IS NOT NULL;
  IF targets IS NOT NULL THEN
    -- Evidence UPDATE/DELETE already owns its row; never wait backwards for a card.
    PERFORM id FROM kanban_cards WHERE id = ANY(targets) ORDER BY id FOR UPDATE NOWAIT;
    FOREACH target IN ARRAY targets LOOP
      UPDATE kanban_cards SET delivery_acceptance = NULL WHERE id = target AND delivery_acceptance IS NOT NULL;
      IF TG_TABLE_NAME = 'work_products' THEN UPDATE card_comments SET accepted_delivery = NULL WHERE card_id = target AND accepted_delivery IS NOT NULL; END IF;
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS mc_delivery_product_changed ON work_products;
CREATE TRIGGER mc_delivery_product_changed BEFORE INSERT OR UPDATE OR DELETE ON work_products FOR EACH ROW EXECUTE FUNCTION mc_invalidate_delivery_evidence();
DROP TRIGGER IF EXISTS mc_delivery_approval_changed ON approvals;
CREATE TRIGGER mc_delivery_approval_changed BEFORE INSERT OR UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION mc_invalidate_delivery_evidence();
DROP TRIGGER IF EXISTS mc_delivery_review_changed ON review_rounds;
CREATE TRIGGER mc_delivery_review_changed BEFORE INSERT OR UPDATE OR DELETE ON review_rounds FOR EACH ROW EXECUTE FUNCTION mc_invalidate_delivery_evidence();
CREATE OR REPLACE FUNCTION mc_invalidate_company_delivery_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE targets uuid[];
BEGIN
  IF NEW.panel_review_default IS NOT DISTINCT FROM OLD.panel_review_default THEN RETURN NEW; END IF;
  SELECT array_agg(id ORDER BY id) INTO targets FROM kanban_cards WHERE company_id = OLD.id AND delivery_acceptance IS NOT NULL;
  IF targets IS NOT NULL THEN
    PERFORM id FROM kanban_cards WHERE id = ANY(targets) ORDER BY id FOR UPDATE NOWAIT;
    UPDATE kanban_cards SET delivery_acceptance = NULL WHERE id = ANY(targets);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mc_delivery_company_policy_changed ON companies;
CREATE TRIGGER mc_delivery_company_policy_changed BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION mc_invalidate_company_delivery_policy();
`;
