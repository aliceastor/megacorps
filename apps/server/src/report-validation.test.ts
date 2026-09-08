import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';
import { formatReportIssues, normalizeOptionalReportFields } from './report-validation.ts';

const child = {
  title: 'Bounded child',
  body: 'Produce the bounded deliverable and include its acceptance evidence.',
  assigneeSlug: 'worker',
  dependsOn: null,
};

test('omits schema-known optional null fields without mutating the original report', () => {
  const input = { kind: 'megacorps-report', status: 'progress', summary: 'Delegated.', children: [child] };
  const original = structuredClone(input);
  const normalized = normalizeOptionalReportFields(input);
  assert.deepEqual(input, original);
  assert.deepEqual(normalized.data, { kind: 'megacorps-report', status: 'progress', summary: 'Delegated.', children: [{ title: child.title, body: child.body, assigneeSlug: child.assigneeSlug }] });
  assert.equal(Object.hasOwn((normalized.data as any).children[0], 'dependsOn'), false);
  assert.deepEqual(normalized.corrections, ['Omitted optional null field children[0].dependsOn.']);
  assert.equal(agentReportSchema.safeParse(normalized.data).success, true);
});

test('does not remove null array members or required null fields', () => {
  const input = { kind: 'megacorps-report', status: 'progress', summary: null, children: [null] };
  const normalized = normalizeOptionalReportFields(input);
  assert.deepEqual(normalized.data, input);
  assert.deepEqual(normalized.corrections, []);
});

test('uses a discriminated report branch to omit its optional null fields', () => {
  const input = {
    kind: 'megacorps-report', status: 'input_required', summary: 'Direction needed.',
    request: { kind: 'checkpoint', checkpointKind: 'direction', question: 'Continue?', recommendation: null },
  };
  const normalized = normalizeOptionalReportFields(input);
  assert.equal(Object.hasOwn((normalized.data as any).request, 'recommendation'), false);
  assert.deepEqual(normalized.corrections, ['Omitted optional null field request.recommendation.']);
});

test('formats nested paths and received types without echoing invalid values', () => {
  const secret = 'super-secret-work-product-value';
  const report = { kind: 'megacorps-report', status: 'completed', summary: 'Done.', workProducts: [{ type: secret, title: null }] };
  const result = agentReportSchema.safeParse(report);
  assert.equal(result.success, false);
  if (result.success) return;
  const message = formatReportIssues(report, result.error.issues);
  assert.match(message, /workProducts\[0\]\.type/);
  assert.match(message, /workProducts\[0\]\.title/);
  assert.match(message, /received string/i);
  assert.match(message, /received null/i);
  assert.doesNotMatch(message, new RegExp(secret));
});

test('copies an untrusted __proto__ metadata key as inert own data', () => {
  const input = JSON.parse('{"kind":"megacorps-report","status":"completed","summary":"Done.","workProducts":[{"type":"report","title":"Evidence","metadata":{"__proto__":null}}]}');
  const normalized = normalizeOptionalReportFields(input);
  const metadata = (normalized.data as any).workProducts[0].metadata;
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
  assert.equal(Object.hasOwn(metadata, '__proto__'), true);
  assert.equal(metadata.__proto__, null);
});
