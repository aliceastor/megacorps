import assert from 'node:assert/strict';
import test from 'node:test';
import { companies, projects, kanbanCards, goals, activityLog } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { companyDiscoveryContext } from './company-discovery.ts';
import { buildCompanyKanbanContext } from './dispatch.ts';

test('general chat discovers company projects even before dispatch, with compact card pointers', async t => {
  memoryDb(t, [[companies, [{ id: 'c' }]], [projects, [
    { id: 'chess', companyId: 'c', name: 'ONLINE CHESS', description: 'Long implementation details '.repeat(1000) },
    { id: 'draft', companyId: 'c', name: 'Unstarted project' },
    { id: 'other', companyId: 'other', name: 'Foreign secret project' },
  ]], [kanbanCards, [{ id: 'card', companyId: 'c', projectId: 'chess', title: 'Build multiplayer', body: 'Private implementation details', columnStatus: 'todo' }, { id: 'foreign', companyId: 'other', projectId: 'other', title: 'Foreign card' }]]]);
  const text = await companyDiscoveryContext('c', null);
  assert.match(text, /ONLINE CHESS.*chess/);
  assert.match(text, /Unstarted project/);
  assert.match(text, /Build multiplayer/);
  assert.doesNotMatch(text, /Foreign|Long implementation details|Private implementation details/);
  assert.match(text, /not.*dispatch/i);
  assert.ok(text.length < 10000);
});

test('focused work keeps other projects discoverable as pointers instead of injecting their full instructions', async t => {
  memoryDb(t, [[companies, [{ id: 'c', name: 'Company' }]], [projects, [{ id: 'p', companyId: 'c', name: 'Current' }, { id: 'other', companyId: 'c', name: 'Other project' }]],
    [kanbanCards, [{ id: 'focus', companyId: 'c', projectId: 'p', title: 'Current work', body: 'Current scope', dependencyCardIds: [], tags: [] }]],
    [goals, [{ id: 'other-goal', companyId: 'c', projectId: 'other', title: 'Other goal', body: 'UNRELATED_DETAILED_INSTRUCTIONS'.repeat(100) }]],
    [activityLog, [{ id: 'old-event', companyId: 'c', entityId: 'unrelated-card', action: 'card.completed', details: { secretNoise: 'UNRELATED_LONG_EXECUTION' }, createdAt: new Date() }]]]);
  const text = await buildCompanyKanbanContext('c', { focusCardId: 'focus' });
  assert.match(text, /Other project/);
  assert.match(text, /Other goal.*other-goal/);
  assert.doesNotMatch(text, /UNRELATED_DETAILED_INSTRUCTIONS|UNRELATED_LONG_EXECUTION/);
  assert.match(text, /Current scope/);
});
