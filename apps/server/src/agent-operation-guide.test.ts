import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema, chatWorkItemsSchema } from '@megacorps/shared';
import { agentOperationGuide, type AgentOperationSurface } from './agent-operation-guide.ts';

function example(guide: string, marker: string): unknown {
  const startMarker = '```' + marker + '\n';
  const start = guide.indexOf(startMarker);
  const end = start < 0 ? -1 : guide.indexOf('\n```', start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing ${marker} example`);
  return JSON.parse(guide.slice(start + startMarker.length, end));
}

test('each operation guide is bounded and points to the complete public catalog', () => {
  for (const surface of ['chat', 'execution', 'management', 'review'] satisfies AgentOperationSurface[]) {
    const guide = agentOperationGuide(surface);
    assert.ok(guide.length > 200);
    assert.ok(guide.length <= 3_500, `${surface} guide is ${guide.length} characters`);
    assert.match(guide, /GET \/api\/help\?format=markdown/);
    assert.match(guide, /browser session.*not available|session routes.*not available/i);
    assert.match(guide, /permission|authority/i);
  }
});

test('execution guide teaches valid native progress and help reports without claiming HTTP credentials', () => {
  const guide = agentOperationGuide('execution');
  assert.equal(agentReportSchema.safeParse(example(guide, 'megacorps-report')).success, true);
  assert.match(guide, /completed.*progress.*input_required.*failed.*rejected/s);
  assert.match(guide, /request\.kind.*help/i);
  assert.doesNotMatch(guide, /Authorization: Bearer <agent/i);
});

test('owner execution and management guides teach the canonical collaboration request only on owner surfaces', () => {
  for (const surface of ['execution', 'management'] as const) {
    const guide = agentOperationGuide(surface);
    const collaboration = [...guide.matchAll(/```megacorps-report\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]!))
      .find((report) => report.request?.kind === 'collaboration');
    const parsed = agentReportSchema.safeParse(collaboration);
    assert.equal(parsed.success, true, `${surface} collaboration example must match the shared report schema`);
    assert.ok(parsed.success && parsed.data.status === 'input_required');
    assert.deepEqual(parsed.success && parsed.data.request, {
      kind: 'collaboration',
      departmentSlug: 'product',
      question: 'Provide the approved interface wording needed by this card.',
      acceptance: ['Cover every visible error state.', 'Return the approved wording with its source.'],
    });
    assert.match(guide, /original card.*parent/i);
    assert.match(guide, /target department.*Head/i);
    assert.match(guide, /busy.*wait/i);
    assert.match(guide, /original owner.*resume/i);
  }
  for (const surface of ['review', 'chat'] as const) {
    const guide = agentOperationGuide(surface);
    assert.doesNotMatch(guide, /request\.kind.{0,40}collaboration/is);
    assert.doesNotMatch(guide, /departmentSlug/);
  }
});

test('management guide teaches schema-valid children and preserves assignment authority', () => {
  const guide = agentOperationGuide('management');
  const parsed = agentReportSchema.safeParse(example(guide, 'megacorps-report'));
  assert.equal(parsed.success, true);
  assert.ok(parsed.success && !parsed.data.children?.length, 'generic examples must not assign a fictional recipient');
  assert.match(guide, /eligible.*direct report/i);
  assert.match(guide, /children.*title.*body.*assigneeSlug/s);
  assert.doesNotMatch(guide, /qa-lead|department-head/);
});

test('review guide teaches a schema-valid score and verdict without granting approval authority', () => {
  const guide = agentOperationGuide('review');
  const parsed = agentReportSchema.safeParse(example(guide, 'megacorps-report'));
  assert.equal(parsed.success, true);
  assert.ok(parsed.success && parsed.data.score === 8 && parsed.data.verdict === 'approved');
  assert.match(guide, /evidence/i);
  assert.match(guide, /does not.*mark.*Done/i);
});

test('chat guide teaches only schema-valid server-mediated chat actions', () => {
  const guide = agentOperationGuide('chat');
  const parsed = chatWorkItemsSchema.safeParse(example(guide, 'megacorps-chat-actions'));
  assert.equal(parsed.success, true);
  assert.match(guide, /requesting user/i);
  assert.match(guide, /create_card.*update_card.*note/s);
  assert.doesNotMatch(guide, /POST \/api\/cards/);
});

test('every operation guide labels Boss, Department Head, and Staff applicability', () => {
  for (const surface of ['chat', 'execution', 'management', 'review'] satisfies AgentOperationSurface[]) {
    const guide = agentOperationGuide(surface);
    assert.match(guide, /BOSS:/);
    assert.match(guide, /DEPARTMENT HEAD:/);
    assert.match(guide, /STAFF:/);
  }
});

test('Boss guidance reserves ordinary implementation and professional review for the eligible workforce', () => {
  assert.match(agentOperationGuide('execution'), /BOSS: coordination only, never ordinary code\/docs implementation/i);
  assert.match(agentOperationGuide('review'), /BOSS: professional review unavailable/i);
  assert.match(agentOperationGuide('review'), /goal assessment.*separate management/i);
});

test('management and Direct Chat teach the exact bounded merge decision operation', () => {
  for (const surface of ['management', 'chat'] as const) {
    const guide = agentOperationGuide(surface);
    assert.match(guide, /merge_pr/);
    assert.match(guide, /intentId.*UUID/s);
    assert.match(guide, /headSha.*40 lowercase hexadecimal/s);
    assert.match(guide, /reason.*1.*2000/s);
    assert.match(guide, /GET \/api\/cards\/:id\/merge-intents/);
    assert.match(guide, /independent review/i);
    assert.match(guide, /human.*child/i);
    assert.match(guide, /provider execution/i);
    assert.match(guide, /force merge/i);
    assert.match(guide, /BOSS.*company/i);
    assert.match(guide, /DEPARTMENT HEAD.*own.*department/i);
    assert.match(guide, /STAFF.*unavailable/i);
  }
  for (const surface of ['execution', 'review'] as const) {
    assert.doesNotMatch(agentOperationGuide(surface), /"action":"merge_pr"/);
  }
});
