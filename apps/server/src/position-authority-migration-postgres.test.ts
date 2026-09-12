import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';
import { positionAuthorityMigrationSql } from './db/position-authority-migration.ts';
test('v34 legacy migration preserves Staff reporting and records rank mapping; ambiguity rolls back', {skip:!process.env.TEST_DATABASE_URL&&!process.env.CI?'Dedicated PostgreSQL test URL absent':false,timeout:60000},async t=>{
 const {sql}=await isolatedPostgres(t);
 // Reconstruct v33 inside this disposable schema; no production connection exists.
 await sql.unsafe(`DROP TRIGGER organization_before_delete ON agents; DROP TRIGGER organization_before_delete ON positions; DROP TRIGGER organization_validate_position ON positions; DROP TRIGGER organization_after_position ON positions; DROP TRIGGER organization_normalize_agent ON agents; DROP TRIGGER organization_after_agent ON agents; DROP TRIGGER organization_validate_department ON departments;
 DROP INDEX organization_one_head_position; DROP INDEX organization_one_boss_position; DROP INDEX organization_one_head_agent; DROP INDEX organization_one_boss_agent; ALTER TABLE positions DROP CONSTRAINT organization_position_role; ALTER TABLE positions DROP CONSTRAINT organization_manager_position_reference; ALTER TABLE positions DROP COLUMN is_department_head; ALTER TABLE agents DROP COLUMN organization_role; TRUNCATE organization_rank_migration;`);
 const [c]=await sql`INSERT INTO companies(name,slug) VALUES('Legacy','legacy') RETURNING id`;
 const [eng,product]=await sql`INSERT INTO departments(company_id,name,slug) VALUES(${c!.id},'Engineering','eng'),(${c!.id},'Product','product') RETURNING id`;
 const [boss,head,senior,intern,cmo]=await sql`INSERT INTO positions(company_id,name,slug,rank,is_company_boss,default_department_id) VALUES(${c!.id},'CEO','ceo',0,true,null),(${c!.id},'CTO','cto',10,false,${eng!.id}),(${c!.id},'Senior','senior',100,false,null),(${c!.id},'Intern','intern',500,false,null),(${c!.id},'CMO','cmo',10,false,${product!.id}) RETURNING id`;
 const [alice]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Alice','alice','CEO',${boss!.id}) RETURNING id`;
 const [h]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,department_id,boss_id) VALUES(${c!.id},'CTO','cto','CTO',${head!.id},${eng!.id},${alice!.id}) RETURNING id`;
 const [r]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,department_id,boss_id) VALUES(${c!.id},'Ribel','ribel','Senior',${senior!.id},${eng!.id},${h!.id}) RETURNING id`;
 const [digby]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,department_id,boss_id) VALUES(${c!.id},'Digby','digby','Intern',${intern!.id},${eng!.id},${r!.id}) RETURNING id`;
 await sql`INSERT INTO agents(company_id,name,slug,role,position_id,department_id,is_active) VALUES(${c!.id},'David','david','CMO',${cmo!.id},${product!.id},false)`;
 await sql`UPDATE departments SET head_agent_id=${h!.id} WHERE id=${eng!.id}`;
 await assert.rejects(sql.begin(async tx=>{
  await tx`INSERT INTO agents(company_id,name,slug,role,position_id,department_id) VALUES(${c!.id},'Ambiguous','ambiguous','Staff',${senior!.id},${product!.id})`;
  await tx.unsafe(positionAuthorityMigrationSql);
 }),/organization_migration_ambiguous_position_departments/);
 assert.equal((await sql`SELECT rank FROM positions WHERE id=${senior!.id}`)[0]!.rank,100);
 await assert.rejects(sql.begin(async tx=>{
  await tx`UPDATE positions SET default_department_id=${product!.id} WHERE id=${head!.id}`;
  await tx.unsafe(positionAuthorityMigrationSql);
 }),/organization_migration_recorded_head_department_conflict/);
 await sql.begin(async tx=>{await tx.unsafe(positionAuthorityMigrationSql);});
 const rows=await sql`SELECT slug,rank,is_department_head,default_department_id FROM positions WHERE company_id=${c!.id} ORDER BY rank`;
 assert.deepEqual(rows.map(p=>[p.slug,p.rank,p.is_department_head]),[['ceo',0,false],['cto',1,true],['cmo',2,false],['senior',3,false],['intern',4,false]]);
 assert.equal(rows.find(p=>p.slug==='senior')!.default_department_id,eng!.id);
 assert.equal((await sql`SELECT boss_id FROM agents WHERE id=${digby!.id}`)[0]!.boss_id,r!.id);
 assert.equal((await sql`SELECT head_agent_id FROM departments WHERE id=${product!.id}`)[0]!.head_agent_id,null);
 const evidence=await sql`SELECT old_rank,new_rank FROM organization_rank_migration WHERE company_id=${c!.id} ORDER BY new_rank`;
 assert.deepEqual(evidence.map(p=>[p.old_rank,p.new_rank]),[[0,0],[10,1],[10,2],[100,3],[500,4]]);
});
