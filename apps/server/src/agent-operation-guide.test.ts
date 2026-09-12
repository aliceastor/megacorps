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

test('management guide teaches schema-valid children and preserves assignment authority', () => {
  const guide = agentOperationGuide('management');
  const parsed = agentReportSchema.safeParse(example(guide, 'megacorps-report'));
  assert.equal(parsed.success, true);
  assert.ok(parsed.success && parsed.data.children?.length === 1);
  assert.match(guide, /eligible.*direct report/i);
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
