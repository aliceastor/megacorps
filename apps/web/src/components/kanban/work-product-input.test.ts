import assert from 'node:assert/strict';
import test from 'node:test';
import { inferWorkProductType } from './work-product-input.ts';

test('one durable URL identifies PR and commit forms without declaring verification', () => {
  for (const path of ['org/repo/pull/12', 'org/repo/pulls/12', 'org/repo/-/merge_requests/12']) assert.equal(inferWorkProductType(`https://example.test/${path}?tab=files`), 'pull_request');
  assert.equal(inferWorkProductType('https://example.test/org/repo/commit/' + 'a'.repeat(40)), 'commit');
  for (const url of ['not a URL', 'javascript:alert(1)', 'https://example.test/report', 'https://example.test/org/repo/pull/12/files', 'https://example.test/org/repo/commit/not-a-sha']) assert.equal(inferWorkProductType(url), 'external');
});
