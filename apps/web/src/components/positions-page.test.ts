import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('position editor does not expose or submit obsolete cross-department delegation authority', () => {
  const source = readFileSync(new URL('./positions-page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /canDelegateAcrossDepartments|Cross-department delegation|cross-department delegation=/i);
});
