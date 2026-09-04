import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInternals } from './dispatch.ts';

const { resolveAdapterTimeoutSeconds } = dispatchInternals;

test('review-class runs default to 1500s when card and agent timeouts are unset', () => {
  for (const kind of ['review', 'message_review', 'panel_review'] as const) {
    assert.equal(resolveAdapterTimeoutSeconds({
      cardTimeoutSeconds: null,
      agentDefaultTimeoutSeconds: null,
      kind,
      globalKanbanTimeoutSeconds: 300,
    }), 1500, kind);
  }
});

test('dispatch runs fall back to the global kanban timeout', () => {
  assert.equal(resolveAdapterTimeoutSeconds({
    cardTimeoutSeconds: null,
    agentDefaultTimeoutSeconds: null,
    kind: 'dispatch',
    globalKanbanTimeoutSeconds: 300,
  }), 300);
});

test('agent defaultTimeoutSeconds is used immediately when the card has no timeout', () => {
  assert.equal(resolveAdapterTimeoutSeconds({
    cardTimeoutSeconds: null,
    agentDefaultTimeoutSeconds: 900,
    kind: 'dispatch',
    globalKanbanTimeoutSeconds: 300,
  }), 900);
  assert.equal(resolveAdapterTimeoutSeconds({
    cardTimeoutSeconds: null,
    agentDefaultTimeoutSeconds: 900,
    kind: 'review',
    globalKanbanTimeoutSeconds: 300,
  }), 900);
});

test('card timeoutSeconds wins over agent default and the review 1500 fallback', () => {
  assert.equal(resolveAdapterTimeoutSeconds({
    cardTimeoutSeconds: 600,
    agentDefaultTimeoutSeconds: 900,
    kind: 'review',
    globalKanbanTimeoutSeconds: 300,
  }), 600);
});
