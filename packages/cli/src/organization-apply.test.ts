import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('apply resolves position department and creates Boss before Head regardless of manifest order', {timeout:15000}, async t => {
  const writes: Array<{path:string; body:any}> = [];
  const rows: Record<string, any[]> = {companies:[{id:'company',name:'Example',slug:'example'}],departments:[],positions:[],agents:[],projects:[],goals:[],cards:[]};
  const server=createServer(async (req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname;
    const collection=path.split('/')[2]!;
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify(rows[collection]??[]));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw); writes.push({path,body});
    if(collection==='positions' && body.isDepartmentHead && !rows.positions!.some(p=>p.isCompanyBoss)) {res.statusCode=400;res.end(JSON.stringify({error:'boss_position_required'}));return;}
    if(collection==='positions' && !body.isCompanyBoss && body.defaultDepartmentId!=='engineering') {res.statusCode=400;res.end(JSON.stringify({error:'position_department_required'}));return;}
    if(collection==='agents' && body.positionId==='head' && !rows.agents!.some(a=>a.positionId==='boss')) {res.statusCode=400;res.end(JSON.stringify({error:'company_boss_required'}));return;}
    const row={...body,id:body.slug};rows[collection]!.push(row);res.end(JSON.stringify(row));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const dir=await mkdtemp(join(tmpdir(),'megacorps-cli-org-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const manifest=join(dir,'manifest.json');
  await writeFile(manifest,JSON.stringify({defaultCompany:'example',departments:[{name:'Engineering',slug:'engineering'}],positions:[{name:'Head',slug:'head',isDepartmentHead:true,rank:1,department:'engineering'},{name:'Boss',slug:'boss',isCompanyBoss:true,rank:0}],agents:[{name:'Head',slug:'head-agent',position:'head',role:'worker'},{name:'Boss',slug:'boss-agent',position:'boss',role:'manager'}]}));
  const address=server.address() as {port:number};
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./index.ts',import.meta.url)),'apply','--file',manifest,'--api-url',`http://127.0.0.1:${address.port}`,'--session','synthetic-test-session'],{windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,output);
  assert.equal(writes.find(w=>w.path==='/api/positions'&&w.body.slug==='head')!.body.defaultDepartmentId,'engineering');
  assert.deepEqual(writes.filter(w=>w.path==='/api/positions').map(w=>w.body.slug),['boss','head']);
  assert.deepEqual(writes.filter(w=>w.path==='/api/agents').map(w=>w.body.positionId),['boss','head']);
});

test('manual department head assignment is rejected before contacting the API', {timeout:10000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'megacorps-cli-head-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const manifest=join(dir,'manifest.json');
  await writeFile(manifest,JSON.stringify({departments:[{name:'Engineering',slug:'engineering',headAgentId:'legacy-head'}]}));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./index.ts',import.meta.url)),'apply','--file',manifest,'--api-url','http://127.0.0.1:9','--session','synthetic-test-session'],{windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,1);
  assert.match(output,/headAgentId is derived/);
  assert.doesNotMatch(output,/fetch failed/);
});
