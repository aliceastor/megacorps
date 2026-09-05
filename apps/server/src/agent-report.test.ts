import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';
import { delegationLineFromReportItem, extractAgentReport, structuredDelegationPlan } from './agent-report.ts';

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

const validReportJson = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'done the work' });

test('legacy progress reports preserve work products and typed requests', () => {
  const result = extractAgentReport(JSON.stringify({ kind: 'megacorps-report', status: 'in_progress', summary: 'Working',
    request: { kind: 'permission', question: 'Allow the clone command?' },
    workProducts: [{ type: 'pull_request', title: 'Change', url: 'https://github.com/example/repo/pull/1' }],
  }));
  assert.ok(result && 'report' in result);
  assert.equal(result.report.status, 'progress');
  assert.equal(result.report.version, 1);
  assert.equal(result.report.request?.kind, 'permission');
  assert.equal(result.report.workProducts?.[0]?.url, 'https://github.com/example/repo/pull/1');
});

test('report work products use existing field bounds and discard untrusted ownership fields', () => {
  const parsed = agentReportSchema.parse({ kind: 'megacorps-report', status: 'completed', summary: 'Done', workProducts: [{ type: 'file', title: 'Deliverable', summary: 'x'.repeat(4000), branch: 'b'.repeat(240), cardId: 'foreign-card', companyId: 'foreign-company', agentId: 'foreign-agent', taskRunId: 'foreign-run' }] });
  assert.equal(parsed.workProducts?.[0]?.summary?.length, 4000);
  assert.equal('agentId' in (parsed.workProducts?.[0] ?? {}), false);
  assert.equal(agentReportSchema.safeParse({ kind: 'megacorps-report', status: 'completed', summary: 'Done', workProducts: [{ title: '' }] }).success, false);
});

test('typed requests reject unknown kinds and retain checkpoint options', () => {
  const parsed = agentReportSchema.parse({ kind: 'megacorps-report', status: 'input_required', summary: 'Choose direction', request: { kind: 'checkpoint', checkpointKind: 'interim', question: 'Accept draft direction?', options: ['Keep', 'Revise'], recommendation: 'Keep' } });
  assert.equal(parsed.request?.kind, 'checkpoint');
  assert.deepEqual(parsed.request && 'options' in parsed.request ? parsed.request.options : null, ['Keep', 'Revise']);
  assert.equal(agentReportSchema.safeParse({ kind: 'megacorps-report', status: 'input_required', summary: 'Question', request: { kind: 'magic', question: 'Proceed?' } }).success, false);
});

for (const final of [
  '{"kind":"megacorps-report","status":"wrong","summary":"invalid"}',
  '{"kind":"megacorps-report","status":"completed",}',
  '{"kind":"megacorps-report","status":"completed"',
]) {
  test(`a malformed final report never falls back to an earlier valid report: ${final}`, () => {
    const result = extractAgentReport(`\`\`\`json\n${validReportJson}\n\`\`\`\n${final}`);
    assert.ok(result && 'error' in result);
  });
}

test('extractAgentReport reads a fenced json block', () => {
  const output = `Here is my report:\n\n\`\`\`json\n${validReportJson}\n\`\`\`\n\nThanks.`;
  const result = extractAgentReport(output);
  assert.ok(result && 'report' in result);
  assert.equal(result.report.summary, 'done the work');
});

test('extractAgentReport reads a bare json object output', () => {
  const result = extractAgentReport(validReportJson);
  assert.ok(result && 'report' in result);
});

test('extractAgentReport reads an embedded json object mid-prose', () => {
  const output = `Status update. ${validReportJson} End of message.`;
  const result = extractAgentReport(output);
  assert.ok(result && 'report' in result);
});

test('extractAgentReport returns error for invalid report blocks', () => {
  const bad = JSON.stringify({ kind: 'megacorps-report', status: 'nope', summary: 'x' });
  const result = extractAgentReport(`\`\`\`json\n${bad}\n\`\`\``);
  assert.ok(result && 'error' in result);
});

test('extractAgentReport returns null when no report marker exists', () => {
  assert.equal(extractAgentReport('Just a plain prose update with {"some":"json"}.'), null);
  assert.equal(extractAgentReport(''), null);
  assert.equal(extractAgentReport(null), null);
});

test('extractAgentReport uses the last report when multiple exist', () => {
  const first = JSON.stringify({ kind: 'megacorps-report', status: 'failed', summary: 'first' });
  const second = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'second' });
  const result = extractAgentReport(`\`\`\`json\n${first}\n\`\`\`\ntext\n\`\`\`json\n${second}\n\`\`\``);
  assert.ok(result && 'report' in result);
  assert.equal(result.report.summary, 'second');
});

test('delegationLineFromReportItem formats assignee prefix and constraints', () => {
  assert.equal(
    delegationLineFromReportItem({ to: 'ribel', objective: 'Build the UI shell', mode: 'subroutine' }),
    'ribel: Build the UI shell',
  );
  const line = delegationLineFromReportItem({
    objective: 'Cluster the concepts',
    outputFormat: 'markdown table',
    boundaries: 'do not rank',
    mode: 'subroutine',
  });
  assert.match(line, /^Cluster the concepts — output: markdown table — boundaries: do not rank$/);
});

test('delegationLineFromReportItem clips very long lines', () => {
  const line = delegationLineFromReportItem({ objective: 'x'.repeat(600), mode: 'subroutine' });
  assert.ok(line.length <= 500);
});

function reportWith(delegations: unknown[]): string {
  return `\`\`\`json\n${JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'plan', delegations })}\n\`\`\``;
}

test('structuredDelegationPlan splits handoff from subroutine work', () => {
  const plan = structuredDelegationPlan(reportWith([{ to: 'ribel', objective: 'Own the rest of this card', mode: 'handoff' }]));
  assert.ok(plan);
  assert.equal(plan.handoff?.to, 'ribel');
  assert.equal(plan.subroutineLines.length, 0);
  assert.equal(plan.mixed, false);
});

test('structuredDelegationPlan flags mixed handoff and subroutines', () => {
  const plan = structuredDelegationPlan(reportWith([
    { to: 'ribel', objective: 'take over', mode: 'handoff' },
    { objective: 'also research this', mode: 'subroutine' },
  ]));
  assert.ok(plan);
  assert.equal(plan.mixed, true);
});

test('structuredDelegationPlan returns null without a report or delegations', () => {
  assert.equal(structuredDelegationPlan('DELEGATE:\n- prose only'), null);
  assert.equal(structuredDelegationPlan(reportWith([])), null);
});
