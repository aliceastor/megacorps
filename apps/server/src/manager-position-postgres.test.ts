import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedPostgres } from './test-support/postgres-db.ts';
test('PostgreSQL company leadership and manager-position supervisor authority', {skip:!process.env.TEST_DATABASE_URL&&!process.env.CI?'Dedicated PostgreSQL URL absent':false,timeout:60000},async t=>{
 const {sql}=await isolatedPostgres(t);
 const [c]=await sql`INSERT INTO companies(name,slug) VALUES('Managers','managers') RETURNING id`;
 const [d]=await sql`INSERT INTO departments(company_id,name,slug) VALUES(${c!.id},'Engineering','eng') RETURNING id`;
 const [bp]=await sql`INSERT INTO positions(company_id,name,slug,is_company_boss) VALUES(${c!.id},'Boss','boss',true) RETURNING *`;
 assert.equal(bp!.is_company_leadership,true);
 const [boss]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Boss','boss','Boss',${bp!.id}) RETURNING id`;
 const [hp]=await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id) VALUES(${c!.id},'Head','head',true,${d!.id}) RETURNING *`;
 assert.equal(hp!.manager_position_id,bp!.id);
 const [head]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Head','head','Head',${hp!.id}) RETURNING id`;
 const [senior]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id,manager_position_id) VALUES(${c!.id},'Senior','senior',${d!.id},${hp!.id}) RETURNING id`;
 const [ribel]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Ribel','ribel','Staff',${senior!.id}) RETURNING *`;
 assert.equal(ribel!.boss_id,head!.id);
 const [intern]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id,manager_position_id) VALUES(${c!.id},'Intern','intern',${d!.id},${senior!.id}) RETURNING id`;
 const [digby]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Digby','digby','Staff',${intern!.id}) RETURNING *`;
 assert.equal(digby!.boss_id,ribel!.id);
 await assert.rejects(sql`UPDATE agents SET boss_id=${head!.id} WHERE id=${digby!.id}`,/organization_supervisor_ineligible/);
 await assert.rejects(sql`UPDATE positions SET manager_position_id=${intern!.id} WHERE id=${senior!.id}`,/organization_position_cycle/);
 const [other]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Other senior','other','Staff',${senior!.id}) RETURNING id`;
 await assert.rejects(sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Unchosen','unchosen','Staff',${intern!.id})`,/organization_supervisor_choice_required/);
 await sql`UPDATE agents SET name='Digby preserved' WHERE id=${digby!.id}`;
 assert.equal((await sql`SELECT boss_id FROM agents WHERE id=${digby!.id}`)[0]!.boss_id,ribel!.id);
 await assert.rejects(sql`UPDATE agents SET is_active=false WHERE id=${ribel!.id}`,/organization_supervisor_ineligible/);
 await sql`UPDATE agents SET boss_id=${other!.id} WHERE id=${digby!.id}`;
 await sql`UPDATE agents SET is_active=false WHERE id=${ribel!.id}`;
 const [reconfigured]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id,manager_position_id) VALUES(${c!.id},'Reconfigured','reconfigured',${d!.id},${hp!.id}) RETURNING id`;
 const [assigned]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Retained Agent','retained', 'Staff',${reconfigured!.id}) RETURNING id`;
 await sql`UPDATE agents SET is_active=true WHERE id=${ribel!.id}`;
 await sql`UPDATE positions SET manager_position_id=${senior!.id} WHERE id=${reconfigured!.id}`;
 assert.equal((await sql`SELECT boss_id FROM agents WHERE id=${assigned!.id}`)[0]!.boss_id,null);
 await sql`UPDATE agents SET boss_id=${other!.id} WHERE id=${assigned!.id}`;
 const [advisor]=await sql`INSERT INTO positions(company_id,name,slug,is_company_leadership,manager_position_id) VALUES(${c!.id},'Advisor','advisor',true,${bp!.id}) RETURNING *`;
 assert.equal(advisor!.is_company_boss,false);assert.equal(advisor!.default_department_id,null);
 const [direct]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Advisor','advisor','Staff',${advisor!.id}) RETURNING *`;
 assert.equal(direct!.boss_id,boss!.id);assert.equal(direct!.organization_role,null);assert.equal(direct!.department_id,null);
 const [vacant]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id) VALUES(${c!.id},'Vacant','vacant',${d!.id}) RETURNING id`;
 const [draft]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Draft','draft','Staff',${vacant!.id}) RETURNING *`;
 assert.equal(draft!.boss_id,null);
 await assert.rejects(sql`UPDATE agents SET boss_id=${boss!.id} WHERE id=${draft!.id}`,/organization_supervisor_ineligible/);
 const cyclePositions=await sql`INSERT INTO positions(company_id,name,slug,default_department_id) VALUES(${c!.id},'Cycle A','cycle-a',${d!.id}),(${c!.id},'Cycle B','cycle-b',${d!.id}) RETURNING id`;
 const cycleRace=await Promise.allSettled([
  sql`UPDATE positions SET manager_position_id=${cyclePositions[1]!.id} WHERE id=${cyclePositions[0]!.id}`,
  sql`UPDATE positions SET manager_position_id=${cyclePositions[0]!.id} WHERE id=${cyclePositions[1]!.id}`,
 ]);
 assert.equal(cycleRace.filter(r=>r.status==='fulfilled').length,1);
 const [raceManager]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id) VALUES(${c!.id},'Race manager','race-manager',${d!.id}) RETURNING id`;
 const [raceBoss]=await sql`INSERT INTO agents(company_id,name,slug,role,position_id) VALUES(${c!.id},'Race manager','race-manager','Staff',${raceManager!.id}) RETURNING id`;
 const [raceStaff]=await sql`INSERT INTO positions(company_id,name,slug,default_department_id,manager_position_id) VALUES(${c!.id},'Race Staff','race-staff',${d!.id},${raceManager!.id}) RETURNING id`;
 const race=await Promise.allSettled([
  sql`UPDATE agents SET is_active=false WHERE id=${raceBoss!.id}`,
  sql`INSERT INTO agents(company_id,name,slug,role,position_id,boss_id) VALUES(${c!.id},'Race follower','race-follower','Staff',${raceStaff!.id},${raceBoss!.id})`,
 ]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 const invalid=await sql`SELECT a.id FROM agents a JOIN agents b ON b.id=a.boss_id WHERE a.position_id=${raceStaff!.id} AND NOT b.is_active`;
 assert.equal(invalid.length,0);
});
