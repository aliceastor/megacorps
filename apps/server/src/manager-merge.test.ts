import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chatWorkItemsSchema } from '@megacorps/shared';
import { memoryDb } from './test-support/memory-db.ts';
import * as s from './db/schema.ts';
import { db } from './db/client.ts';

test('merge_pr is an exact candidate operation, not an arbitrary provider URL', () => {
  const action = {action:'merge_pr', intentId:randomUUID(), headSha:'a'.repeat(40), reason:'Accepted reviewed deliverable is ready.'};
  assert.equal(chatWorkItemsSchema.safeParse({kind:'megacorps-chat-actions',actions:[action]}).success,true);
  for (const patch of [{headSha:'abc'}, {reason:''}, {force:true}, {url:'https://foreign.test/pr/1'}]) {
    assert.equal(chatWorkItemsSchema.safeParse({kind:'megacorps-chat-actions',actions:[{...action,...patch}]}).success,false);
  }
});

test('only current Boss or owning formal Head can authorize a reviewed candidate', async t => {
  const mod = await import('./manager-merge.ts');
  const co=randomUUID(), dep=randomUUID(), other=randomUUID(), cardId=randomUUID(), projectId=randomUUID(), intentId=randomUUID();
  const staff={id:randomUUID(),companyId:co,positionId:randomUUID(),departmentId:dep,isActive:true};
  const head={id:randomUUID(),companyId:co,positionId:randomUUID(),departmentId:dep,isActive:true};
  const boss={id:randomUUID(),companyId:co,positionId:randomUUID(),departmentId:null,isActive:true};
  const roles=[{id:staff.positionId,companyId:co,rank:9,isActive:true,defaultDepartmentId:dep}, {id:head.positionId,companyId:co,rank:1,isActive:true,isDepartmentHead:true,defaultDepartmentId:dep}, {id:boss.positionId,companyId:co,rank:0,isActive:true,isCompanyBoss:true}];
  const identity={id:randomUUID(),scope:randomUUID(),projectId,repoUrl:'https://git.test/org/repo',defaultBranch:'main',headSha:'a'.repeat(40),externalId:'1',candidateKey:'["v2","pull_request",1]',capturedAt:new Date().toISOString()};
  const card={id:cardId,companyId:co,projectId,departmentId:dep,assigneeId:staff.id,columnStatus:'waiting_on_external',mergeGateVersion:3,reviewIdentity:identity};
  const intent={id:intentId,cardId,projectId,waitId:randomUUID(),headSha:identity.headSha,defaultBranch:'main',repoFullName:'org/repo',gateVersion:3,state:'prepared',attemptCount:0,decisionRequired:true,candidateDepartmentId:dep};
  const state=memoryDb(t,[[s.agents,[staff,head,boss]],[s.positions,roles],[s.kanbanCards,[card]],[s.projects,[{id:projectId,companyId:co}]],[s.mergeIntents,[intent]],[s.externalWaits,[{id:intent.waitId,cardId,status:'waiting',authorizedHeadSha:identity.headSha}]], [s.taskRuns,[{id:identity.scope,companyId:co,cardId,agentId:head.id,kind:'review',status:'success',reviewIdentity:identity,output:JSON.stringify({kind:'megacorps-report',status:'completed',verdict:'approved',summary:'Inspected artifact.'})}]]]);
  const action={action:'merge_pr' as const,intentId,headSha:identity.headSha,reason:'Reviewed artifact meets the goal.'};
  const input=(agentId:string)=>({companyId:co,agentId,source:'management' as const});
  await assert.rejects(mod.requestManagerMerge(input(staff.id),action),/merge_role_denied/);
  head.departmentId=other;
  await assert.rejects(mod.requestManagerMerge(input(head.id),action),/merge_role_denied/);
  head.departmentId=dep;
  await assert.rejects(mod.requestManagerMerge(input(head.id),{...action,headSha:'b'.repeat(40)}),/merge_candidate_changed/);
  assert.equal((await mod.requestManagerMerge(input(head.id),action)).status,'authorized');
  assert.equal((await mod.requestManagerMerge(input(boss.id),action)).status,'already_authorized');
  assert.equal((intent as any).authorizedByAgentId,head.id);
  head.isActive=false;
  assert.equal(await mod.managerDecisionStillValid(db,card as any,intent as any),false);
});

test('a bounded uncertain provider attempt becomes a fresh manager decision, never implicit approval', async t => {
  const mod=await import('./manager-merge.ts');
  assert.equal(typeof mod.reopenUncertainMerge,'function');
  const card:any={id:randomUUID(),columnStatus:'waiting_on_external',mergeGateVersion:2};
  const intent:any={id:randomUUID(),cardId:card.id,waitId:randomUUID(),headSha:'a'.repeat(40),defaultBranch:'main',state:'uncertain',attemptCount:1,lastAttemptAt:new Date(Date.now()-60_000),gateVersion:2,authorizedByAgentId:randomUUID(),authorizedAt:new Date(),decisionQuestionId:randomUUID()};
  memoryDb(t,[[s.kanbanCards,[card]],[s.mergeIntents,[intent]]]);
  await mod.reopenUncertainMerge(intent.waitId,{headSha:'b'.repeat(40),base:'main'});
  assert.equal(intent.state,'uncertain');
  await mod.reopenUncertainMerge(intent.waitId,{headSha:intent.headSha,base:'main'});
  assert.equal(intent.state,'retryable');
  assert.equal(intent.authorizedByAgentId,null);
  assert.equal(intent.decisionQuestionId,null);
  assert.equal(intent.attemptCount,1);
});
