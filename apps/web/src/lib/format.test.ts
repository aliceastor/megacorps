import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTemplate } from './format.ts';

test('formatTemplate replaces {name} tokens with strings and numbers', () => {
  assert.equal(formatTemplate('等 {count} 張子卡 · 第 {n} 輪', { count: 3, n: 2 }), '等 3 張子卡 · 第 2 輪');
  assert.equal(formatTemplate('{name} is working', { name: 'Alice' }), 'Alice is working');
});

test('formatTemplate keeps unknown tokens literal', () => {
  assert.equal(formatTemplate('Waiting for {name} · {missing}', { name: 'Bob' }), 'Waiting for Bob · {missing}');
  assert.equal(formatTemplate('{a}{b}', {}), '{a}{b}');
});

test('formatTemplate replaces repeated tokens and tolerates empty values', () => {
  assert.equal(formatTemplate('{x} and {x}', { x: 'y' }), 'y and y');
  assert.equal(formatTemplate('[{empty}]', { empty: '' }), '[]');
  assert.equal(formatTemplate('zero {n}', { n: 0 }), 'zero 0');
});

test('formatTemplate leaves text without tokens untouched', () => {
  assert.equal(formatTemplate('plain text', { anything: 1 }), 'plain text');
  assert.equal(formatTemplate('', {}), '');
});
