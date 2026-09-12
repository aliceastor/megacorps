/** v35 preserves recorded reporting edges while introducing manager-position eligibility. */
export const managerPositionMigrationSql = `
ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_company_leadership boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS organization_manager_migration(position_id uuid PRIMARY KEY, company_id uuid NOT NULL, old_manager_position_id uuid, new_manager_position_id uuid);
-- v34 validation must not rewrite/reject the evidence before the new rules exist.
ALTER TABLE positions DISABLE TRIGGER organization_validate_position;
ALTER TABLE positions DISABLE TRIGGER organization_after_position;
DO $$ DECLARE problem text; BEGIN
 SELECT string_agg(p.id::text, ',') INTO problem FROM positions p WHERE NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND
 (SELECT count(DISTINCT coalesce(b.position_id::text,'NULL')) FROM agents a LEFT JOIN agents b ON b.id=a.boss_id WHERE a.position_id=p.id AND a.deleted_at IS NULL AND a.boss_id IS NOT NULL)>1;
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_ambiguous_managers: %',problem; END IF;
 SELECT string_agg(a.id::text, ',') INTO problem FROM agents a JOIN positions p ON p.id=a.position_id LEFT JOIN agents b ON b.id=a.boss_id LEFT JOIN positions bp ON bp.id=b.position_id
 WHERE NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND a.deleted_at IS NULL AND a.boss_id IS NOT NULL
 AND (b.id IS NULL OR b.position_id IS NULL OR b.company_id<>a.company_id OR b.deleted_at IS NOT NULL OR NOT coalesce(b.is_active,false) OR NOT coalesce(bp.is_active,false));
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_invalid_supervisors: %',problem; END IF;
 INSERT INTO organization_manager_migration
 SELECT p.id,p.company_id,p.manager_position_id,(SELECT b.position_id FROM agents a JOIN agents b ON b.id=a.boss_id WHERE a.position_id=p.id AND a.deleted_at IS NULL AND a.boss_id IS NOT NULL LIMIT 1)
 FROM positions p WHERE NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND EXISTS(SELECT 1 FROM agents a WHERE a.position_id=p.id AND a.deleted_at IS NULL AND a.boss_id IS NOT NULL)
 ON CONFLICT DO NOTHING;
 UPDATE positions p SET manager_position_id=m.new_manager_position_id FROM organization_manager_migration m WHERE m.position_id=p.id;
 UPDATE positions SET is_company_leadership=true WHERE is_company_boss;
 UPDATE positions p SET manager_position_id=(SELECT id FROM positions b WHERE b.company_id=p.company_id AND b.is_company_boss AND b.is_active) WHERE p.is_department_head;
END $$;
ALTER TABLE positions DROP CONSTRAINT organization_position_role;
ALTER TABLE positions ADD CONSTRAINT organization_position_role CHECK (
 (coalesce(is_company_boss,false) AND is_company_leadership AND NOT is_department_head AND rank=0 AND default_department_id IS NULL AND manager_position_id IS NULL) OR
 (NOT coalesce(is_company_boss,false) AND ((is_department_head AND NOT is_company_leadership AND rank=1 AND default_department_id IS NOT NULL) OR
 (NOT is_department_head AND rank BETWEEN 2 AND 9 AND ((is_company_leadership AND default_department_id IS NULL) OR (NOT is_company_leadership AND default_department_id IS NOT NULL)))))
);
CREATE OR REPLACE FUNCTION organization_validate_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='55P03'; END;
 IF NEW.is_company_boss THEN NEW.rank=0; NEW.is_company_leadership=true;
 ELSIF NEW.is_department_head THEN NEW.rank=1;
  SELECT id INTO NEW.manager_position_id FROM positions WHERE company_id=NEW.company_id AND is_company_boss AND is_active;
 END IF;
 IF TG_OP='UPDATE' AND NEW.company_id<>OLD.company_id THEN RAISE EXCEPTION 'organization_position_company_immutable'; END IF;
 IF NEW.default_department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM departments WHERE id=NEW.default_department_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'organization_department_company_mismatch'; END IF;
 IF NEW.manager_position_id IS NOT NULL AND (NEW.manager_position_id=NEW.id OR NOT EXISTS(SELECT 1 FROM positions WHERE id=NEW.manager_position_id AND company_id=NEW.company_id)) THEN RAISE EXCEPTION 'organization_manager_position_company_mismatch'; END IF;
 IF NEW.manager_position_id IS NOT NULL AND EXISTS(WITH RECURSIVE chain(id,manager_position_id) AS (SELECT id,manager_position_id FROM positions WHERE id=NEW.manager_position_id UNION SELECT p.id,p.manager_position_id FROM positions p JOIN chain c ON p.id=c.manager_position_id) SELECT 1 FROM chain WHERE id=NEW.id) THEN RAISE EXCEPTION 'organization_position_cycle'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION organization_normalize_agent() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p positions%ROWTYPE; boss uuid; candidates uuid[]; position_changed boolean; BEGIN
 BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='55P03'; END;
 IF TG_OP='UPDATE' AND NEW.company_id<>OLD.company_id THEN RAISE EXCEPTION 'organization_agent_company_immutable'; END IF;
 NEW.organization_role=NULL;
 IF NEW.position_id IS NOT NULL THEN
  SELECT * INTO p FROM positions WHERE id=NEW.position_id AND company_id=NEW.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization_position_company_mismatch'; END IF;
  NEW.department_id=p.default_department_id;
  IF p.is_company_boss THEN NEW.department_id=NULL; NEW.boss_id=NULL; IF p.is_active THEN NEW.organization_role='boss'; END IF;
  ELSIF p.is_department_head THEN
   NEW.organization_role='head';
   SELECT a.id INTO boss FROM agents a JOIN positions bp ON bp.id=a.position_id WHERE a.company_id=NEW.company_id AND a.is_active AND a.deleted_at IS NULL AND bp.is_company_boss AND bp.is_active AND a.id<>NEW.id;
   IF boss IS NULL AND NEW.is_active AND NEW.deleted_at IS NULL THEN RAISE EXCEPTION 'organization_boss_required'; END IF;
   NEW.boss_id=boss;
  ELSE
   SELECT array_agg(a.id ORDER BY a.id) INTO candidates FROM agents a JOIN positions mp ON mp.id=a.position_id
   WHERE a.company_id=NEW.company_id AND a.position_id=p.manager_position_id AND mp.is_active AND a.is_active AND a.deleted_at IS NULL AND a.id<>NEW.id;
   position_changed=TG_OP='INSERT' OR NEW.position_id IS DISTINCT FROM OLD.position_id;
   IF NEW.boss_id IS NOT NULL AND NOT (NEW.boss_id=ANY(coalesce(candidates,'{}'::uuid[]))) THEN
    IF TG_OP='UPDATE' AND position_changed AND NEW.boss_id IS NOT DISTINCT FROM OLD.boss_id THEN NEW.boss_id=NULL;
    ELSE RAISE EXCEPTION 'organization_supervisor_ineligible'; END IF;
   END IF;
   IF NEW.boss_id IS NULL AND position_changed AND NEW.is_active AND NEW.deleted_at IS NULL THEN
    IF coalesce(cardinality(candidates),0)>1 THEN RAISE EXCEPTION 'organization_supervisor_choice_required'; END IF;
    NEW.boss_id=candidates[1];
   END IF;
  END IF;
 END IF;
 IF NEW.department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM departments WHERE id=NEW.department_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'organization_department_company_mismatch'; END IF;
 IF NEW.boss_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.boss_id AND company_id=NEW.company_id AND id<>NEW.id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'organization_boss_company_mismatch'; END IF;
 IF NEW.boss_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.boss_id IS DISTINCT FROM OLD.boss_id) AND EXISTS(WITH RECURSIVE chain(id,boss_id) AS (SELECT id,boss_id FROM agents WHERE id=NEW.boss_id UNION SELECT a.id,a.boss_id FROM agents a JOIN chain c ON a.id=c.boss_id) SELECT 1 FROM chain WHERE id=NEW.id) THEN RAISE EXCEPTION 'organization_agent_reporting_cycle'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION organization_sync_company(company uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE boss uuid; BEGIN
 UPDATE positions h SET manager_position_id=(SELECT b.id FROM positions b WHERE b.company_id=company AND b.is_company_boss AND b.is_active)
 WHERE h.company_id=company AND h.is_department_head AND h.manager_position_id IS DISTINCT FROM (SELECT b.id FROM positions b WHERE b.company_id=company AND b.is_company_boss AND b.is_active);
 SELECT id INTO boss FROM agents WHERE company_id=company AND organization_role='boss' AND is_active AND deleted_at IS NULL;
 IF boss IS NULL AND EXISTS(SELECT 1 FROM agents WHERE company_id=company AND organization_role='head' AND is_active AND deleted_at IS NULL) THEN RAISE EXCEPTION 'organization_boss_required'; END IF;
 UPDATE agents SET boss_id=boss WHERE company_id=company AND organization_role='head' AND boss_id IS DISTINCT FROM boss;
 UPDATE departments d SET head_agent_id=(SELECT a.id FROM agents a WHERE a.company_id=company AND a.department_id=d.id AND a.organization_role='head' AND a.is_active AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM positions p WHERE p.id=a.position_id AND p.is_active))
 WHERE d.company_id=company AND d.head_agent_id IS DISTINCT FROM (SELECT a.id FROM agents a WHERE a.company_id=company AND a.department_id=d.id AND a.organization_role='head' AND a.is_active AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM positions p WHERE p.id=a.position_id AND p.is_active));
 IF EXISTS(SELECT 1 FROM agents a JOIN positions p ON p.id=a.position_id LEFT JOIN agents b ON b.id=a.boss_id LEFT JOIN positions mp ON mp.id=p.manager_position_id
 WHERE a.company_id=company AND a.deleted_at IS NULL AND NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND a.boss_id IS NOT NULL
 AND (b.id IS NULL OR b.id=a.id OR b.company_id<>company OR b.position_id IS DISTINCT FROM p.manager_position_id OR b.deleted_at IS NOT NULL OR NOT coalesce(b.is_active,false) OR NOT coalesce(mp.is_active,false))) THEN RAISE EXCEPTION 'organization_supervisor_ineligible'; END IF;
END $$;
CREATE OR REPLACE FUNCTION organization_after_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- A changed supervisor definition is a single organization transaction: keep
 -- eligible selections, choose only a sole candidate, otherwise leave vacancy.
 UPDATE agents a SET position_id=a.position_id, boss_id=CASE
  WHEN p.is_company_boss OR p.is_department_head THEN a.boss_id
  WHEN NEW.manager_position_id IS NOT DISTINCT FROM OLD.manager_position_id AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN a.boss_id
  WHEN EXISTS(SELECT 1 FROM agents b JOIN positions mp ON mp.id=b.position_id WHERE b.id=a.boss_id AND b.id<>a.id AND b.company_id=a.company_id AND b.position_id=p.manager_position_id AND b.is_active AND b.deleted_at IS NULL AND mp.is_active) THEN a.boss_id
  WHEN a.is_active AND a.deleted_at IS NULL THEN (SELECT CASE WHEN count(*)=1 THEN (array_agg(b.id))[1] ELSE NULL END FROM agents b JOIN positions mp ON mp.id=b.position_id WHERE b.id<>a.id AND b.company_id=a.company_id AND b.position_id=p.manager_position_id AND b.is_active AND b.deleted_at IS NULL AND mp.is_active)
  ELSE NULL END
 FROM positions p WHERE a.position_id=p.id AND (p.id=NEW.id OR (p.manager_position_id=NEW.id AND NEW.is_active IS DISTINCT FROM OLD.is_active));
 PERFORM organization_sync_company(NEW.company_id); RETURN NULL;
END $$;
DROP TRIGGER organization_validate_position ON positions;
CREATE TRIGGER organization_validate_position BEFORE INSERT OR UPDATE OF company_id, rank, is_company_boss, is_department_head, is_company_leadership, default_department_id, manager_position_id, is_active ON positions FOR EACH ROW EXECUTE FUNCTION organization_validate_position();
DROP TRIGGER organization_after_position ON positions;
CREATE TRIGGER organization_after_position AFTER UPDATE OF rank, is_company_boss, is_department_head, is_company_leadership, default_department_id, manager_position_id, is_active ON positions FOR EACH ROW EXECUTE FUNCTION organization_after_position();
-- Validate every migrated Position and occupied relationship without choosing a
-- supervisor for existing null/inactive drafts.
UPDATE positions SET rank=rank;
DO $$ DECLARE c record; BEGIN FOR c IN SELECT id FROM companies LOOP PERFORM organization_sync_company(c.id); END LOOP; END $$;
`;
