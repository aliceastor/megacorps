import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionCard, createCardSchema } from './index.ts';

test('allows the MVP card status path and blocks invalid skips', () => {
  assert.equal(canTransitionCard('backlog', 'todo'), true);
  assert.equal(canTransitionCard('todo', 'in_progress'), true);
  assert.equal(canTransitionCard('in_progress', 'done'), false);
});

test('rejects empty card bodies at schema level', () => {
  const parsed = createCardSchema.safeParse({ title: 'x', body: '' });
  assert.equal(parsed.success, false);
});
