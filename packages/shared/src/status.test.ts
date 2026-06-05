import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionCard, createAgentSchema, createCardSchema, signupSchema } from './index.ts';

test('allows the MVP card status path and blocks invalid skips', () => {
  assert.equal(canTransitionCard('backlog', 'todo'), true);
  assert.equal(canTransitionCard('todo', 'in_progress'), true);
  assert.equal(canTransitionCard('in_progress', 'done'), false);
});

test('rejects empty card bodies at schema level', () => {
  const parsed = createCardSchema.safeParse({ title: 'x', body: '' });
  assert.equal(parsed.success, false);
});

test('accepts MVP agent adapter options', () => {
  assert.equal(createAgentSchema.safeParse({ name: 'Alice', slug: 'alice', role: 'worker', adapterType: 'hermes-gateway', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Local', slug: 'local', role: 'worker', adapterType: 'mock', hermesProfile: 'local-debug' }).success, true);
});

test('signup requires a real password length', () => {
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'short' }).success, false);
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'long-enough' }).success, true);
});
