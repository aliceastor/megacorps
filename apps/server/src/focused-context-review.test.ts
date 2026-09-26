import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { agents, cardComments, cardRequiredTools, goals, kanbanCards, projects, workProducts } from './db/schema.ts';
import { db } from './db/client.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { buildCompanyKanbanContext, buildReviewPrompt, buildTaskPrompt } from './dispatch.ts';

function fixture(t: TestContext) {
  const state = memoryDb(t, []);
  const { headId, departmentId } = readyCompany(state, 'company');
  for (const id of ['staff', 'qa-staff']) state.rows(agents).push({
    id, companyId: 'company', name: id, slug: id, bossId: headId,
    departmentId, adapterType: 'webhook', isActive: true,
  });
  const card: any = {
    id: 'focus', companyId: 'company', projectId: 'project', departmentId,
    title: 'Implement the assigned child', body: '## Goal\nBuild the assigned result.\n## Acceptance\nCURRENT_ACCEPTANCE',
    assigneeId: 'staff', reviewerId: headId, columnStatus: 'in_review', parentCardId: 'parent',
    tags: [], dependencyCardIds: [],
  };
  const parent: any = {
    ...card, id: 'parent', parentCardId: null, title: 'Overall report',
    body: '## Goal\nPARENT_GOAL_CONTEXT\n## Constraints\nPARENT_NO_NETWORK_CONSTRAINT\n## Acceptance\nPARENT_REQUIRED_SOURCE_LIMIT',
  };
  state.rows(kanbanCards).push(card, parent);
  state.rows(projects).push({ id: 'project', companyId: 'company', name: 'Target project', repoUrl: 'https://git.example/company/target' });
  return { state, card, parent, headId };
}

test('focused context obeys its total budget while retaining late current acceptance and lookup guidance', async t => {
  const { state, card } = fixture(t);
  card.body = `## Goal\nCurrent goal.\n## Background\n${'Background detail. '.repeat(350)}\n## Acceptance\nLATE_CRITICAL_ACCEPTANCE`;
  card.lastError = 'CURRENT_CRITICAL_BLOCKER';
  for (let index = 0; index < 8; index++) state.rows(goals).push({
    id: `goal-${index}`, companyId: 'company', projectId: 'project', title: `Relevant goal ${index}`, body: 'Scoped goal detail. '.repeat(70),
  });
  for (let index = 0; index < 12; index++) state.rows(workProducts).push({
    id: `product-${index}`, companyId: 'company', projectId: 'project', cardId: card.id,
    type: 'report', title: `Current product ${index}`, url: `https://example.test/product/${index}`, summary: 'Product evidence. '.repeat(40),
  });
  for (let index = 0; index < 5; index++) state.rows(cardComments).push({
    id: `message-${index}`, cardId: card.id, authorType: 'user', action: 'comment',
    body: 'Relevant comment. '.repeat(60), createdAt: new Date(index),
  });
  const prompt = await buildCompanyKanbanContext('company', { focusCardId: card.id, budgetChars: 8000 });
  t.diagnostic(`focused context with 8 goals, 12 products and 5 messages: ${prompt.length} characters`);
  assert.ok(prompt.length <= 8000, `8,000-character budget produced ${prompt.length} characters`);
  assert.match(prompt, /LATE_CRITICAL_ACCEPTANCE/);
  assert.match(prompt, /CURRENT_CRITICAL_BLOCKER/);
  assert.match(prompt, /\/api\/cards\/focus\/context/);
  assert.match(prompt, /authenticated.*(?:session|user)/i);
  assert.match(prompt, /omitted|truncated/i);
});

test('fresh Head and Staff review prompts retain unresolved verifications and escalation before a long summary', async t => {
  const { card, headId } = fixture(t);
  card.reviewFeedback = JSON.stringify({
    kind: 'megacorps-report', status: 'completed', verdict: 'revision_requested',
    summary: 'General review context. '.repeat(150),
    verifications: [{ findingKey: 'device', status: 'still_open', note: 'VERIFICATION_ONLY_CRITICAL_LIMITATION: physical device test unavailable' }],
    escalation: { reason: 'ESCALATION_ONLY_CRITICAL_REASON: required test environment unavailable' },
  });
  for (const reviewerId of [headId, 'qa-staff']) {
    card.reviewerId = reviewerId;
    const prompt = await buildReviewPrompt(card);
    assert.match(prompt, /VERIFICATION_ONLY_CRITICAL_LIMITATION/, `reviewer ${reviewerId} must see the unresolved verification`);
    assert.match(prompt, /still_open/);
    assert.match(prompt, /ESCALATION_ONLY_CRITICAL_REASON/, `reviewer ${reviewerId} must see the unresolved escalation`);
  }
});

