import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema } from '@megacorps/shared';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { MEMBER_PLAYBOOK } from './role-playbooks.ts';
import { buildReviewPrompt } from './dispatch.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { readyCompany } from './test-support/ready-company.ts';
import { agents, kanbanCards } from './db/schema.ts';

test('member help instruction uses the native schema instead of a board status', () => {
  assert.doesNotMatch(MEMBER_PLAYBOOK, /status\s+"needs_review"/);
  assert.match(MEMBER_PLAYBOOK, /input_required/);
});

for (const mode of ['execution', 'management', 'review', 'recovery'] as const) test(`${mode} runtime prompt exposes only its report operations`, () => {
  const prompt = buildAgentPrompt({ hermesProfile: 'fixture', currentSessionId: null }, { id: 'card', title: 'Assigned task', body: 'Current evidence', reportingMode: mode } as any);
  assert.doesNotMatch(prompt, /Optional webhook body:|legacy DELEGATE block|verifications.*dispositions/);
  if (mode === 'execution') assert.doesNotMatch(prompt, /Ordinary review example|"verdict"|"children"/);
  if (mode === 'management') assert.match(prompt, /"children"/);
  if (mode === 'review') assert.match(prompt, /revision_requested/);
  const examples = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)];
  assert.ok(examples.length > 0);
  for (const [, example] of examples) assert.equal(agentReportSchema.safeParse(JSON.parse(example!)).success, true);
  if (mode === 'recovery') assert.equal(JSON.parse(examples[0]![1]!).status, 'completed', 'a recovery decision must satisfy the stage handler, not just the shared envelope schema');
});

test('informational peer wrapper cannot invite board mutations', () => {
  const prompt = buildAgentPrompt({ hermesProfile: 'fixture', currentSessionId: null }, { id: 'peer-1', title: 'Question', body: 'Answer only', kind: 'chat', informationalOnly: true } as any);
  assert.doesNotMatch(prompt, /megacorps-chat-actions|"create_card"|"update_card"/);
  assert.match(prompt, /informational/);
});

test('review of a parent does not contradict the current child-card workflow', async t => {
  const state = memoryDb(t, []);
  const { headId, departmentId } = readyCompany(state, 'company');
  state.rows(agents).push({ id: 'worker', companyId: 'company', departmentId, bossId: headId, isActive: true });
  const parent: any = { id: 'parent', title: 'Deliver', body: '## Acceptance\nComplete deliverable.', companyId: 'company', columnStatus: 'in_review', assigneeId: 'worker', reviewerId: headId, tags: [] };
  state.rows(kanbanCards).push(parent, { ...parent, id: 'child', parentCardId: 'parent', columnStatus: 'done' });
  const prompt = await buildReviewPrompt(parent);
  assert.doesNotMatch(prompt, /use Message Board delegation records for any future split work/);
  assert.match(prompt, /revision_requested|REVISION_REQUESTED/);
});
