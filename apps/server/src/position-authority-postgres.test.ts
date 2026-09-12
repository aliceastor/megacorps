import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';
const skip=!process.env.TEST_DATABASE_URL&&!process.env.CI?'Dedicated PostgreSQL test URL absent':false;
test('PostgreSQL Position authority covers raw writes, leadership uniqueness and derived membership', {skip,timeout:60000},async t=>{
 const {sql}=await isolatedPostgres(t);
 const [c]=await sql`INSERT INTO companies(name,slug) VALUES('Authority','authority') RETURNING id`;
 const [d]=await sql`INSERT INTO departments(company_id,name,slug) VALUES(${c!.id},'Engineering','eng') RETURNING id`;
 const [boss]=await sql`INSERT INTO positions(company_id,name,slug,rank,is_company_boss) VALUES(${c!.id},'Boss','boss',0,true) RETURNING id`;
 const [head]=await sql`INSERT INTO positions(company_id,name,slug,rank,is_department_head,default_department_id) VALUES(${c!.id},'Head','head',1,true,${d!.id}) RETURNING id`;
 await assert.rejects(sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Premature','early','Head',${head!.id})`,/organization_boss_required/);
 const [a]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,department_id) VALUES(${c!.id},'Alice','alice','Boss',${boss!.id},${d!.id}) RETURNING *`;
 assert.equal(a!.department_id,null);assert.equal(a!.boss_id,null);
 const [h]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Head','head','Head',${head!.id}) RETURNING *`;
 assert.equal(h!.department_id,d!.id);assert.equal(h!.boss_id,a!.id);
 const [raceDepartment]=await sql`INSERT INTO departments(company_id,name,slug) VALUES(${c!.id},'Race','race') RETURNING id`;
 const headRaces=await Promise.allSettled(['race-a','race-b'].map(slug=>sql`INSERT INTO positions(company_id,name,slug,rank,is_department_head,default_department_id) VALUES(${c!.id},'Race head',${slug},1,true,${raceDepartment!.id}) RETURNING id`));
 const winningHead=headRaces.filter(r=>r.status==='fulfilled');assert.equal(winningHead.length,1);
 const racePosition=winningHead[0]!.value[0]!.id;
 const occupantRaces=await Promise.allSettled(['occupant-a','occupant-b'].map(slug=>sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Race occupant',${slug},'Head',${racePosition}) RETURNING id`));
 const winningOccupant=occupantRaces.filter(r=>r.status==='fulfilled');assert.equal(winningOccupant.length,1);
 assert.equal((await sql`SELECT head_agent_id FROM departments WHERE id=${raceDepartment!.id}`)[0]!.head_agent_id,winningOccupant[0]!.value[0]!.id);
 await sql`UPDATE agents SET is_active=false WHERE position_id=${racePosition}`;
 await sql`DELETE FROM agents WHERE position_id=${racePosition}`;
 await sql`DELETE FROM positions WHERE id=${racePosition}`;
 await sql`DELETE FROM departments WHERE id=${raceDepartment!.id}`;
 assert.equal((await sql`SELECT head_agent_id FROM departments WHERE id=${d!.id}`)[0]!.head_agent_id,h!.id);
 const results=await Promise.allSettled(['duplicate-a','duplicate-b'].map(slug=>sql`INSERT INTO positions(company_id,name,slug,rank,is_department_head,default_department_id,is_active) VALUES(${c!.id},'Duplicate',${slug},1,true,${d!.id},false)`));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
 await assert.rejects(sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Duplicate','duplicate','Head',${head!.id})`,/organization_|unique/);
 await assert.rejects(sql`UPDATE agents SET is_active=false WHERE id=${a!.id}`,/organization_boss_required/);
 const [staff]=await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id) VALUES(${c!.id},'Staff','staff',3,${d!.id}) RETURNING id`;
 const [r]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,boss_id) VALUES(${c!.id},'Ribel','ribel','Staff',${staff!.id},${h!.id}) RETURNING id`;
 const [digby]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id,boss_id,department_id) VALUES(${c!.id},'Digby','digby','Staff',${staff!.id},${r!.id},null) RETURNING *`;
 assert.equal(digby!.boss_id,r!.id);assert.equal(digby!.department_id,d!.id);
 await sql`UPDATE agents SET organization_role='boss' WHERE id=${digby!.id}`;
 assert.equal((await sql`SELECT organization_role FROM agents WHERE id=${digby!.id}`)[0]!.organization_role,null);
 const [managerPosition]=await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id) VALUES(${c!.id},'Vacant manager','vacant-manager',2,${d!.id}) RETURNING id`;
 const [childPosition]=await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id,manager_position_id) VALUES(${c!.id},'Child','child',3,${d!.id},${managerPosition!.id}) RETURNING id`;
 await sql`DELETE FROM positions WHERE id=${managerPosition!.id}`;
 assert.equal((await sql`SELECT manager_position_id FROM positions WHERE id=${childPosition!.id}`)[0]!.manager_position_id,null);
 // Operational Agent writes must not acquire the organization lock.
 await sql.begin(async tx=>{
  await tx`UPDATE agents SET is_busy=true WHERE id=${h!.id}`;
  await sql.begin(async other=>{await other`SELECT id FROM companies WHERE id=${c!.id} FOR UPDATE NOWAIT`;});
 });
 // An arbitrary raw org write already owns its Agent row when its trigger runs.
 // Fail promptly for a company-first writer, so neither transaction waits in a cycle.
 await sql.begin(async tx=>{
  await tx`SELECT id FROM companies WHERE id=${c!.id} FOR UPDATE`;
  await assert.rejects(sql`UPDATE agents SET boss_id=${h!.id} WHERE id=${digby!.id}`,/organization_busy/);
  await assert.rejects(sql`DELETE FROM agents WHERE id=${digby!.id}`,/organization_busy/);
  await tx`UPDATE positions SET rank=4 WHERE id=${staff!.id}`;
 });
 await sql`UPDATE agents SET is_active=false WHERE id=${h!.id}`;
 assert.equal((await sql`SELECT head_agent_id FROM departments WHERE id=${d!.id}`)[0]!.head_agent_id,null);
 await sql`UPDATE agents SET is_active=false WHERE id=${a!.id}`;
 await assert.rejects(sql`UPDATE agents SET is_active=true WHERE id=${h!.id}`,/organization_boss_required/);
 await assert.rejects(sql`UPDATE positions SET rank=10 WHERE id=${staff!.id}`,/organization_|check/);
 await sql`UPDATE positions SET is_active=false WHERE id=${head!.id}`;
 await assert.rejects(sql`UPDATE agents SET is_active=true WHERE id=${h!.id}`,/organization_boss_required/);
 await sql`UPDATE agents SET is_active=true WHERE id=${a!.id}`;
 await sql`UPDATE agents SET is_active=true WHERE id=${h!.id}`;
 await assert.rejects(sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Duplicate inactive position','dup-inactive','Head',${head!.id})`,/organization_|unique/);
});
