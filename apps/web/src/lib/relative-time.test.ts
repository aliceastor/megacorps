import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, formatRelative } from './relative-time.ts';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const minutes = (n: number) => NOW - n * 60_000;
const hours = (n: number) => NOW - n * 3_600_000;
const days = (n: number) => NOW - n * 86_400_000;

test('formatRelative picks sensible units in English', () => {
  assert.equal(formatRelative(new Date(NOW - 10_000), NOW, 'en'), 'now');
  assert.equal(formatRelative(new Date(minutes(5)).toISOString(), NOW, 'en'), '5 minutes ago');
  assert.equal(formatRelative(new Date(hours(3)).toISOString(), NOW, 'en'), '3 hours ago');
  assert.equal(formatRelative(new Date(days(1)).toISOString(), NOW, 'en'), 'yesterday');
  assert.equal(formatRelative(new Date(days(3)).toISOString(), NOW, 'en'), '3 days ago');
  assert.equal(formatRelative(new Date(days(14)).toISOString(), NOW, 'en'), '2 weeks ago');
});

test('formatRelative handles the future and other locales', () => {
  assert.equal(formatRelative(new Date(NOW + 2 * 3_600_000), NOW, 'en'), 'in 2 hours');
  const zh = formatRelative(new Date(minutes(5)).toISOString(), NOW, 'zh-TW');
  assert.match(zh, /5/);
  assert.match(zh, /分鐘/);
  const ja = formatRelative(new Date(hours(2)).toISOString(), NOW, 'ja');
  assert.match(ja, /2/);
  assert.match(ja, /時間/);
});

test('formatRelative returns an empty string for missing or invalid input', () => {
  assert.equal(formatRelative(null, NOW, 'en'), '');
  assert.equal(formatRelative(undefined, NOW, 'en'), '');
  assert.equal(formatRelative('', NOW, 'en'), '');
  assert.equal(formatRelative('not a date', NOW, 'en'), '');
});

test('formatRelative falls back to English for an unknown locale', () => {
  assert.equal(formatRelative(new Date(hours(1)).toISOString(), NOW, 'xx-INVALID-@@'), '1 hour ago');
});

test('formatDuration renders a waiting duration', () => {
  assert.equal(formatDuration(4 * 3_600_000, 'en'), '4 hours');
  assert.equal(formatDuration(90_000, 'en'), '2 minutes');
  assert.equal(formatDuration(3 * 86_400_000, 'en'), '3 days');
  assert.equal(formatDuration(-5_000, 'en'), '0 seconds');
  assert.match(formatDuration(4 * 3_600_000, 'zh-TW'), /小時/);
});
