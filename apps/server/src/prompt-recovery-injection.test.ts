import assert from 'node:assert/strict';
import test from 'node:test';
import { agents, kanbanCards } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { buildTaskPrompt, buildReviewPrompt } from './dispatch.ts';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { agentReportGuidance } from './agent-report-guidance.ts';

for (const role of ['boss', 'head', 'staff'] as const) for (const kind of ['dispatch', 'review'] as const) for (const continuation of [false, true]) {
 test(`${role} ${kind} ${continuation ? 'continued' : 'fresh'} prompt carries precise format-only correction`, async t => {
  const state=memoryDb(t,[]), {bossId,headId,departmentId}=readyCompany(state,'company');
  state.rows(agents).push({id:'staff',companyId:'company',name:'Staff',slug:'staff',bossId:headId,departmentId,adapterType:'webhook',isActive:true});
  const actorId=role==='boss'?bossId:role==='head'?headId:'staff';
  const card:any={id:'card',companyId:'company',projectId:null,title:'Current scope',body:'## Acceptance\nVerify the submitted report.',assigneeId:kind==='dispatch'?actorId:'staff',reviewerId:kind==='review'?actorId:null,columnStatus:kind==='review'?'in_review':'todo',tags:[],dependencyCardIds:[],protocolRepairState:{[kind]:{mode:'same_session',actorId,reason:'workProducts[0].url: expected URL',rejectedReport:'{"kind":"megacorps-report","status":"completed","summary":"Existing work completed"}',failures:1,runKeys:['run'],visitedActorIds:[],fallbackId:null}},lastError:'Precise repair state exists'};
  state.rows(kanbanCards).push(card);
  const prompt=await (kind==='dispatch'?buildTaskPrompt:buildReviewPrompt)(card,{continuation});
  assert.match(prompt,/workProducts\[0\]\.url: expected URL/);
  assert.match(prompt,/Existing work completed/);
  assert.match(prompt,/do not.*(?:repeat|redo|re-run)/i);
 });
}

