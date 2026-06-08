import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionCard, cardStatusSchema, cardStatuses, createAgentSchema, createCardSchema, signupSchema } from './index.ts';

test('allows the canonical card status path and blocks invalid skips', () => {
  assert.deepEqual([...cardStatuses], ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']);
  assert.equal(canTransitionCard('todo', 'in_progress'), true);
  assert.equal(canTransitionCard('in_progress', 'done'), true);
  assert.equal(canTransitionCard('todo', 'done'), false);
  assert.equal(canTransitionCard('in_progress', 'cancelled'), true);
});

test('maps legacy backlog input to todo', () => {
  assert.equal(cardStatusSchema.parse('backlog'), 'todo');
});

test('rejects empty card bodies at schema level', () => {
  const parsed = createCardSchema.safeParse({ title: 'x', body: '' });
  assert.equal(parsed.success, false);
});

test('accepts MVP agent adapter options', () => {
  assert.equal(createAgentSchema.safeParse({ name: 'Alice', slug: 'alice', role: 'worker', adapterType: 'hermes-gateway', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'SSH Alice', slug: 'ssh-alice', role: 'worker', adapterType: 'hermes-ssh', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Local', slug: 'local', role: 'worker', adapterType: 'mock', hermesProfile: 'local-debug' }).success, true);
});

test('signup requires a real password length', () => {
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'short' }).success, false);
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'long-enough' }).success, true);
});
