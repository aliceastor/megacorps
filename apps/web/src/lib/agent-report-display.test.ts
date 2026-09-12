import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTerminalAgentReport, reportArtifactHref } from './agent-report-display.ts';

test('artifact links permit web URLs while preserving other values only in the raw record', () => {
  assert.equal(reportArtifactHref('http://192.168.1.180:3300/org/repo/pulls/1'), 'http://192.168.1.180:3300/org/repo/pulls/1');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'not a URL', null]) assert.equal(reportArtifactHref(url), null);
});

const report = { kind: 'megacorps-report', status: 'completed', verdict: 'approved', score: 9, summary: '交付已驗收並合併。', workProducts: [{ type: 'pull_request', title: 'PR #1', url: 'https://example.test/pulls/1' }] };

test('uses only the final terminal report after CLI warning and a diff copy', () => {
  const json = JSON.stringify(report);
  const raw = `⚠️ Normalized model name\n  ┊ review diff\n@@ -0,0 +1 @@\n+${json}\n${json}`;
  assert.deepEqual(projectTerminalAgentReport(raw), { ...report, version: 1, workProducts: [{ ...report.workProducts[0], metadata: {} }] });
  assert.match(raw, /review diff/, 'the raw run output remains untouched');
});

test('does not mistake quoted examples or nonterminal progress for a terminal result', () => {
  assert.equal(projectTerminalAgentReport(`Example only: ${JSON.stringify(report)}\nDo not submit this example.`), null);
  assert.equal(projectTerminalAgentReport(JSON.stringify({ ...report, status: 'progress' })), null);
});

test('never falls back to an earlier approved report when the newer terminal payload is malformed', () => {
  const raw = `${JSON.stringify(report)}\n{"kind":"megacorps-report","status":"completed","verdict":"revision_requested"`;
  assert.equal(projectTerminalAgentReport(raw), null);
});
