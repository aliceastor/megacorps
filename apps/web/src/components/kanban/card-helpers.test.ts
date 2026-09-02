import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromCard, isDraftDirty } from './card-helpers.ts';
import type { Card } from './card-types.ts';

// The close guard: the panel refuses to close on a backdrop click (and asks on
// the × button) only when the edit draft differs from the card it was seeded
// from. These pin down what counts as "differs".

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    title: 'Card',
    body: 'Body',
    columnStatus: 'todo',
    tags: ['a'],
    priority: 0,
    assigneeId: 'a-1',
    reviewerId: null,
    departmentId: null,
    projectId: 'p-1',
    goalId: null,
    dependencyCardIds: ['d-1'],
    decisionMode: null,
    requiresApproval: false,
    maxRetries: 3,
    ...overrides,
  };
}

test('a draft seeded from the card is not dirty, and neither is a null draft', () => {
  const base = card();
  assert.equal(isDraftDirty(draftFromCard(base), base), false);
  assert.equal(isDraftDirty(null, base), false);
  assert.equal(isDraftDirty({}, base), false);
});

test('changing a scalar, a nullable id, an array or a checkbox makes the draft dirty', () => {
  const base = card();
  assert.equal(isDraftDirty({ ...draftFromCard(base), title: 'Renamed' }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), reviewerId: 'a-2' }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), tags: ['a', 'b'] }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), dependencyCardIds: [] }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), requiresApproval: true }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), maxRetries: 5 }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), columnStatus: 'in_progress' }, base), true);
});

test('null and undefined are the same "unset" value; array order matters', () => {
  const base = card({ decisionMode: null, goalId: null, tags: [] });
  assert.equal(isDraftDirty({ ...draftFromCard(base), decisionMode: undefined, goalId: undefined }, base), false);
  assert.equal(isDraftDirty({ ...draftFromCard(base), tags: undefined }, base), false);
  const ordered = card({ dependencyCardIds: ['d-1', 'd-2'] });
  assert.equal(isDraftDirty({ ...draftFromCard(ordered), dependencyCardIds: ['d-2', 'd-1'] }, ordered), true);
});

test('the draft shape matches what the board seeds', () => {
  const draft = draftFromCard(card({ tags: undefined as unknown as string[], dependencyCardIds: undefined, maxRetries: undefined, requiresApproval: undefined }));
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(draft.dependencyCardIds, []);
  assert.equal(draft.maxRetries, 3);
  assert.equal(draft.requiresApproval, false);
  assert.deepEqual(Object.keys(draft).sort(), ['assigneeId', 'body', 'columnStatus', 'decisionMode', 'departmentId', 'dependencyCardIds', 'goalId', 'maxRetries', 'priority', 'projectId', 'requiresApproval', 'reviewerId', 'tags', 'title']);
});
