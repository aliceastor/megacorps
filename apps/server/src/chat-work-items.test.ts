import assert from 'node:assert/strict';
import test from 'node:test';
import { extractChatWorkItems, formatChatWorkItemOutcomes } from './chat-work-items.ts';

test('extractChatWorkItems returns null for ordinary conversation', () => {
  assert.equal(extractChatWorkItems('Sure, the deploy script lives in scripts/.'), null);
  assert.equal(extractChatWorkItems(''), null);
  assert.equal(extractChatWorkItems(null), null);
});

test('extractChatWorkItems reads a fenced create_card block', () => {
  const reply = [
    'I will get that onto the board.',
    '```json',
    '{ "kind": "megacorps-chat-actions", "actions": [',
    '  { "action": "create_card", "title": "Rotate the NFS token", "body": "Rotate and redeploy.", "priority": "high" }',
    '] }',
    '```',
  ].join('\n');
  const extraction = extractChatWorkItems(reply);
  assert.ok(extraction && 'actions' in extraction);
  assert.equal(extraction.actions.actions.length, 1);
  const [action] = extraction.actions.actions;
  assert.equal(action?.action, 'create_card');
  assert.equal(action?.action === 'create_card' && action.title, 'Rotate the NFS token');
});

test('extractChatWorkItems reads an unfenced block and prefers the last one', () => {
  const cardId = '11111111-2222-4333-8444-555555555555';
  const reply = [
    '{ "kind": "megacorps-chat-actions", "actions": [{ "action": "create_card", "title": "draft", "body": "first pass" }] }',
    'On reflection the card already exists, so:',
    `{ "kind": "megacorps-chat-actions", "actions": [{ "action": "update_card", "cardId": "${cardId}", "status": "in_progress" }] }`,
  ].join('\n\n');
  const extraction = extractChatWorkItems(reply);
  assert.ok(extraction && 'actions' in extraction);
  const [action] = extraction.actions.actions;
  assert.equal(action?.action, 'update_card');
  assert.equal(action?.action === 'update_card' && action.cardId, cardId);
});

test('extractChatWorkItems reports a schema violation instead of silently dropping it', () => {
  const extraction = extractChatWorkItems('```json\n{ "kind": "megacorps-chat-actions", "actions": [{ "action": "create_card" }] }\n```');
  assert.ok(extraction && 'error' in extraction);
  assert.match(extraction.error, /chat_actions_schema_invalid/);
});

test('extractChatWorkItems rejects an unknown action rather than guessing', () => {
  const extraction = extractChatWorkItems('```json\n{ "kind": "megacorps-chat-actions", "actions": [{ "action": "delete_card", "cardId": "x" }] }\n```');
  assert.ok(extraction && 'error' in extraction);
});

test('extractChatWorkItems reports malformed JSON', () => {
  const extraction = extractChatWorkItems('```json\n{ "kind": "megacorps-chat-actions", "actions": [ }\n```');
  assert.ok(extraction && 'error' in extraction);
  assert.match(extraction.error, /parse_failed|schema_invalid/);
});

test('formatChatWorkItemOutcomes marks successes and failures distinctly', () => {
  const text = formatChatWorkItemOutcomes([
    { action: 'create_card', cardId: 'c1', title: 'Rotate token', ok: true, detail: 'created in todo' },
    { action: 'update_card', cardId: 'c2', title: null, ok: false, detail: 'card not found' },
  ]);
  assert.match(text, /✓ Created card "Rotate token" — created in todo/);
  assert.match(text, /✗ Updated card "c2" — card not found/);
});
