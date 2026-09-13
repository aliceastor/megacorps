import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';
import { normalizeAgentResult } from './agent-results.ts';

const request = {
  kind: 'collaboration',
  departmentSlug: 'product',
  question: 'Supply the wording required by the current implementation.',
  acceptance: ['Provide approved wording covering all visible error states.'],
};
const report = {
  kind: 'megacorps-report',
  status: 'input_required',
  summary: 'Need Product wording to continue this card.',
  request,
};
test('collaboration uses the singular request contract and does not imply completion', () => {
  assert.equal(agentReportSchema.safeParse(report).success, true);
  const normalized = normalizeAgentResult({ report });
  assert.equal(normalized.outcome, 'input_required');
  assert.equal(normalized.report?.request?.kind, 'collaboration');
  assert.equal(normalizeAgentResult({ report: { ...report, status: 'completed' } }).outcome, 'input_required');
});
test('collaboration reports reject ambiguous concurrent workflow actions', () => {
  for (const patch of [
    { status: 'failed' },
    { status: 'rejected' },
    {
      children: [
        {
          title: 'Another task',
          body: 'Acceptance: another separate deliverable to be completed.',
          assigneeSlug: 'other',
        },
      ],
    },
    { verdict: 'approved' },
  ]) {
    const normalized = normalizeAgentResult({ report: { ...report, ...patch } });
    assert.equal(normalized.outcome, 'invalid');
    assert.match(normalized.reason!, /collaboration_request_conflict/);
  }
});
test('collaboration scope and acceptance cannot be omitted or supplied with forged actors', () => {
  for (const patch of [
    { departmentSlug: '' },
    { acceptance: [] },
    { acceptance: null },
    { requesterAgentId: 'forged' },
    { reviewerIds: ['forged'] },
  ]) {
    assert.equal(agentReportSchema.safeParse({ ...report, request: { ...request, ...patch } }).success, false);
  }
});

test('non-owner review and message contexts receive actionable collaboration feedback', () => {
  const normalized = normalizeAgentResult({ report, allowCollaboration: false });
  assert.equal(normalized.outcome, 'invalid');
  assert.match(normalized.reason!, /collaboration_dispatch_required/);
  assert.match(normalized.reason!, /original card owner/);
});
