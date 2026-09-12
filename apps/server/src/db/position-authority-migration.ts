/** One transactional migration: ambiguity aborts with position/department IDs.
 * The evidence table records every changed rank for deployment verification. */
export const positionAuthorityMigrationSql = `
ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_department_head boolean NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization_role text;
CREATE TABLE IF NOT EXISTS organization_rank_migration(position_id uuid PRIMARY KEY, company_id uuid NOT NULL, old_rank integer, new_rank integer NOT NULL);
DO $$ DECLARE problem text; rec record; candidate integer; BEGIN
 SELECT string_agg(d.id::text, ',') INTO problem FROM departments d LEFT JOIN agents a ON a.id=d.head_agent_id LEFT JOIN positions p ON p.id=a.position_id
 WHERE d.head_agent_id IS NOT NULL AND (a.id IS NULL OR a.position_id IS NULL OR a.company_id<>d.company_id OR p.company_id<>d.company_id OR p.is_company_boss OR a.deleted_at IS NOT NULL);
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_invalid_recorded_heads: %',problem; END IF;
 SELECT string_agg(id::text, ',') INTO problem FROM positions p WHERE (SELECT count(*) FROM departments d JOIN agents a ON a.id=d.head_agent_id WHERE a.position_id=p.id)>1;
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_shared_head_positions: %',problem; END IF;
 SELECT string_agg(p.id::text, ',') INTO problem FROM positions p JOIN agents a ON a.position_id=p.id JOIN departments d ON d.head_agent_id=a.id WHERE p.default_department_id IS NOT NULL AND p.default_department_id<>d.id;
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_recorded_head_department_conflict: %',problem; END IF;
 UPDATE positions p SET is_department_head=true,default_department_id=d.id FROM departments d JOIN agents a ON a.id=d.head_agent_id WHERE a.position_id=p.id;
 SELECT string_agg(id::text, ',') INTO problem FROM positions p WHERE NOT coalesce(is_company_boss,false) AND
 (SELECT count(DISTINCT coalesce(a.department_id::text,'NULL')) FROM agents a WHERE a.position_id=p.id AND a.deleted_at IS NULL)>1;
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_ambiguous_position_departments: %',problem; END IF;
 UPDATE positions p SET default_department_id=(SELECT a.department_id FROM agents a WHERE a.position_id=p.id AND a.deleted_at IS NULL LIMIT 1)
 WHERE NOT coalesce(p.is_company_boss,false) AND p.default_department_id IS NULL;
 SELECT string_agg(p.id::text, ',') INTO problem FROM positions p WHERE NOT coalesce(p.is_company_boss,false) AND
 (p.default_department_id IS NULL OR EXISTS(SELECT 1 FROM agents a WHERE a.position_id=p.id AND a.deleted_at IS NULL AND a.department_id IS NOT NULL AND a.department_id<>p.default_department_id));
 IF problem IS NOT NULL THEN RAISE EXCEPTION 'organization_migration_position_department_unresolved: %',problem; END IF;
 INSERT INTO organization_rank_migration SELECT id,company_id,rank,CASE WHEN is_company_boss THEN 0 ELSE 1 END FROM positions WHERE is_company_boss OR is_department_head ON CONFLICT DO NOTHING;
 UPDATE positions SET rank=CASE WHEN is_company_boss THEN 0 ELSE 1 END WHERE is_company_boss OR is_department_head;
 UPDATE positions SET default_department_id=NULL,manager_position_id=NULL WHERE is_company_boss;
 FOR rec IN SELECT DISTINCT company_id,rank FROM positions WHERE NOT coalesce(is_company_boss,false) AND NOT is_department_head AND (rank IS NULL OR rank NOT BETWEEN 2 AND 9) ORDER BY company_id,rank NULLS LAST LOOP
  SELECT n INTO candidate FROM generate_series(2,9) n WHERE NOT EXISTS(SELECT 1 FROM positions p WHERE p.company_id=rec.company_id AND NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND p.rank=n)
    AND NOT EXISTS(SELECT 1 FROM organization_rank_migration m WHERE m.company_id=rec.company_id AND m.old_rank<rec.rank AND m.new_rank>=n)
    AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.company_id=rec.company_id AND NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND p.rank BETWEEN 2 AND 9 AND p.rank<rec.rank AND p.rank>=n AND NOT EXISTS(SELECT 1 FROM organization_rank_migration m WHERE m.position_id=p.id))
    AND NOT EXISTS(SELECT 1 FROM positions p WHERE p.company_id=rec.company_id AND NOT coalesce(p.is_company_boss,false) AND NOT p.is_department_head AND p.rank BETWEEN 2 AND 9 AND p.rank>rec.rank AND p.rank<=n AND NOT EXISTS(SELECT 1 FROM organization_rank_migration m WHERE m.position_id=p.id))
    ORDER BY n LIMIT 1;
  IF candidate IS NULL THEN RAISE EXCEPTION 'organization_migration_rank_mapping_exhausted: company %, rank %',rec.company_id,rec.rank; END IF;
  INSERT INTO organization_rank_migration SELECT id,company_id,rank,candidate FROM positions WHERE company_id=rec.company_id AND rank IS NOT DISTINCT FROM rec.rank AND NOT coalesce(is_company_boss,false) AND NOT is_department_head ON CONFLICT DO NOTHING;
  UPDATE positions SET rank=candidate WHERE company_id=rec.company_id AND rank IS NOT DISTINCT FROM rec.rank AND NOT coalesce(is_company_boss,false) AND NOT is_department_head;
 END LOOP;
END $$;
ALTER TABLE positions ALTER COLUMN rank SET DEFAULT 2;
ALTER TABLE positions ALTER COLUMN rank SET NOT NULL;
ALTER TABLE positions ADD CONSTRAINT organization_position_role CHECK (
 (coalesce(is_company_boss,false) AND NOT is_department_head AND rank=0 AND default_department_id IS NULL AND manager_position_id IS NULL) OR
 (NOT coalesce(is_company_boss,false) AND default_department_id IS NOT NULL AND ((is_department_head AND rank=1) OR (NOT is_department_head AND rank BETWEEN 2 AND 9)))
);
CREATE UNIQUE INDEX organization_one_head_position ON positions(default_department_id) WHERE is_department_head;
CREATE UNIQUE INDEX organization_one_boss_position ON positions(company_id) WHERE is_company_boss AND is_active;
CREATE OR REPLACE FUNCTION organization_validate_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='55P03'; END;
 IF NEW.is_company_boss THEN NEW.rank=0; ELSIF NEW.is_department_head THEN NEW.rank=1; END IF;
 IF TG_OP='UPDATE' AND NEW.company_id<>OLD.company_id THEN RAISE EXCEPTION 'organization_position_company_immutable'; END IF;
 IF NEW.default_department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM departments WHERE id=NEW.default_department_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'organization_department_company_mismatch'; END IF;
 IF NEW.manager_position_id IS NOT NULL AND (NEW.manager_position_id=NEW.id OR NOT EXISTS(SELECT 1 FROM positions WHERE id=NEW.manager_position_id AND company_id=NEW.company_id)) THEN RAISE EXCEPTION 'organization_manager_position_company_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_validate_position BEFORE INSERT OR UPDATE OF company_id, rank, is_company_boss, is_department_head, default_department_id, manager_position_id, is_active ON positions FOR EACH ROW EXECUTE FUNCTION organization_validate_position();
UPDATE positions SET rank=rank;
ALTER TABLE positions ADD CONSTRAINT organization_manager_position_reference FOREIGN KEY(manager_position_id) REFERENCES positions(id) ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION organization_normalize_agent() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p positions%ROWTYPE; boss uuid; BEGIN
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
  END IF;
 END IF;
 IF NEW.department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM departments WHERE id=NEW.department_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'organization_department_company_mismatch'; END IF;
 IF NEW.boss_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.boss_id AND company_id=NEW.company_id AND id<>NEW.id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'organization_boss_company_mismatch'; END IF;
 IF NEW.boss_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.boss_id IS DISTINCT FROM OLD.boss_id) AND EXISTS(WITH RECURSIVE chain(id,boss_id) AS (SELECT id,boss_id FROM agents WHERE id=NEW.boss_id UNION SELECT a.id,a.boss_id FROM agents a JOIN chain c ON a.id=c.boss_id) SELECT 1 FROM chain WHERE id=NEW.id) THEN RAISE EXCEPTION 'organization_agent_reporting_cycle'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_normalize_agent BEFORE INSERT OR UPDATE OF company_id, position_id, department_id, boss_id, is_active, deleted_at, organization_role ON agents FOR EACH ROW EXECUTE FUNCTION organization_normalize_agent();
-- Normalize leaders first so existing staff reporting remains untouched.
UPDATE agents SET position_id=position_id;
CREATE UNIQUE INDEX organization_one_boss_agent ON agents(company_id) WHERE organization_role='boss' AND is_active AND deleted_at IS NULL;
CREATE UNIQUE INDEX organization_one_head_agent ON agents(position_id) WHERE organization_role='head' AND is_active AND deleted_at IS NULL;
CREATE OR REPLACE FUNCTION organization_sync_company(company uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE boss uuid; BEGIN
 SELECT id INTO boss FROM agents WHERE company_id=company AND organization_role='boss' AND is_active AND deleted_at IS NULL;
 IF boss IS NULL AND EXISTS(SELECT 1 FROM agents WHERE company_id=company AND organization_role='head' AND is_active AND deleted_at IS NULL) THEN RAISE EXCEPTION 'organization_boss_required'; END IF;
 UPDATE agents SET boss_id=boss WHERE company_id=company AND organization_role='head' AND boss_id IS DISTINCT FROM boss;
 UPDATE departments d SET head_agent_id=(SELECT a.id FROM agents a WHERE a.company_id=company AND a.department_id=d.id AND a.organization_role='head' AND a.is_active AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM positions p WHERE p.id=a.position_id AND p.is_active))
 WHERE d.company_id=company AND d.head_agent_id IS DISTINCT FROM (SELECT a.id FROM agents a WHERE a.company_id=company AND a.department_id=d.id AND a.organization_role='head' AND a.is_active AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM positions p WHERE p.id=a.position_id AND p.is_active));
END $$;
CREATE OR REPLACE FUNCTION organization_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 BEGIN
  PERFORM id FROM companies WHERE id=OLD.company_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='55P03'; END;
 RETURN OLD;
END $$;
CREATE TRIGGER organization_before_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION organization_before_delete();
CREATE TRIGGER organization_before_delete BEFORE DELETE ON positions FOR EACH ROW EXECUTE FUNCTION organization_before_delete();
CREATE OR REPLACE FUNCTION organization_after_agent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF pg_trigger_depth()>1 THEN RETURN NULL; END IF;
 PERFORM organization_sync_company(CASE WHEN TG_OP='DELETE' THEN OLD.company_id ELSE NEW.company_id END); RETURN NULL;
END $$;
CREATE TRIGGER organization_after_agent AFTER INSERT OR UPDATE OF company_id, position_id, department_id, boss_id, is_active, deleted_at OR DELETE ON agents FOR EACH ROW EXECUTE FUNCTION organization_after_agent();
CREATE OR REPLACE FUNCTION organization_after_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE agents SET position_id=position_id WHERE position_id=NEW.id;
 PERFORM organization_sync_company(NEW.company_id); RETURN NULL;
END $$;
CREATE TRIGGER organization_after_position AFTER UPDATE OF rank, is_company_boss, is_department_head, default_department_id, is_active ON positions FOR EACH ROW EXECUTE FUNCTION organization_after_position();
CREATE OR REPLACE FUNCTION organization_validate_department() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expected uuid; BEGIN
 BEGIN
  PERFORM id FROM companies WHERE id=NEW.company_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'organization_busy' USING ERRCODE='55P03'; END;
 IF TG_OP='UPDATE' AND NEW.company_id<>OLD.company_id THEN RAISE EXCEPTION 'organization_department_company_immutable'; END IF;
 SELECT id INTO expected FROM agents WHERE company_id=NEW.company_id AND department_id=NEW.id AND organization_role='head' AND is_active AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM positions p WHERE p.id=agents.position_id AND p.is_active);
 IF NEW.head_agent_id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'organization_department_head_derived'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE c record; BEGIN FOR c IN SELECT id FROM companies LOOP PERFORM organization_sync_company(c.id); END LOOP; END $$;
CREATE TRIGGER organization_validate_department BEFORE INSERT OR UPDATE OF company_id, head_agent_id ON departments FOR EACH ROW EXECUTE FUNCTION organization_validate_department();
`;
