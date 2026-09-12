import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotAssessmentCoverage } from './assessment-reuse.ts';

const parent: any = { id: 'parent', companyId: 'c', projectId: 'p', title: 'Goal', body: '## Acceptance\nVerified report', assigneeId: 'boss', rollupStatus: 'waiting_on_children', columnStatus: 'in_progress', updatedAt: new Date(0) };
const child: any = { ...parent, id: 'child', parentCardId: parent.id, assigneeId: 'head', reviewerId: 'boss' };
const products: any[] = [{ id: 'product', companyId: 'c', projectId: 'p', cardId: child.id, agentId: 'head', summary: 'Checks pass', metadata: { headSha: 'a'.repeat(40) } }];
test('captures exact single-child coverage by the parent owner without synthesizing a new verdict', () => {
  assert.ok(snapshotAssessmentCoverage(parent, [child], products));
});
test('different scope, reviewer, self-review, multiple children and parent gates cannot reuse', () => {
  for (const patch of [{ assigneeId: 'other' }, { reviewerId: 'other' }, { requiresApproval: true }, { reviewMode: 'panel' }, { critical: true }, { requiredChildPolicy: 'manual' }]) {
    assert.equal(snapshotAssessmentCoverage({ ...parent, ...patch }, [child], products), null);
  }
  assert.equal(snapshotAssessmentCoverage(parent, [{ ...child, assigneeId: 'boss' }], products), null);
  assert.equal(snapshotAssessmentCoverage(parent, [child, { ...child, id: 'second' }], products), null);
  assert.equal(snapshotAssessmentCoverage(parent, [child], []), null);
});
test('fingerprint invalidates every parent mutation, child assignment, revision and product version change', () => {
  const original = snapshotAssessmentCoverage(parent, [child], products);
  for (const patch of [{ updatedAt: new Date(1) }, { tags: ['changed'] }, { dependencyCardIds: ['extra'] }, { splitRound: 2 }]) assert.notEqual(snapshotAssessmentCoverage({ ...parent, ...patch }, [child], products), original);
  for (const patch of [{ reviewIdentity: { headSha: 'b'.repeat(40) } }, { revisionCount: 1 }, { assigneeId: 'replacement' }]) assert.notEqual(snapshotAssessmentCoverage(parent, [{ ...child, ...patch }], products), original);
  assert.notEqual(snapshotAssessmentCoverage(parent, [child], [{ ...products[0], summary: 'Different' }]), original);
});

test('normal descendant completion fence does not change parent scope identity', () => {
 assert.equal(snapshotAssessmentCoverage({...parent,mergeGateVersion:1},[child],products),snapshotAssessmentCoverage({...parent,mergeGateVersion:2},[child],products));
});
test('native extraction preserves explicit assessment and missing/rejected/wrong-token reports cannot mint receipts', async () => {
 const { receiptFromParentAssessment } = await import('./assessment-reuse.ts');
 const { normalizeAgentResult } = await import('./agent-results.ts');
 const capture: any = {version:1,token:'a'.repeat(64),parentId:'parent',childId:'child',reviewerId:'boss',prompt:'Parent goal'};
 const report: any = {kind:'megacorps-report',status:'completed',verdict:'approved',summary:'Child pass',parentAssessment:{token:capture.token,verdict:'approved',summary:'Original product covers parent'}};
 const normalized = normalizeAgentResult({output:JSON.stringify(report)});
 assert.deepEqual(normalized.report?.parentAssessment,report.parentAssessment);
 assert.ok(receiptFromParentAssessment(capture,normalized.report,JSON.stringify(report)));
 for(const patch of [{parentAssessment:undefined},{verdict:'revision_requested'},{status:'progress'},{parentAssessment:{...report.parentAssessment,token:'b'.repeat(64)}},{parentAssessment:{...report.parentAssessment,verdict:'revision_requested'}}]) assert.equal(receiptFromParentAssessment(capture,{...report,...patch},JSON.stringify(report)),null);
 assert.equal(receiptFromParentAssessment(null,report,JSON.stringify(report)),null);
});
test('parent dependencies and explicit reviewer panel members keep normal completion routing', () => {
 assert.equal(snapshotAssessmentCoverage({...parent,dependencyCardIds:['pending-dependency']},[child],products),null);
 assert.equal(snapshotAssessmentCoverage({...parent,reviewerIds:['other-reviewer']},[child],products),null);
});
