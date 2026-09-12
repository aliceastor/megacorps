import assert from 'node:assert/strict';
import test from 'node:test';
import { kanbanCards, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { captureDeliveryAcceptance } from './delivery-acceptance.ts';
import { acceptedReviewerEvidencePacket } from './reviewer-evidence.ts';
test('packet exposes current accepted reviewer checks and original provenance, not raw CLI histories',async t=>{
 const parent:any={id:'parent',companyId:'c',projectId:null};
 const child:any={id:'child',companyId:'c',projectId:null,parentCardId:'parent',columnStatus:'done',assigneeId:'author',reviewerId:'reviewer',title:'Report',reviewFeedback:JSON.stringify({kind:'megacorps-report',status:'completed',verdict:'approved',summary:'Checked 4 references against source records; remaining scope excluded',score:8,verifications:[{findingKey:'R1',status:'verified',note:'Reference checked'}]})};
 const product:any={id:'product',companyId:'c',projectId:null,cardId:'child',agentId:'author',taskRunId:'author-run',title:'Original report'};
 memoryDb(t,[[kanbanCards,[parent,child]],[workProducts,[product]]]);child.deliveryAcceptance=await captureDeliveryAcceptance(child);
 const packet=await acceptedReviewerEvidencePacket(parent);
 assert.match(packet,/reviewer=reviewer/);assert.match(packet,/author=author/);assert.match(packet,/product/);assert.match(packet,/Checked 4 references/);assert.match(packet,/score=8/);assert.match(packet,/remaining scope excluded/);
 product.title='Changed';assert.doesNotMatch(await acceptedReviewerEvidencePacket(parent),/Checked 4 references/);
});
test('unstructured reviewer output stays a pointer and cannot claim checks',async t=>{
 const parent:any={id:'parent',companyId:'c',projectId:null};const child:any={id:'child',companyId:'c',projectId:null,parentCardId:'parent',columnStatus:'done',assigneeId:'author',reviewerId:'reviewer',reviewFeedback:'SECRET_RAW_CLI historical tools'};
 memoryDb(t,[[kanbanCards,[parent,child]],[workProducts,[{id:'product',companyId:'c',projectId:null,cardId:'child',agentId:'author'}]]]);child.deliveryAcceptance=await captureDeliveryAcceptance(child);
 const packet=await acceptedReviewerEvidencePacket(parent);assert.doesNotMatch(packet,/SECRET_RAW_CLI/);assert.match(packet,/structured reviewer checks unavailable/);
});
