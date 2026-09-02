import assert from 'node:assert/strict';
import test from 'node:test';
import { MENTIONS_PER_MESSAGE, extractMentionTokens, mentionQuestionMetadata, resolveMentions, type MentionAgent } from './card-mentions.ts';

const roster: MentionAgent[] = [
  { id: 'a1', slug: 'alice', name: 'Alice Astor' },
  { id: 'b1', slug: 'ben', name: 'Ben Ho' },
  { id: 'c1', slug: 'cara', name: 'Cara' },
  { id: 'd1', slug: 'digby', name: 'Digby' },
  { id: 'z1', slug: 'zed', name: 'Zed', isActive: false },
];

test('extractMentionTokens reads mentions at the start and after whitespace or punctuation', () => {
  assert.deepEqual(extractMentionTokens('@alice can you look?'), ['alice']);
  assert.deepEqual(extractMentionTokens('please ask @ben and (@cara) or,@digby; also：@alice'), ['ben', 'cara', 'digby', 'alice']);
  assert.deepEqual(extractMentionTokens('「@ben」 [@cara]'), ['ben', 'cara']);
});

test('extractMentionTokens never treats an email address as a mention', () => {
  assert.deepEqual(extractMentionTokens('mail ricky@example.com about it'), []);
  assert.deepEqual(extractMentionTokens('cc ops@corp.io and @ben'), ['ben']);
});

test('extractMentionTokens strips trailing punctuation and dedupes case-insensitively', () => {
  assert.deepEqual(extractMentionTokens('thanks @ben. also @Ben, and @ben'), ['ben']);
  assert.deepEqual(extractMentionTokens('@cara... @digby,'), ['cara', 'digby']);
});

test('extractMentionTokens keeps unicode and dotted slugs', () => {
  assert.deepEqual(extractMentionTokens('@客戶 請看 @data.eng-2'), ['客戶', 'data.eng-2']);
});

test('extractMentionTokens scans at most the first eight tokens', () => {
  const text = Array.from({ length: 12 }, (_, i) => `@agent${i}`).join(' ');
  assert.deepEqual(extractMentionTokens(text), ['agent0', 'agent1', 'agent2', 'agent3', 'agent4', 'agent5', 'agent6', 'agent7']);
});

test('resolveMentions matches slug case-insensitively, then name with spaces removed', () => {
  const resolved = resolveMentions(['ALICE', 'benho', 'Cara'], roster);
  assert.deepEqual(resolved.agents.map((agent) => agent.id), ['a1', 'b1', 'c1']);
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(resolved.overflow, []);
  assert.equal(resolved.client, false);
});

test('resolveMentions skips inactive agents and the author, and lists unknown tokens', () => {
  const resolved = resolveMentions(['zed', 'ben', 'nobody'], roster, { excludeAgentId: 'b1' });
  assert.deepEqual(resolved.agents, []);
  assert.deepEqual(resolved.unresolved, ['zed', 'nobody']);
});

test('resolveMentions flags client aliases without treating them as unresolved', () => {
  for (const alias of ['client', 'Owner', 'you', '客戶', '老闆']) {
    const resolved = resolveMentions([alias], roster);
    assert.equal(resolved.client, true, alias);
    assert.deepEqual(resolved.unresolved, [], alias);
    assert.deepEqual(resolved.agents, [], alias);
  }
});

test('resolveMentions caps resolved agents per message and reports the overflow', () => {
  const resolved = resolveMentions(['alice', 'ben', 'cara', 'digby', 'ben'], roster);
  assert.equal(MENTIONS_PER_MESSAGE, 3);
  assert.deepEqual(resolved.agents.map((agent) => agent.slug), ['alice', 'ben', 'cara']);
  assert.deepEqual(resolved.overflow, ['digby']);
});

test('mentionQuestionMetadata records the thread source and the human or agent asker', () => {
  assert.deepEqual(
    mentionQuestionMetadata({ targetSlug: 'ben', sourceCommentId: 'c-1', authorName: 'ricky@example.com', authorKind: 'user' }),
    { peerQuestion: true, mention: true, targetSlug: 'ben', sourceCommentId: 'c-1', authorName: 'ricky@example.com', authorKind: 'user' },
  );
  assert.equal(mentionQuestionMetadata({ targetSlug: 'ben', sourceCommentId: null, authorName: 'Alice', authorKind: 'agent' }).sourceCommentId, null);
});
