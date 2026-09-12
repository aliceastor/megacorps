import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isolatedPostgres } from './test-support/postgres-db.ts';
test('prompt preview builds fresh real prompts with tenant isolation and no execution writes', {skip:!process.env.TEST_DATABASE_URL&&!process.env.CI?'Dedicated PostgreSQL test URL absent':false,timeout:60000},async t=>{
 const {sql}=await isolatedPostgres(t);
 const {registerPromptPreviewRoutes}=await import('./prompt-preview.ts');
 const {signSession}=await import('./auth.ts');
 const [c]=await sql`INSERT INTO companies(name,slug,mission) VALUES('Preview Corp','preview','Synthetic mission sentinel') RETURNING id`;
 const [other]=await sql`INSERT INTO companies(name,slug) VALUES('Other','other') RETURNING id`;
 const [u]=await sql`INSERT INTO users(name,email,role) VALUES('Operator','preview@example.test','admin') RETURNING *`;
 await sql`INSERT INTO company_memberships(company_id,user_id,role,status) VALUES(${c!.id},${u!.id},'admin','active')`;
 const [agent]=await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type,api_token,soul) VALUES(${c!.id},'Preview Agent','preview-agent','worker','webhook','synthetic-preview-secret','Synthetic soul sentinel') RETURNING id`;
 const [project]=await sql`INSERT INTO projects(company_id,name,description) VALUES(${c!.id},'Preview project','Synthetic project sentinel') RETURNING id`;
 const [foreign]=await sql`INSERT INTO projects(company_id,name) VALUES(${other!.id},'Foreign') RETURNING id`;
 const [foreignAgent]=await sql`INSERT INTO agents(company_id,name,slug,role) VALUES(${other!.id},'Foreign','foreign','worker') RETURNING id`;
 const [runtime]=await sql`INSERT INTO agent_runtimes(company_id,name,adapter_type,config) VALUES(${c!.id},'Preview runtime','a2a','{"baseUrl":"https://synthetic.invalid","bearerToken":"synthetic-runtime-secret"}') RETURNING id`;
 await sql`UPDATE agents SET adapter_type='a2a',runtime_id=${runtime!.id},current_session_id='historical-session-must-not-resume' WHERE id=${agent!.id}`;
 const [dept]=await sql`INSERT INTO departments(company_id,name,slug) VALUES(${c!.id},'Preview Department','preview-dept') RETURNING id`;
 const [bossPosition]=await sql`INSERT INTO positions(company_id,name,slug,is_company_boss,prompt) VALUES(${c!.id},'Preview Boss','preview-boss',true,'Synthetic Boss position sentinel') RETURNING id`;
 const [boss]=await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type,position_id) VALUES(${c!.id},'Preview Boss','preview-boss','Boss','webhook',${bossPosition!.id}) RETURNING id`;
 const [headPosition]=await sql`INSERT INTO positions(company_id,name,slug,is_department_head,default_department_id,prompt) VALUES(${c!.id},'Preview Head','preview-head',true,${dept!.id},'Synthetic Head position sentinel') RETURNING id`;
 const [head]=await sql`INSERT INTO agents(company_id,name,slug,role,adapter_type,position_id) VALUES(${c!.id},'Preview Head','preview-head','Head','webhook',${headPosition!.id}) RETURNING id`;
 const [staffPosition]=await sql`INSERT INTO positions(company_id,name,slug,rank,default_department_id,manager_position_id,prompt) VALUES(${c!.id},'Preview Staff','preview-staff',3,${dept!.id},${headPosition!.id},'Synthetic Staff position sentinel') RETURNING id`;
 await sql`UPDATE agents SET position_id=${staffPosition!.id},boss_id=${head!.id} WHERE id=${agent!.id}`;
 const app=Fastify();t.after(()=>app.close());await app.register(cookie);await registerPromptPreviewRoutes(app);
 const headers={cookie:'session='+await signSession(u as any)};
 const snapshot=async()=>Object.fromEntries(await Promise.all(['agents','kanban_cards','chat_sessions','chat_messages','task_runs','heartbeat_runs','prompt_logs','activity_log','app_settings'].map(async table=>[table,JSON.stringify(await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`))])));
 await sql`INSERT INTO knowledge_docs(company_id,title,tags,body) VALUES(${c!.id},'Preview handbook',ARRAY['handbook'],'Synthetic handbook sentinel synthetic-preview-secret synthetic-runtime-secret')`;
 const originalFetch=globalThis.fetch;let networkCalls=0;
 globalThis.fetch=async()=>{networkCalls++;throw new Error('Preview must not use network');};t.after(()=>{globalThis.fetch=originalFetch;});
 const before=await snapshot();
 for(const kind of ['task','chat']) {
  const response=await app.inject({method:'POST',url:'/api/agents/'+agent!.id+'/prompt-preview',headers,payload:{kind,projectId:project!.id,title:'Preview title',body:'Synthetic request sentinel'}});
  assert.equal(response.statusCode,200,response.body);
  const result=response.json();assert.equal(result.contextMode,'full_bootstrap');assert.equal(result.redacted,true);
  for(const marker of ['Synthetic mission sentinel','Synthetic request sentinel','Preview project','Synthetic handbook sentinel'])assert.ok(result.prompt.includes(marker),marker);
  assert.ok(!result.prompt.includes('synthetic-preview-secret'));assert.ok(!result.prompt.includes('synthetic-runtime-secret'));assert.ok(!result.prompt.includes('historical-session-must-not-resume'));if(kind==='chat')assert.match(result.prompt,/megacorps-chat-response/);assert.match(result.runtimeContextNotice,/Hermes/);
 }
 for(const [subject,marker] of [[boss,'Synthetic Boss position sentinel'],[head,'Synthetic Head position sentinel'],[agent,'Synthetic Staff position sentinel']] as const) {
  for(const kind of ['task','chat']) {
   const response=await app.inject({method:'POST',url:'/api/agents/'+subject!.id+'/prompt-preview',headers,payload:{kind,body:'Role preview',projectId:project!.id}});
   assert.equal(response.statusCode,200,response.body);assert.ok(response.json().prompt.includes(marker),marker);
   if(subject===boss)assert.match(response.json().prompt,/company leadership/);
  }
 }
 assert.deepEqual(await snapshot(),before);assert.equal(networkCalls,0);
 assert.equal((await app.inject({method:'POST',url:'/api/agents/'+agent!.id+'/prompt-preview',headers,payload:{kind:'chat',body:'test',projectId:foreign!.id}})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url:'/api/agents/'+foreignAgent!.id+'/prompt-preview',headers,payload:{kind:'chat',body:'test'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/agents/'+agent!.id+'/prompt-preview',payload:{kind:'chat',body:'test'}})).statusCode,401);
});