test('fresh Staff execution retains bounded ancestor goal constraints and acceptance alongside current assignment', async t => {
  const { card } = fixture(t);
  card.columnStatus = 'todo';
  const prompt = await buildTaskPrompt(card);
  assert.match(prompt, /CURRENT_ACCEPTANCE/);
  assert.match(prompt, /PARENT_GOAL_CONTEXT/);
  assert.match(prompt, /PARENT_NO_NETWORK_CONSTRAINT/);
  assert.match(prompt, /PARENT_REQUIRED_SOURCE_LIMIT/);
  assert.match(prompt, /current assignment has priority/i);
});

test('small focused budgets preserve blocked dependencies required tools and current human instructions ahead of verbose reference data', async t => {
  const { state, card } = fixture(t);
  card.body = `## Goal\nImplement current scope.\n## Background\n${'Verbose background. '.repeat(400)}\n## Acceptance\nCURRENT_ACCEPTANCE`;
  card.reviewFeedback = JSON.stringify({ kind: 'megacorps-report', status: 'completed', verdict: 'revision_requested', summary: 'Historical review context. '.repeat(130) });
  card.executionLog = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Historical execution context. '.repeat(120) });
  card.dependencyCardIds = ['blocked-dependency'];
  state.rows(kanbanCards).push({
    ...card, id: 'blocked-dependency', parentCardId: null, columnStatus: 'blocked', dependencyCardIds: [],
    title: 'REQUIRED_BLOCKED_DEPENDENCY', body: 'Obtain the required source data before implementation.',
    lastError: 'DEPENDENCY_BLOCKER: source data approval is outstanding',
  });
  for (let index = 0; index < 8; index++) state.rows(goals).push({
    id: `goal-${index}`, companyId: 'company', projectId: 'project', title: `Relevant goal ${index}`, body: 'Verbose goal background. '.repeat(70),
  });
  for (let index = 0; index < 5; index++) state.rows(cardComments).push({
    id: `old-${index}`, cardId: card.id, authorType: 'agent', action: 'comment',
    body: 'Earlier agent detail. '.repeat(60), createdAt: new Date(index),
  });
  state.rows(cardComments).push({
    id: 'current-user-instruction', cardId: card.id, authorType: 'user', action: 'comment',
    body: 'LATEST_USER_INSTRUCTION: preserve the customer table unchanged', createdAt: new Date(10_000),
  });
  // Narrow joined-read boundary double: orchestration and budget assembly are real.
  // memoryDb deliberately rejects nonempty joins rather than emulate join semantics.
  const select = db.select.bind(db);
  t.mock.method(db, 'select', (() => ({
    from: (table: unknown) => table === cardRequiredTools
      ? { innerJoin: () => ({ where: async () => [{
        cardTool: { cardId: card.id, toolId: 'required-tool', reason: 'MUST_RUN_CHECK_BEFORE_COMPLETION' },
        tool: { id: 'required-tool', name: 'REQUIRED_DETERMINISTIC_TOOL', version: '1', description: 'Validate the supplied artifact against required source data.' },
      }] }) }
      : select().from(table as any),
  })) as any);
  const prompt = await buildCompanyKanbanContext('company', { focusCardId: card.id, budgetChars: 8000 });
  assert.ok(prompt.length <= 8000, `8,000-character budget produced ${prompt.length} characters`);
  assert.ok(prompt.includes('CURRENT_ACCEPTANCE'), 'retain current acceptance');
  assert.ok(prompt.includes('REQUIRED_BLOCKED_DEPENDENCY'), 'retain the required blocked dependency');
  assert.ok(prompt.includes('blocked'), 'retain the dependency status');
  assert.ok(prompt.includes('REQUIRED_DETERMINISTIC_TOOL'), 'retain the deterministic tool requirement');
  assert.ok(prompt.includes('MUST_RUN_CHECK_BEFORE_COMPLETION'), 'retain why the tool is required');
  assert.ok(prompt.includes('LATEST_USER_INSTRUCTION'), 'retain the latest human constraint');
  assert.ok(prompt.includes('/api/cards/focus/context'), 'retain the full-context pointer');
});
