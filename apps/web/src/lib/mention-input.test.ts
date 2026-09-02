import assert from 'node:assert/strict';
import test from 'node:test';
import { MENTION_QUERY_MAX, insertMention, insertText, mentionQueryAtCaret } from './mention-input.ts';

test('mentionQueryAtCaret finds the token the caret ends', () => {
  assert.deepEqual(mentionQueryAtCaret('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(mentionQueryAtCaret('hi @be', 6), { start: 3, end: 6, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('(@ben', 5), { start: 1, end: 5, query: 'ben' });
  assert.deepEqual(mentionQueryAtCaret('line\n@c', 7), { start: 5, end: 7, query: 'c' });
  assert.deepEqual(mentionQueryAtCaret('@Ben_2.x-y', 10), { start: 0, end: 10, query: 'Ben_2.x-y' });
  assert.deepEqual(mentionQueryAtCaret('@設計', 3), { start: 0, end: 3, query: '設計' });
});

test('mentionQueryAtCaret: a caret inside a token keeps the whole token as the replace range', () => {
  assert.deepEqual(mentionQueryAtCaret('@ben rest', 3), { start: 0, end: 4, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('@ben', 1), { start: 0, end: 4, query: '' });
});

test('mentionQueryAtCaret is null away from a token, after a letter, past a space, or past 20 chars', () => {
  assert.equal(mentionQueryAtCaret('hello', 5), null);
  assert.equal(mentionQueryAtCaret('a@b', 3), null);
  assert.equal(mentionQueryAtCaret('mail a@b.com', 12), null);
  assert.equal(mentionQueryAtCaret('@ben ', 5), null);
  assert.equal(mentionQueryAtCaret('@ben', 0), null);
  assert.equal(mentionQueryAtCaret('', 0), null);
  assert.equal(mentionQueryAtCaret(`@${'x'.repeat(MENTION_QUERY_MAX)}`, MENTION_QUERY_MAX + 1)?.query.length, MENTION_QUERY_MAX);
  assert.equal(mentionQueryAtCaret(`@${'x'.repeat(MENTION_QUERY_MAX + 1)}`, MENTION_QUERY_MAX + 2), null);
});

test('the lead rule is the server\'s: a quote, dash, period, full-width stop or bracket before the @ is not a mention', () => {
  assert.equal(mentionQueryAtCaret('"@be', 4), null);
  assert.equal(mentionQueryAtCaret('—@be', 4), null);
  assert.equal(mentionQueryAtCaret('x.@be', 5), null);
  assert.equal(mentionQueryAtCaret('好。@be', 5), null);
  assert.equal(mentionQueryAtCaret('【@be', 4), null);
  assert.equal(mentionQueryAtCaret('a、@be', 5), null);
  // ...while the server's own lead set still opens the popover.
  assert.deepEqual(mentionQueryAtCaret('好，@be', 5), { start: 2, end: 5, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('「@be', 4), { start: 1, end: 4, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('[@be', 4), { start: 1, end: 4, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('a:@be', 5), { start: 2, end: 5, query: 'be' });
  assert.deepEqual(mentionQueryAtCaret('a；@be', 5), { start: 2, end: 5, query: 'be' });
});

test('mentionQueryAtCaret clamps an out-of-range caret', () => {
  assert.deepEqual(mentionQueryAtCaret('@ben', 99), { start: 0, end: 4, query: 'ben' });
  assert.equal(mentionQueryAtCaret('@ben', -5), null);
  assert.deepEqual(mentionQueryAtCaret('@ben', Number.NaN), { start: 0, end: 4, query: 'ben' });
});

test('insertMention replaces the token at the caret with @slug plus a trailing space', () => {
  assert.deepEqual(insertMention('hi @be', 6, 'ben'), { text: 'hi @ben ', caret: 8 });
  assert.deepEqual(insertMention('@', 1, 'cara'), { text: '@cara ', caret: 6 });
  assert.deepEqual(insertMention('@be and more', 3, 'ben'), { text: '@ben and more', caret: 5 });
  assert.deepEqual(insertMention('@ben tail', 3, 'ben'), { text: '@ben tail', caret: 5 });
  assert.deepEqual(insertMention('say @c\nnext', 6, 'client'), { text: 'say @client \nnext', caret: 12 });
});

test('insertMention without a token inserts one at the caret and keeps the lead rule', () => {
  assert.deepEqual(insertMention('hello', 5, 'ben'), { text: 'hello @ben ', caret: 11 });
  assert.deepEqual(insertMention('', 0, 'ben'), { text: '@ben ', caret: 5 });
  assert.deepEqual(insertMention('hi ', 3, 'ben'), { text: 'hi @ben ', caret: 8 });
  assert.deepEqual(insertMention('a b', 1, 'ben'), { text: 'a @ben b', caret: 7 });
  assert.deepEqual(insertMention('"', 1, 'ben'), { text: '" @ben ', caret: 7 }, 'a quote is not a lead char for the server');
  assert.deepEqual(insertMention('(', 1, 'ben'), { text: '(@ben ', caret: 6 });
});

test('insertText adds a space before an @ when the previous char is a token char', () => {
  assert.deepEqual(insertText('abc', 3, '@'), { text: 'abc @', caret: 5 });
  assert.deepEqual(insertText('', 0, '@'), { text: '@', caret: 1 });
  assert.deepEqual(insertText('x\n', 2, '@'), { text: 'x\n@', caret: 3 });
  assert.deepEqual(insertText('a b', 1, '@'), { text: 'a @ b', caret: 3 });
  assert.deepEqual(insertText('abc', 3, 'x'), { text: 'abcx', caret: 4 });
});

test('the @ button spaces out a quote, dash or full-width stop but not a server-accepted lead char', () => {
  assert.deepEqual(insertText('say "', 5, '@'), { text: 'say " @', caret: 7 });
  assert.deepEqual(insertText('x—', 2, '@'), { text: 'x— @', caret: 4 });
  assert.deepEqual(insertText('好。', 2, '@'), { text: '好。 @', caret: 4 });
  assert.deepEqual(insertText('(', 1, '@'), { text: '(@', caret: 2 });
  assert.deepEqual(insertText('好，', 2, '@'), { text: '好，@', caret: 3 });
  assert.deepEqual(insertText('「', 1, '@'), { text: '「@', caret: 2 });
  assert.deepEqual(insertText('a:', 2, '@'), { text: 'a:@', caret: 3 });
});

test('the @ button then a pick round-trips into a valid mention', () => {
  const opened = insertText('note', 4, '@');
  assert.deepEqual(mentionQueryAtCaret(opened.text, opened.caret), { start: 5, end: 6, query: '' });
  const picked = insertMention(opened.text, opened.caret, 'ben');
  assert.deepEqual(picked, { text: 'note @ben ', caret: 10 });
  assert.equal(mentionQueryAtCaret(picked.text, picked.caret), null);
});
