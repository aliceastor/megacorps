import assert from 'node:assert/strict';
import test from 'node:test';
import { CARD_SEEN_LIMIT, parseCardSeen, rememberCardSeen } from './card-seen.ts';

test('rememberCardSeen records the time and keeps the newest entries within the cap', () => {
  let map = {};
  for (let index = 0; index < CARD_SEEN_LIMIT + 5; index += 1) map = rememberCardSeen(map, `card-${index}`, 1_000 + index);
  const keys = Object.keys(map);
  assert.equal(keys.length, CARD_SEEN_LIMIT);
  assert.ok(!keys.includes('card-0'));
  assert.ok(keys.includes(`card-${CARD_SEEN_LIMIT + 4}`));
  assert.deepEqual(rememberCardSeen({ a: 5 }, 'a', 9), { a: 9 });
  assert.deepEqual(rememberCardSeen({ a: 5, b: Number.NaN, c: -1 }, 'd', 7), { d: 7, a: 5 });
  assert.deepEqual(Object.keys(rememberCardSeen({ a: 1, b: 2 }, 'c', 3, 1)), ['c']);
});

test('parseCardSeen tolerates junk and keeps only positive finite numbers', () => {
  assert.deepEqual(parseCardSeen(null), {});
  assert.deepEqual(parseCardSeen(''), {});
  assert.deepEqual(parseCardSeen('not json'), {});
  assert.deepEqual(parseCardSeen('[1,2]'), {});
  assert.deepEqual(parseCardSeen('"str"'), {});
  assert.deepEqual(parseCardSeen(JSON.stringify({ a: 10, b: 'x', c: 0, d: -2, e: null, f: 3.5 })), { a: 10, f: 3.5 });
});
