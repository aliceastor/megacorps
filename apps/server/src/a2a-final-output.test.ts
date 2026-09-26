import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFinalText, terminalReportCandidate } from './a2a-final-output.ts';
import { extractAgentReport } from './agent-report.ts';
import { normalizeA2aSendResult } from './a2a-client.ts';
const banner = '┌─ Reasoning ─────────────────────┐';
const report = { kind: 'megacorps-report', status: 'progress', summary: 'Ready', children: [{ title: 'Build', body: 'Implement the feature and verify the result with tests.', assigneeSlug: 'builder' }, { title: 'Review', body: 'Review the implementation and verify the result with tests.', assigneeSlug: 'reviewer', dependsOn: [0] }] };
const json = JSON.stringify(report);

test('terminal fenced report uses the unchanged production schema', () => {
  const projected = projectFinalText(`${banner}\nUnbalanced { and \"quoted tool output\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``);
  const parsed = extractAgentReport(projected);
  assert.ok(parsed && 'report' in parsed);
  assert.equal(parsed.report.status, 'progress');
  assert.equal(parsed.report.children?.length, 2);
  assert.equal(parsed.report.verdict, undefined);
});

test('oversized terminal line cannot become a report by truncating its prefix', () => {
  assert.match(projectFinalText(`${banner}\n${'x'.repeat(300_000)}${json.padStart(262_144, ' ')}`), /a2a_final_output_ambiguous/);
});

test('invalid newest structured report cannot resurrect text or older DataPart approval', () => {
  const outcome = normalizeA2aSendResult({ message: { parts: [{ text: json }, { data: report }, { data: { kind: 'megacorps-report', status: 'wrong' } }] } });
  const result = extractAgentReport(outcome.text);
  assert.ok(result && 'error' in result);
  assert.equal(outcome.report, null);
});

test('a real truncated terminal report remains a parse error', () => {
  const result = extractAgentReport(projectFinalText(`${banner}\n${json}\n{"kind":"megacorps-report","status":`));
  assert.ok(result && 'error' in result);
});

test('ordinary multiline chat mentioning a reasoning banner is preserved', () => {
  const text = 'The following banner is a CLI example:\n'+banner+'\nA useful explanation.';
  assert.equal(projectFinalText(text), text);
});

test('terminal chat envelope preserves multiline quotes, braces and existing action fences', () => {
  const body = 'Answer with "quotes" and {braces}.\n\n```chat-actions\n{"actions":[]}\n```';
  const final = JSON.stringify({ kind: 'megacorps-chat-response', body });
  assert.equal(projectFinalText(`${banner}\nprivate tool output {\n${final}`), body);
  assert.equal(projectFinalText(final), body);
});

test('invalid newest chat envelope never exposes earlier answer or reasoning', () => {
  const earlier = JSON.stringify({ kind: 'megacorps-chat-response', body: 'Historical answer' });
  for (const final of ['{"kind":"megacorps-chat-response","body":7}', '{"kind":"megacorps-chat-response","body":', '{"kind":"megacorps-chat-response","body":"ok","extra":true}']) {
    assert.match(projectFinalText(`${banner}\n${earlier}\n${final}`), /a2a_final_output_ambiguous/);
  }
});

test('A2A prompt wrapper applies only to chat, including informational chat', async () => {
  const module = await import('./a2a-final-output.ts');
  const prompt = 'Existing chat instructions and chat-actions rules.';
  assert.equal(module.wrapA2aPrompt(prompt, 'task'), prompt);
  assert.equal(module.wrapA2aPrompt(prompt), prompt);
  assert.match(module.wrapA2aPrompt(prompt, 'chat'), /megacorps-chat-response/);
  assert.ok(module.wrapA2aPrompt(prompt, 'chat').includes(prompt));
  assert.match(module.wrapA2aPrompt(prompt, 'chat'), /chat-actions/);
  assert.ok(module.wrapA2aPrompt(prompt, 'chat').endsWith(prompt), 'transport framing must precede the intact supplied prompt');
});

test('chat envelope body stays intact through the A2A boundary', () => {
  const body = 'Literal <think>example</think>, "quotes" and {braces}.\n```chat-actions\n{"actions":[]}\n```';
  const text = JSON.stringify({ kind: 'megacorps-chat-response', body });
  assert.equal(normalizeA2aSendResult({ message: { parts: [{ text }] } }).text, body);
});

test('reports can legitimately mention the chat envelope kind', () => {
  const text = JSON.stringify({ ...report, summary: 'Document megacorps-chat-response framing' });
  assert.equal(projectFinalText(`${banner}\n${text}`), text);
});

test('terminal report candidates reject multiple roots and trailing material', () => {
  const old = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Historical answer', verdict: 'approved' });
  for (const candidate of [`${old} {"status":"wrong"}`, `${old}\n{"status":"wrong"}`, `${old} trailing text`, `${old} {`]) {
    for (const text of [`${banner}\n${candidate}`, `${banner}\n\`\`\`json\n${candidate}\n\`\`\``]) {
      const projected = projectFinalText(text);
      assert.match(projected, /a2a_final_output_ambiguous/);
      assert.equal(extractAgentReport(projected), null);
    }
  }
});

test('standalone report validation respects escaped quotes and braces in strings', () => {
  const json = JSON.stringify({ ...report, summary: 'Quoted "value" and braces {nested} with a backslash \\.' });
  assert.equal(projectFinalText(`${banner}\n${json}`), json);
  const parsed = extractAgentReport(projectFinalText(`${banner}\n\`\`\`json\n${json}\n\`\`\``));
  assert.ok(parsed && 'report' in parsed);
});

test('single invalid and truncated reports still reach normal report correction', () => {
  for (const json of ['{"kind":"megacorps-report","status":"wrong"}', '{"kind":"megacorps-report","status":', '{"kind":"megacorps-report",}']) {
    for (const text of [`${banner}\n${json}`, `${banner}\n\`\`\`json\n${json}\n\`\`\``]) {
      assert.equal(projectFinalText(text), json);
      const parsed = extractAgentReport(projectFinalText(text));
      assert.ok(parsed && 'error' in parsed);
    }
  }
});

const verifierFooter = [
  '⚠️ File-mutation verifier: 1 file(s) were NOT modified this turn despite any wording above that may suggest otherwise. Run `git status` or `read_file` to confirm.',
  "  • `/tmp/helper.py` — [write_file] Write denied: '`/tmp/helper.py`' is outside HERMES_WRITE_SAFE_ROOT (/safe). Unset the variable or add this path's directory prefix.",
].join('\n');

const modelWarning = "⚠️ Normalized model 'deepseek-flash' to 'deepseek-v4-flash' for deepseek.";

test('model alias diagnostic followed by a chat envelope displays only the literal body', () => {
  const savedAlice = `⚠️  Normalized model 'deepseek-flash' to 'deepseek-v4-flash' for deepseek.\n{"kind":"megacorps-chat-response","body":"在。有事直說。"}`;
  assert.equal(normalizeA2aSendResult({ message: { parts: [{ text: savedAlice }] } }).text, '在。有事直說。');
  for (const body of ['在。有事直說。', 'Literal <think>example</think>, "quotes".\n```chat-actions\n{"actions":[]}\n```']) {
    for (const separator of [' ', '\n', '\r\n']) {
      const text = `${modelWarning}${separator}${JSON.stringify({ kind: 'megacorps-chat-response', body })}`;
      assert.equal(normalizeA2aSendResult({ message: { parts: [{ text }] } }).text, body);
    }
  }
});

test('alias diagnostic handling rejects invalid envelopes without selecting an older answer', () => {
  const valid = JSON.stringify({ kind: 'megacorps-chat-response', body: 'old' });
  for (const candidate of ['{"kind":"megacorps-chat-response","body":7}', '{"kind":"megacorps-chat-response","body":', `${valid} trailing`, `${valid}\n${valid}`]) {
    assert.match(projectFinalText(`${modelWarning} ${candidate}`), /a2a_final_output_ambiguous/);
  }
  for (const text of [`Warning: unknown ${valid}`, `${modelWarning} ordinary prose`, `Example: ${modelWarning} ${valid}`]) {
    assert.equal(projectFinalText(text), text);
  }
});

test('known terminal file-mutation verifier footer does not obscure the immediate final report', () => {
  const text = `${banner}\nprivate tool {\n${json}\n\n${verifierFooter}`;
  assert.equal(projectFinalText(text), json);
  assert.equal(projectFinalText(text.replaceAll('\n', '\r\n')), json);
});

test('verifier handling never searches past a newer malformed answer', () => {
  for (const latest of ['{"kind":"megacorps-report","status":', '{"kind":"megacorps-report","status":"wrong"}']) {
    assert.equal(projectFinalText(`${banner}\n${json}\n${latest}\n\n${verifierFooter}`), latest);
  }
  for (const latest of ['Newer unframed answer', `${json} {"status":"wrong"}`]) {
    assert.match(projectFinalText(`${banner}\n${latest}\n\n${verifierFooter}`), /a2a_final_output_ambiguous/);
  }
});

test('unknown or altered terminal warnings and extra output are not discarded', () => {
  for (const footer of [
    'Warning: something happened.',
    `${verifierFooter}\n{"kind":"megacorps-report","status":`,
    verifierFooter.replace('1 file(s)', '2 file(s)'),
    verifierFooter.replace('Write denied:', 'Unrecognized diagnostic:'),
    `${verifierFooter}\n  • {"status":"wrong"}`,
    verifierFooter.replace('(/safe)', '(/safe) EXTRA'),
  ]) {
    const projected = projectFinalText(`${banner}\n${json}\n\n${footer}`);
    assert.ok(projected !== json);
    const parsed = extractAgentReport(projected);
    assert.ok(!parsed || 'error' in parsed);
  }
});

test('the instructed megacorps-report terminal fence preserves the complete validated report', () => {
  const final = JSON.stringify({ ...report, status: 'completed', verdict: 'approved', score: 9,
    workProducts: [{ type: 'report', title: 'Review evidence', summary: 'Verified the exact artifact revision.' }],
  }, null, 2);
  const output = `${banner}\n+const example = '{"kind"';\n\`\`\`megacorps-report\n${final}\n\`\`\``;
  assert.equal(projectFinalText(output), final);
  assert.deepEqual(extractAgentReport(projectFinalText(output)), extractAgentReport(final));
});

const diffPrefix = `${modelWarning}\n  ┊ review diff\na/helper.py → b/helper.py\n@@ -0,0 +1,2 @@\n+start = t.rfind('{"kind"')\n+print(t[start:])\n`;

test('a bare terminal report after a CLI Python diff is isolated before report validation', () => {
  const final = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Exact review evidence retained', verdict: 'approved', score: 9 });
  const output = `${diffPrefix}\n${final}`;
  assert.equal(projectFinalText(output), final);
  assert.deepEqual(extractAgentReport(projectFinalText(output)), extractAgentReport(final));
});

test('a diff-only CLI transcript cannot expose private output when its terminal answer is ambiguous', () => {
  for (const latest of ['Unframed final answer', `${json} trailing output`, `${json}\n{"status":"wrong"}`, `${json}\n\`\`\`python\nprint("done")\n\`\`\``]) {
    assert.match(projectFinalText(`${diffPrefix}\n${latest}`), /a2a_final_output_ambiguous/);
  }
});

test('latest rejected or malformed report after a CLI diff takes precedence over old approval', () => {
  const old = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Old approval', verdict: 'approved' });
  const rejected = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Current rejection', verdict: 'revision_requested' });
  for (const latest of [rejected, '{"kind":"megacorps-report","status":"wrong"}', '{"kind":"megacorps-report","status":']) {
    for (const frame of [(body: string) => body, (body: string) => `\`\`\`megacorps-report\n${body}\n\`\`\``]) {
      const output = `${diffPrefix}\n${old}\n${frame(latest)}`;
      assert.equal(projectFinalText(output), latest);
      const result = extractAgentReport(projectFinalText(output));
      assert.ok(result);
      if (latest === rejected) assert.ok('report' in result && result.report.verdict === 'revision_requested');
      else assert.ok('error' in result);
    }
  }
});

test('report fence recovery stays bounded with large CLI logs and handles the known footer', () => {
  const output = `${banner}\n${'large tool log {\n'.repeat(20_000)}\`\`\`megacorps-report\n${json}\n\`\`\`\n\n${verifierFooter}`;
  assert.equal(projectFinalText(output), json);
});


test('terminal report evidence excludes chat envelopes with nested report objects', () => {
  const envelope = JSON.stringify({ kind: 'megacorps-chat-response', body: report });
  assert.equal(terminalReportCandidate(`${diffPrefix}\n${envelope}`), null);
});

test('terminal report evidence preserves a standalone multiline object', () => {
  const pretty = JSON.stringify(report, null, 2);
  assert.equal(terminalReportCandidate(pretty), pretty);
});

test('terminal report evidence never chooses an older answer after ambiguous trailing text', () => {
  for (const suffix of ['later text', '{"status":"wrong"}', '```python\nprint("done")\n```']) {
    assert.equal(terminalReportCandidate(`${diffPrefix}\n${json}\n${suffix}`), null);
  }
  assert.equal(terminalReportCandidate(`${json} ${json}`), null);
  assert.equal(terminalReportCandidate(`${diffPrefix}\n${json}\n${json}`), json);
  const truncated = '{"kind":"megacorps-report","status":';
  assert.equal(terminalReportCandidate(`${diffPrefix}\n${json}\n${truncated}`), truncated);
});

test('a truncated standalone report cannot promote its nested report to the final answer', () => {
  const outer = `{\n"kind":"megacorps-report",\n"status":"failed",\n"report":\n${json}`;
  assert.equal(terminalReportCandidate(outer), outer);
  const result = extractAgentReport(outer);
  assert.ok(result && 'error' in result);
});
