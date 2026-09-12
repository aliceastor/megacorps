import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from './index.ts';
test('parent assessment survives native report validation with a bounded server token', () => {
  const parentAssessment = { token: 'a'.repeat(64), verdict: 'approved', summary: 'Parent criteria covered by original report p.' };
  const report = agentReportSchema.parse({ kind: 'megacorps-report', status: 'completed', summary: 'Child accepted', verdict: 'approved', parentAssessment });
  assert.deepEqual((report as any).parentAssessment, parentAssessment);
  for (const patch of [{token: 'forged'}, {verdict: 'done'}, {summary: ''}]) assert.equal(agentReportSchema.safeParse({ ...report, parentAssessment: { ...parentAssessment, ...patch } }).success, false);
});
