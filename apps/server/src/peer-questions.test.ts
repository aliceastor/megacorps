import assert from 'node:assert/strict';
import test from 'node:test';
import { peerMentionsFromOutput } from './dispatch.ts';

test('peerMentionsFromOutput prefers the structured report field', () => {
  const mentions = peerMentionsFromOutput('irrelevant output', { mentions: [{ to: 'bob', question: 'Is the v2 API frozen?' }] });
  assert.deepEqual(mentions, [{ to: 'bob', question: 'Is the v2 API frozen?' }]);
});

test('peerMentionsFromOutput reads mentions from a fenced report in the output', () => {
  const output = [
    'Work finished.',
    '```json',
    '{ "kind": "megacorps-report", "status": "completed", "summary": "done", "mentions": [{ "to": "carol", "question": "Which S3 bucket holds the exports?" }] }',
    '```',
  ].join('\n');
  const mentions = peerMentionsFromOutput(output);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]?.to, 'carol');
});

test('peerMentionsFromOutput caps mentions at three', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ to: `agent-${i}`, question: 'q' }));
  assert.equal(peerMentionsFromOutput('', { mentions: many }).length, 3);
});

test('peerMentionsFromOutput returns empty for plain output', () => {
  assert.deepEqual(peerMentionsFromOutput('just some text with @bob written casually'), []);
});
