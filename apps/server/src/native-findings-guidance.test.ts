import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { normalizeAgentResult } from './agent-results.ts';

const prompt = (body = 'Review the assigned evidence.') => buildAgentPrompt(
  { hermesProfile: 'reviewer', currentSessionId: null },
  { id: 'finding-guidance-card', title: 'Review evidence', body },
);
function example(label: string) {
  const line = prompt().split('\n').find(value => value.startsWith(`${label}: `));
  assert.ok(line, `Generated prompt must provide ${label}`);
  return JSON.parse(line.slice(label.length + 2));
}

test('generated native prompt distinguishes actionable findings from successful checks', () => {
  const text = prompt();
  assert.match(text, /ordinary review.*no actionable defects.*omit findings.*\[\]/i);
  assert.match(text, /successful checks.*summary.*not findings/i);
  assert.match(text, /findings.*array of objects.*severity.*P0.*P1.*P2.*title.*evidence.*requiredFix/i);
});

test('generated minimal ordinary review example passes the real schema and normalizer', () => {
  const report = example('Ordinary review example');
  assert.deepEqual(Object.keys(report).sort(), ['kind', 'version', 'status', 'summary', 'verdict'].sort());
  assert.equal(agentReportSchema.safeParse(report).success, true);
  const result = normalizeAgentResult({ output: JSON.stringify(report) });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.verdict, 'approved');
});

test('generated actionable revision example passes the real schema and normalizer', () => {
  const report = example('Actionable finding example');
  assert.equal(agentReportSchema.safeParse(report).success, true);
  assert.equal(report.findings.length, 1);
  for (const key of ['title', 'evidence', 'requiredFix']) assert.ok(report.findings[0][key].trim());
  assert.ok(['P0', 'P1', 'P2'].includes(report.findings[0].severity));
  const result = normalizeAgentResult({ output: JSON.stringify(report) });
  assert.equal(result.verdict, 'revision_requested');
  assert.notEqual(result.outcome, 'invalid');
});

test('generated panel prompt preserves its specific required report fields', () => {
  const text = prompt('Panel verification: return required findings, verifications, and dispositions for this round.');
  assert.match(text, /Panel verification: return required findings, verifications, and dispositions for this round/);
  assert.match(text, /panel.*verification.*specific.*required findings.*verifications.*dispositions.*do not omit/i);
  assert.match(text, /No HTTP request is needed/);
  assert.match(text, /does not authorize a denied task action/);
});

test('ordinary empty findings and plain verdicts preserve existing review outcomes', () => {
  for (const verdict of ['approved', 'revision_requested'] as const) {
    const report = { kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Reviewed the evidence against the assigned requirements.', verdict, findings: [] };
    assert.equal(agentReportSchema.safeParse(report).success, true);
    assert.equal(normalizeAgentResult({ output: JSON.stringify(report) }).verdict, verdict);
    assert.equal(normalizeAgentResult({ output: `Verdict: ${verdict}` }).verdict, verdict);
  }
});

test('malformed findings and genuine permission reports remain blocked by existing normalization', () => {
  const base = { kind: 'megacorps-report', version: 1, status: 'completed', summary: 'Review completed.', verdict: 'approved' };
  for (const findings of [{ checks: 'passed' }, ['Tests passed'], [{ severity: 'info', title: 'Passed', evidence: 'Tests', requiredFix: 'None' }]]) {
    assert.equal(normalizeAgentResult({ output: JSON.stringify({ ...base, findings }) }).outcome, 'invalid');
  }
  assert.equal(normalizeAgentResult({ output: JSON.stringify({ kind: 'megacorps-report', status: 'input_required', summary: 'The requested task action requires authorization.', request: { kind: 'permission', question: 'Authorize the protected task action?' } }) }).outcome, 'permission');
});
