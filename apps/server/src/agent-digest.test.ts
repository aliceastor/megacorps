import assert from 'node:assert/strict';
import test from 'node:test';
import { agentDigestHash, formatAgentDigest } from './agent-digest.ts';

const full = {
  openCards: [
    { title: 'Migrate the auth tables', status: 'in_progress', updatedAt: new Date('2026-08-30T10:00:00Z') },
    { title: 'Write the rollout plan', status: 'todo', updatedAt: new Date('2026-08-29T10:00:00Z') },
  ],
  doneCards: [{ title: 'Fix the login redirect', completedAt: new Date('2026-08-28T09:00:00Z') }],
  rejections: [{ title: 'Fix the login redirect', feedback: 'Missing tests for the SSO path.' }],
  notes: [{ body: 'Agreed with the user to use the v2 report format.', createdAt: new Date('2026-08-31T08:00:00Z') }],
};

test('formatAgentDigest renders every populated section', () => {
  const digest = formatAgentDigest(full);
  assert.match(digest, /=== Your Recent Activity/);
  assert.match(digest, /\[in_progress\] Migrate the auth tables/);
  assert.match(digest, /Fix the login redirect \(2026-08-28\)/);
  assert.match(digest, /do not repeat these mistakes.*\n- Fix the login redirect: Missing tests for the SSO path\./);
  assert.match(digest, /\(2026-08-31\) Agreed with the user to use the v2 report format\./);
});

test('formatAgentDigest returns empty for an agent with no history', () => {
  assert.equal(formatAgentDigest({ openCards: [], doneCards: [], rejections: [], notes: [] }), '');
});

test('digest hash moves only when the digest moves', () => {
  const a = agentDigestHash(formatAgentDigest(full));
  const b = agentDigestHash(formatAgentDigest(full));
  assert.equal(a, b);
  const c = agentDigestHash(formatAgentDigest({ ...full, notes: [] }));
  assert.notEqual(a, c);
});

test('long titles and notes are clipped to one line', () => {
  const digest = formatAgentDigest({
    openCards: [{ title: `multi\nline ${'x'.repeat(400)}`, status: 'todo', updatedAt: null }],
    doneCards: [], rejections: [], notes: [],
  });
  const lines = digest.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 1);
  assert.ok((lines[0] ?? '').length < 200);
});