test('Boss assessment report guidance never asks for another professional artifact review', () => {
 const guide=agentReportGuidance('assessment' as any);
 const prompt=buildAgentPrompt({hermesProfile:'boss',currentSessionId:null},{id:'card',title:'Assess goal',body:'Accepted child evidence',reportingMode:'assessment' as any});
 assert.match(guide,/goal assessment/i);
 assert.match(prompt,/never.*(?:clone|test|implement)/i);
 assert.doesNotMatch(prompt,/Inspect the actual artifact against acceptance criteria|Score is an integer/);
 assert.match(prompt,/verdict/);
});
test('format repair prompt carries authority and acceptance without re-injecting the execution history', async t => {
 const state=memoryDb(t,[]), {headId,departmentId}=readyCompany(state,'company');
 state.rows(agents).push({id:'staff',companyId:'company',name:'Staff',slug:'staff',bossId:headId,departmentId,adapterType:'webhook',isActive:true});
 const card:any={id:'card',companyId:'company',projectId:null,title:'Correct the report',body:'## Acceptance\nPRESERVE_CURRENT_ACCEPTANCE',assigneeId:'staff',reviewerId:headId,columnStatus:'todo',tags:[],dependencyCardIds:[],executionLog:'UNNEEDED_TOOL_HISTORY '.repeat(2000),protocolRepairState:{dispatch:{mode:'fresh_context',actorId:'staff',reason:'workProducts[0].url: expected URL',rejectedReport:'{"kind":"megacorps-report","status":"completed","summary":"Keep the actual completed result"}',failures:2,runKeys:['run'],visitedActorIds:[],fallbackId:null}}};
 state.rows(kanbanCards).push(card);
 const prompt=await buildTaskPrompt(card);
 assert.match(prompt,/PRESERVE_CURRENT_ACCEPTANCE/);
 assert.match(prompt,/workProducts\[0\]\.url: expected URL/);
 assert.match(prompt,/structural role|Authority/);
 assert.doesNotMatch(prompt,/UNNEEDED_TOOL_HISTORY/);
 assert.ok(prompt.length<12000, `repair prompt ${prompt.length}`);
});
for (const kind of ['dispatch', 'review'] as const) {
 test(`${kind} helped correction includes bounded manager guidance without execution transcripts`, async t => {
  const state = memoryDb(t, []), { headId, departmentId } = readyCompany(state, 'company');
  state.rows(agents).push({ id: 'staff', companyId: 'company', name: 'Staff', slug: 'staff', bossId: headId, departmentId, adapterType: 'webhook', isActive: true });
  const actorId = kind === 'dispatch' ? 'staff' : headId;
  const repair = { mode: 'helped', actorId, reason: 'workProducts[0].url is missing', rejectedReport: '{"kind":"megacorps-report","status":"completed","summary":"Existing artifact completed"}', failures: 3, runKeys: ['run'], visitedActorIds: [], fallbackId: 'manager', helpAttempted: true };
  const card: any = { id: 'card', companyId: 'company', projectId: null, title: 'Correct existing report', body: '## Acceptance\nReturn the existing report.', assigneeId: 'staff', reviewerId: headId, columnStatus: kind === 'dispatch' ? 'todo' : 'in_review', tags: [], dependencyCardIds: [], executionLog: 'RAW_EXECUTION_TRANSCRIPT '.repeat(2000), protocolRepairState: { [kind]: repair } };
  state.rows(kanbanCards).push(card);
  const build = kind === 'dispatch' ? buildTaskPrompt : buildReviewPrompt;
  const beforeGuidance = await build(card);
  card.reviewFeedback = 'RAW_MANAGER_TOOL_HISTORY\n'.repeat(100) + JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'MANAGER_CORRECTION_GUIDANCE: use the verified artifact URL https://example.test/final-report. ' + 'Reference details. '.repeat(170) });
  const prompt = await build(card);
  assert.ok(prompt.includes('MANAGER_CORRECTION_GUIDANCE'), 'the final allowed retry must receive its manager guidance');
  assert.ok(prompt.includes('https://example.test/final-report'), 'preserve the concrete correction supplied by the manager');
  assert.match(prompt, /Manager reporting guidance.*(?:reference data|data)/i);
  assert.doesNotMatch(prompt, /RAW_EXECUTION_TRANSCRIPT|RAW_MANAGER_TOOL_HISTORY/);
  assert.ok(prompt.length - beforeGuidance.length <= 2300, 'manager guidance must stay bounded');
  assert.match(prompt, /(?:omitted|truncated|shortened)/i);
 });

 test(`${kind} correction labels manager guidance only for the matching helped actor and stage`, async t => {
  const state = memoryDb(t, []), { headId, departmentId } = readyCompany(state, 'company');
  state.rows(agents).push({ id: 'staff', companyId: 'company', name: 'Staff', slug: 'staff', bossId: headId, departmentId, adapterType: 'webhook', isActive: true });
  const actorId = kind === 'dispatch' ? 'staff' : headId;
  const otherKind = kind === 'dispatch' ? 'review' : 'dispatch';
  const repair = { mode: 'helped', actorId, reason: 'workProducts[0].url is missing', failures: 3, runKeys: ['run'], visitedActorIds: [], fallbackId: 'manager', helpAttempted: true };
  const card: any = { id: 'card', companyId: 'company', projectId: null, title: 'Correct existing report', body: '## Acceptance\nReturn the existing report.', assigneeId: 'staff', reviewerId: headId, columnStatus: kind === 'dispatch' ? 'todo' : 'in_review', tags: [], dependencyCardIds: [], reviewFeedback: 'Manager supplied the missing artifact details.' };
  state.rows(kanbanCards).push(card);
  const build = kind === 'dispatch' ? buildTaskPrompt : buildReviewPrompt;
  for (const protocolRepairState of [
    { [kind]: { ...repair, mode: 'same_session' } },
    { [kind]: { ...repair, mode: 'fresh_context' } },
    { [kind]: { ...repair, actorId: 'different-actor' } },
    { [kind]: { ...repair, mode: 'fresh_context' }, [otherKind]: repair },
  ]) {
    card.protocolRepairState = protocolRepairState;
    assert.doesNotMatch(await build(card), /Manager reporting guidance/i);
  }
 });
}
