import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromCard, isDraftDirty, shouldReseedDraft } from './card-helpers.ts';
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

test('dirtiness is measured against the seed row, so a status change landing under the panel is not an edit', () => {
  const seed = card({ columnStatus: 'todo' });
  const draft = draftFromCard(seed);
  const claimed = card({ columnStatus: 'in_progress', assigneeId: 'a-2' });
  assert.equal(isDraftDirty(draft, seed), false, 'the board keeps the seed as the baseline');
  assert.equal(isDraftDirty(draft, claimed), true, 'comparing against the live row would trip the close guard');
});

test('a fresher row of the same card reseeds a clean draft, never an edited one or an open edit form', () => {
  const seed = card({ columnStatus: 'todo' });
  const fresher = card({ columnStatus: 'in_progress', assigneeId: 'a-2' });
  assert.equal(shouldReseedDraft(draftFromCard(seed), seed, fresher, false), true);
  assert.equal(shouldReseedDraft(null, seed, fresher, false), true, 'no draft yet: nothing to lose');
  assert.equal(shouldReseedDraft({ ...draftFromCard(seed), title: 'Renamed' }, seed, fresher, false), false);
  assert.equal(shouldReseedDraft(draftFromCard(seed), seed, fresher, true), false);
  assert.equal(shouldReseedDraft(draftFromCard(seed), seed, seed, false), false, 'the row it was seeded from');
  assert.equal(shouldReseedDraft(draftFromCard(seed), null, fresher, false), false, 'nothing seeded yet');
  assert.equal(shouldReseedDraft(draftFromCard(seed), seed, card({ id: 'card-2' }), false), false, 'another card is seeded by the id effect');
});

test('the draft shape matches what the board seeds', () => {
  const draft = draftFromCard(card({ tags: undefined as unknown as string[], dependencyCardIds: undefined, maxRetries: undefined, requiresApproval: undefined }));
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(draft.dependencyCardIds, []);
  assert.equal(draft.maxRetries, 3);
  assert.equal(draft.requiresApproval, false);
  assert.equal(draft.reviewMode, 'single');
  assert.equal(draft.critical, false);
  assert.deepEqual(draft.reviewerIds, []);
  assert.deepEqual(Object.keys(draft).sort(), ['assigneeId', 'body', 'columnStatus', 'critical', 'decisionMode', 'departmentId', 'dependencyCardIds', 'goalId', 'maxRetries', 'priority', 'projectId', 'requiresApproval', 'reviewMode', 'reviewerId', 'reviewerIds', 'tags', 'title']);
});

test('the blind review fields count as edits like any other field', () => {
  const base = card({ reviewMode: 'single', critical: false, reviewerIds: [] });
  assert.equal(isDraftDirty({ ...draftFromCard(base), reviewMode: 'panel' }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), critical: true }, base), true);
  assert.equal(isDraftDirty({ ...draftFromCard(base), reviewerIds: ['a-2'] }, base), true);
  assert.equal(isDraftDirty(draftFromCard(card({ reviewMode: 'panel', critical: true, reviewerIds: ['a-2', 'a-3'] })), card({ reviewMode: 'panel', critical: true, reviewerIds: ['a-2', 'a-3'] })), false);
});
