import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFinalText } from './a2a-final-output.ts';
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
