import assert from 'node:assert/strict';
import test from 'node:test';
import { projectChatMessage } from './chat-display.ts';

test('projects a recognized chat-actions fence into a compact receipt', () => {
  const raw = 'I added it.\n\n```json\n{"kind":"megacorps-chat-actions","actions":[{"action":"create_card","title":"Ship","body":"Acceptance: shipped"},{"action":"note","body":"Remember this"}]}\n```';
  assert.deepEqual(projectChatMessage(raw, 'agent', 'en'), {
    text: 'I added it.',
    receipt: 'Requested 2 Kanban updates',
    raw,
  });
  assert.match(raw, /megacorps-chat-actions/, 'projection must not mutate the stored body');
});

test('keeps ordinary JSON examples and malformed protocol-looking fences intact', () => {
  for (const raw of [
    'Example:\n```json\n{"answer":42}\n```',
    'Broken example:\n```json\n{"kind":"megacorps-chat-actions","actions":[}\n```',
  ]) assert.deepEqual(projectChatMessage(raw, 'agent', 'en'), { text: raw, receipt: null, raw: null });
});

test('localizes legacy action outcomes without showing a truncated self-note', () => {
  const raw = 'Kanban updates from this conversation:\n✓ Created card "Ship" — created in todo\n✓ Self-note — noted: This legacy text was sliced in the middle of a sentence';
  assert.deepEqual(projectChatMessage(raw, 'system', 'zh-TW'), {
    text: '',
    receipt: '看板更新：已建立 1 張卡片、已儲存 1 則備註',
    raw,
  });
});

test('keeps valid protocol examples followed by prose and reports failures separately', () => {
  const example = 'Example:\n```json\n{"kind":"megacorps-chat-actions","actions":[]}\n```\nThat is only an example.';
  assert.deepEqual(projectChatMessage(example, 'agent', 'en'), { text: example, receipt: null, raw: null });
  const failed = 'Kanban updates from this conversation:\n✗ Self-note — database unavailable';
  assert.equal(projectChatMessage(failed, 'system', 'en').receipt, 'Kanban updates：1 failed');
});
