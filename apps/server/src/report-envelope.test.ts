import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAgentReport } from './agent-report.ts';
import { normalizeAgentResult } from './agent-results.ts';

const metadata = { kind: 'megacorps-report', version: 1, status: 'progress', summary: 'Delegate the bounded deliverable.' };
const child = { title: 'Write the guide', assigneeSlug: 'head', body: '## Acceptance\n- Deliver a complete, verified guide for the intended audience.' };
const products = [{ type: 'report', title: 'Evidence', url: 'https://example.test/evidence' }];
function parsed(value: unknown) {
  const result = extractAgentReport(JSON.stringify(value));
  assert.ok(result && 'report' in result, JSON.stringify(result));
  return result.report;
}

test('observed native metadata plus report.children retains the child and root notes', () => {
  const result = parsed({ ...metadata, notes: ['The author owns the result.'], report: { children: [child] } });
  assert.deepEqual(result.children, [child]);
  assert.deepEqual(result.notes, ['The author owns the result.']);
  assert.equal(result.status, 'progress');
  assert.equal(Object.hasOwn(result, 'report'), false);
});

test('single envelope may carry the complete canonical report', () => {
  assert.deepEqual(parsed({ report: { ...metadata, children: [child] } }), parsed({ ...metadata, children: [child] }));
});

test('disjoint canonical fields and identical scalar metadata normalize once', () => {
  const result = parsed({ ...metadata, notes: ['Root note.'], report: { ...metadata, children: [child], delegations: [{ to: 'worker', objective: 'Inspect the evidence.' }], workProducts: products } });
  assert.equal(result.children?.length, 1);
  assert.equal(result.delegations?.[0]?.to, 'worker');
  assert.equal(result.workProducts?.[0]?.url, products[0]!.url);
  assert.deepEqual(result.notes, ['Root note.']);
});

test('flat canonical reports retain existing behavior', () => {
  const result = parsed({ ...metadata, children: [child], workProducts: products });
  assert.deepEqual(result.children, [child]);
  assert.equal(result.workProducts?.length, 1);
});

test('wrapped permission request remains permission even beside a completed/approved claim', () => {
  const result = normalizeAgentResult({ output: JSON.stringify({ ...metadata, status: 'completed', verdict: 'approved', report: { request: { kind: 'permission', question: 'Authorize the repository write.' }, workProducts: products } }) });
  assert.equal(result.outcome, 'permission');
  assert.equal(result.verdict, null);
  assert.equal(result.workProducts.length, 1);
});

for (const [name, value] of Object.entries({
  null_wrapper: { ...metadata, report: null },
  string_wrapper: { ...metadata, report: 'children' },
  array_wrapper: { ...metadata, report: [{ children: [child] }] },
  recursive_wrapper: { ...metadata, report: { report: { children: [child] } } },
  unknown_nested_field: { ...metadata, report: { children: [child], childCards: [child] } },
  unknown_nested_only: { ...metadata, report: { decision: 'failed' } },
  status_conflict: { ...metadata, status: 'completed', report: { status: 'failed' } },
  summary_conflict: { ...metadata, report: { summary: 'Different intent.' } },
  kind_conflict: { ...metadata, report: { kind: 'other-report' } },
  version_conflict: { ...metadata, report: { version: 2 } },
  duplicate_children: { ...metadata, children: [child], report: { children: [child] } },
  duplicate_notes: { ...metadata, notes: ['A'], report: { notes: ['B'] } },
  duplicate_products: { ...metadata, workProducts: products, report: { workProducts: products } },
  duplicate_verdict: { ...metadata, verdict: 'approved', report: { verdict: 'approved' } },
  conflicting_permission_request: { ...metadata, request: { kind: 'help', question: 'Help?' }, report: { request: { kind: 'permission', question: 'Authorize?' } } },
  invalid_lifted_children: { ...metadata, report: { children: [{ ...child, body: 'short' }] } },
  invalid_lifted_products: { ...metadata, report: { workProducts: [{ type: 'invented', title: 'Evidence' }] } },
  invalid_lifted_request: { ...metadata, report: { request: { kind: 'permission', question: '' } } },
  invalid_lifted_status: { report: { ...metadata, status: 'done' } },
})) test(`${name} fails closed instead of losing nested intent`, () => {
  const result = extractAgentReport(JSON.stringify(value));
  assert.ok(result && 'error' in result, JSON.stringify(result));
  assert.match(result.error, /report_(?:envelope|schema)_invalid/);
  assert.equal(normalizeAgentResult({ output: JSON.stringify(value) }).outcome, 'invalid');
});

test('a malformed final envelope cannot fall back to an earlier valid report', () => {
  const result = extractAgentReport(`${JSON.stringify(metadata)}\n${JSON.stringify({ ...metadata, report: { report: { children: [child] } } })}`);
  assert.ok(result && 'error' in result);
});

test('embedded reports normalize optional child nulls without changing required nulls', () => {
  const optional = extractAgentReport(JSON.stringify({ ...metadata, children: [{ ...child, dependsOn: null }] }));
  assert.ok(optional && 'report' in optional, JSON.stringify(optional));
  assert.equal(Object.hasOwn(optional.report.children![0]!, 'dependsOn'), false);

  const required = extractAgentReport(JSON.stringify({ ...metadata, summary: null }));
  assert.ok(required && 'error' in required, JSON.stringify(required));
  assert.match(required.error, /summary/);
  assert.match(required.error, /received null/i);
});

test('embedded report diagnostics identify invalid product fields without exposing values', () => {
  const secret = 'secret-invalid-product-type';
  const result = extractAgentReport(JSON.stringify({ ...metadata, workProducts: [{ type: secret, title: null }] }));
  assert.ok(result && 'error' in result, JSON.stringify(result));
  assert.match(result.error, /workProducts\[0\]\.type/);
  assert.match(result.error, /workProducts\[0\]\.title/);
  assert.match(result.error, /received string/i);
  assert.match(result.error, /received null/i);
  assert.doesNotMatch(result.error, new RegExp(secret));
});

test('conflicting envelope diagnostics identify the nested field and received type', () => {
  const result = extractAgentReport(JSON.stringify({ ...metadata, summary: 'Outer intent.', report: { summary: 'Nested intent.' } }));
  assert.ok(result && 'error' in result, JSON.stringify(result));
  assert.match(result.error, /report\.summary/);
  assert.match(result.error, /received string/i);
  assert.doesNotMatch(result.error, /Outer intent|Nested intent/);
});

test('embedded report extraction retains an audit record of optional-null corrections', () => {
  const result = extractAgentReport(JSON.stringify({ ...metadata, children: [{ ...child, dependsOn: null }] }));
  assert.ok(result && 'report' in result, JSON.stringify(result));
  assert.deepEqual(result.corrections, ['Omitted optional null field children[0].dependsOn.']);
});
