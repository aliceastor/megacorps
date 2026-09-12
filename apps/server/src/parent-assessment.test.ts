import assert from 'node:assert/strict';
import test from 'node:test';
import { activityLog, agents, approvals, companies, kanbanCards, positions, projects, taskRuns, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { captureParentAssessment, tryReuseParentAssessment } from './parent-assessment.ts';
import { receiptFromParentAssessment } from './assessment-reuse.ts';
function fixture(t: any) {
 const parent: any = { id: 'parent', companyId: 'c', projectId: 'p', title: 'Company goal', body: 'Acceptance: report covers strategy', assigneeId: 'boss', rollupStatus: 'waiting_on_children', columnStatus: 'in_progress', updatedAt: new Date(0) };
 const child: any = { id: 'child', companyId: 'c', projectId: 'p', parentCardId: parent.id, title: 'Department report', body: 'Acceptance: professional evidence', assigneeId: 'head', reviewerId: 'boss', columnStatus: 'in_review' };
 const product: any = { id: 'product', companyId: 'c', projectId: 'p', cardId: child.id, agentId: 'head', title: 'Original', taskRunId: 'author-run', summary: 'Verified findings' };
 const state = memoryDb(t, [[kanbanCards, [parent, child]], [workProducts, [product]], [companies, [{id:'c'}]], [projects, [{id:'p',companyId:'c'}]], [agents,[{id:'boss',companyId:'c',positionId:'bp',isActive:true}]], [positions,[{id:'bp',companyId:'c',isCompanyBoss:true,isActive:true}]]]);
 return { parent, child, product, state };
}
async function accept(t: any) {
 const f = fixture(t); const capture = await captureParentAssessment(f.child, 'boss'); assert.ok(capture);
 const report: any = {kind:'megacorps-report',status:'completed',verdict:'approved',summary:'Child approved',parentAssessment:{token:capture.token,verdict:'approved',summary:'Parent covered by original product'}};
 const output = JSON.stringify(report);
 const receipt = receiptFromParentAssessment(capture, report, output); assert.ok(receipt);
 f.child.columnStatus='done'; f.child.reviewFeedback=output; f.child.deliveryAcceptance=await captureDeliveryAcceptance(f.child);
 f.state.rows(activityLog).push({id:'approved',companyId:'c',entityType:'card',entityId:'child',actorType:'agent',actorId:'boss',agentId:'boss',action:'review.approved',details:{parentAssessment:receipt},createdAt:new Date()});
 return f;
}
test('explicit approved combined assessment closes unchanged parent without new work or duplicate assessment', async t => {
 const f = await accept(t); const updated = await tryReuseParentAssessment(f.parent.id); assert.equal(updated?.columnStatus,'done'); assert.ok(updated?.deliveryAcceptance);
 assert.equal(f.state.rows(workProducts).length,1); assert.equal(f.state.rows(taskRuns).length,0);
 assert.equal(f.state.rows(activityLog).filter(r=>r.action==='parent.assessment_reused').length,1);
 assert.equal(await tryReuseParentAssessment(f.parent.id),null);
});
for (const scenario of ['body','head','author','gate','missing','rejected','parent-gate','second-child','running','boss-authority','output'] as const) test(`reuse falls back when ${scenario} changes`, async t => {
 const f = await accept(t);
 if(scenario==='body')f.parent.body='Changed goal';
 if(scenario==='head')f.product.metadata={headSha:'new'};
 if(scenario==='author')f.child.assigneeId='replacement';
 if(scenario==='gate')f.state.rows(approvals).push({id:'gate',cardId:f.child.id,status:'pending'});
 if(scenario==='missing')f.child.deliveryAcceptance=null;
 if(scenario==='rejected')f.child.columnStatus='todo';
 if(scenario==='parent-gate')f.state.rows(approvals).push({id:'gate',cardId:f.parent.id,status:'pending'});
 if(scenario==='second-child')f.state.rows(kanbanCards).push({...f.child,id:'second'});
 if(scenario==='running')f.state.rows(taskRuns).push({id:'running',cardId:f.parent.id,status:'running'});
 if(scenario==='boss-authority')f.state.rows(positions)[0]!.isCompanyBoss=false;
 if(scenario==='output')f.child.reviewFeedback='Different approval';
 assert.equal(await tryReuseParentAssessment(f.parent.id),null); assert.equal(f.parent.columnStatus,'in_progress');
});
test('cascade uses the explicit receipt before enqueueing another owner model assessment', async t => {
 const f = await accept(t);
 const { cascadeParentStatus } = await import('./dispatch.ts');
 await cascadeParentStatus(f.parent.id);
 assert.equal(f.parent.columnStatus, 'done');
 assert.equal(f.state.rows(taskRuns).length, 0);
});
