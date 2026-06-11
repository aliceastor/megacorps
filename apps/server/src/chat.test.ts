import assert from 'node:assert/strict';
import test from 'node:test';
import { chatInternals } from './chat.ts';

function chatMessage(authorType: 'user' | 'agent' | 'system', body: string, createdAt = new Date()): any {
  return {
    id: crypto.randomUUID(),
    sessionId: '00000000-0000-0000-0000-000000000001',
    companyId: '00000000-0000-0000-0000-000000000002',
    agentId: '00000000-0000-0000-0000-000000000003',
    userId: authorType === 'user' ? '00000000-0000-0000-0000-000000000004' : null,
    authorType,
    body,
    metadata: {},
    costUsd: null,
    durationSeconds: null,
    createdAt,
  };
}

test('direct chat continuation prompt includes recent transcript memory', () => {
  const prompt = chatInternals.buildChatPrompt(
    { id: 'company-1', name: 'Auroria Inc.', mission: 'Ship useful tools.' } as any,
    { id: 'agent-1', name: 'Ribel', adapterType: 'hermes-ssh' } as any,
    [
      chatMessage('user', '現在什麼時間?'),
      chatMessage('agent', '系統時間是 Wed Jun 10 13:14:24 UTC 2026'),
      chatMessage('user', '我剛剛問了你什麼?'),
    ],
    '',
    '',
    true,
  );

  assert.match(prompt, /Recent conversation transcript:/);
  assert.match(prompt, /\[user\] 現在什麼時間\?/);
  assert.match(prompt, /\[agent\] 系統時間是 Wed Jun 10 13:14:24 UTC 2026/);
  assert.match(prompt, /Latest user message:\n\n我剛剛問了你什麼\?/);
  assert.doesNotMatch(prompt, /Kanban context snapshot/);
});

test('direct chat history formatter keeps the most recent messages when capped', () => {
  const formatted = chatInternals.formatChatHistoryForPrompt([
    chatMessage('user', 'old message that should be dropped'),
    chatMessage('agent', 'recent answer'),
    chatMessage('user', 'latest question'),
  ], 45);

  assert.match(formatted, /Earlier Direct Chat messages were omitted/);
  assert.doesNotMatch(formatted, /old message/);
  assert.match(formatted, /latest question/);
});

test('direct chat bootstrap does not duplicate company header when kanban context is present', () => {
  const prompt = chatInternals.buildChatPrompt(
    { id: 'company-1', name: 'Auroria Inc.', mission: 'Ship useful tools.' } as any,
    { id: 'agent-1', name: 'Ribel', adapterType: 'hermes-ssh' } as any,
    [chatMessage('user', 'hello')],
    '## Company\nName: Auroria Inc.\nMission: Ship useful tools.\n\n## Company Structure\nCompany structure:\n[Alice (alice), CTO | Engineering, Owns technical direction.|[list: bob]]',
    'Project: No project / general chat',
    false,
  );

  assert.doesNotMatch(prompt, /^Company: Auroria Inc\./m);
  assert.match(prompt, /## Company\nName: Auroria Inc\./);
  assert.match(prompt, /Company structure:/);
});
