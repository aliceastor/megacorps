import assert from 'node:assert/strict';
import test from 'node:test';
import { chatInternals } from './chat.ts';

const agent = { name: 'Alice', adapterType: 'a2a' } as Parameters<typeof chatInternals.buildChatPrompt>[1];
const history = [
  { authorType: 'user', body: 'ship the migration' },
  { authorType: 'agent', body: 'on it' },
  { authorType: 'user', body: 'status?' },
] as Parameters<typeof chatInternals.buildChatPrompt>[2];

test('a continuation with unchanged context re-injects nothing', () => {
  const prompt = chatInternals.buildChatPrompt(undefined, agent, history, '', '', true, 'Kanban card index (current, use these ids for update_card):\n- card-1 [todo] Ship it');
  assert.doesNotMatch(prompt, /Standing context changed/);
  assert.match(prompt, /Kanban card index/);
  assert.match(prompt, /status\?/);
});

test('a continuation re-injects standing context once it changes', () => {
  const refreshed = 'Company goals:\n- Company goal: Ship v2';
  const prompt = chatInternals.buildChatPrompt(undefined, agent, history, '', '', true, '', refreshed);
  assert.match(prompt, /Standing context changed since your last turn/);
  assert.match(prompt, /This replaces what you were told before/);
  assert.match(prompt, /Ship v2/);
});

test('the bootstrap turn carries the full context and no refresh banner', () => {
  const prompt = chatInternals.buildChatPrompt(undefined, agent, history, 'Kanban Board Snapshot\nTotal cards: 3', 'Company goals:\n- Company goal: Ship v2', false);
  assert.doesNotMatch(prompt, /Standing context changed/);
  assert.match(prompt, /Goal context:/);
  assert.match(prompt, /Kanban context snapshot:/);
});

test('a continuation injects the digest only when it is provided as changed', () => {
  const digest = '=== Your Recent Activity (all MegaCorps surfaces) ===\n\nYour own notes from recent conversations:\n- (2026-08-31) Use v2 format.';
  const withDigest = chatInternals.buildChatPrompt(undefined, agent, history, '', '', true, '', '', digest);
  assert.match(withDigest, /Your activity elsewhere moved since your last turn/);
  assert.match(withDigest, /Use v2 format\./);
  const without = chatInternals.buildChatPrompt(undefined, agent, history, '', '', true, '', '');
  assert.doesNotMatch(without, /Your activity elsewhere moved/);
});

test('the bootstrap turn carries the digest inline', () => {
  const digest = '=== Your Recent Activity (all MegaCorps surfaces) ===\n\nYour open Kanban cards:\n- [todo] Ship it';
  const prompt = chatInternals.buildChatPrompt(undefined, agent, history, 'ctx', 'goals', false, '', '', digest);
  assert.match(prompt, /=== Your Recent Activity/);
  assert.doesNotMatch(prompt, /Your activity elsewhere moved/);
});
