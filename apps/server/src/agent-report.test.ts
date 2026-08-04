import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';

test('agentReportSchema accepts a complete report', () => {
  const parsed = agentReportSchema.parse({
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'Implemented the ingest pipeline and pushed a PR.',
    delegations: [{ to: 'ribel', objective: 'Build the UI shell', effort: 'small' }],
    artifactRefs: ['artifact-1'],
  });
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.delegations?.[0]?.mode, 'subroutine');
});

test('agentReportSchema requires kind and summary', () => {
  assert.equal(agentReportSchema.safeParse({ kind: 'megacorps-report', status: 'completed' }).success, false);
  assert.equal(agentReportSchema.safeParse({ status: 'completed', summary: 'x' }).success, false);
});

test('agentReportSchema validates verdict enum', () => {
  assert.equal(agentReportSchema.safeParse({
    kind: 'megacorps-report', status: 'completed', summary: 'ok', verdict: 'approved',
  }).success, true);
  assert.equal(agentReportSchema.safeParse({
    kind: 'megacorps-report', status: 'completed', summary: 'ok', verdict: 'maybe',
  }).success, false);
});

test('agentReportSchema caps delegations at 8', () => {
  const delegations = Array.from({ length: 9 }, (_, i) => ({ objective: `task ${i}` }));
  assert.equal(agentReportSchema.safeParse({
    kind: 'megacorps-report', status: 'completed', summary: 'ok', delegations,
  }).success, false);
});
