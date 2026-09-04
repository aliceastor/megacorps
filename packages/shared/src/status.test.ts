import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportSchema, canTransitionCard, createKnowledgeDocSchema, partialWithoutDefaults, updateCompanySchema, updateProjectSchema, cardStatusSchema, cardStatuses, createAgentRuntimeSchema, createAgentSchema, createCardSchema, createCompanySchema, createMachineRunnerSchema, createProjectSchema, inferCardTransitionAction, runnerHeartbeatSchema, signupSchema, updateAgentSchema, updateCardSchema, validateCardTransition } from './index.ts';

test('cards, companies and reports carry the blind review panel fields', () => {
  const reviewer = '2d7c0c7e-3f4b-4a55-9a0e-6c8f2e1b5d11';
  const card = createCardSchema.parse({ title: 'Export', body: '## Acceptance\n- [ ] downloads', requiresApproval: true, reviewMode: 'panel', critical: true, reviewerIds: [reviewer] });
  assert.equal(card.reviewMode, 'panel');
  assert.equal(card.critical, true);
  assert.deepEqual(card.reviewerIds, [reviewer]);
  const defaults = createCardSchema.parse({ title: 'Export', body: 'x', requiresApproval: true });
  assert.equal(defaults.reviewMode, 'single');
  assert.equal(defaults.critical, false);
  assert.deepEqual(defaults.reviewerIds, []);
  assert.equal(createCardSchema.safeParse({ title: 'Export', body: 'x', requiresApproval: true, reviewerIds: [reviewer, reviewer, reviewer] }).success, false);
  assert.equal(updateCardSchema.safeParse({ reviewMode: 'panel', reviewerIds: [reviewer] }).success, true);
  assert.equal(updateCardSchema.safeParse({ reviewMode: 'committee' }).success, false);
  assert.equal(createCompanySchema.parse({ name: 'Acme', slug: 'acme', panelReviewDefault: 'always' }).panelReviewDefault, 'always');
  assert.equal(createCompanySchema.safeParse({ name: 'Acme', slug: 'acme', panelReviewDefault: 'sometimes' }).success, false);
  const report = agentReportSchema.parse({
    kind: 'megacorps-report',
    status: 'completed',
    summary: 'reviewed',
    verdict: 'revision_requested',
    score: 4,
    findings: [{ id: 'F1', severity: 'P0', file: 'src/a.ts', line: 3, title: 'Null deref', evidence: 'crash', requiredFix: 'guard', reassign: true }],
    dispositions: [{ findingKey: 'R1-AB1-1', disposition: 'rejected', reason: 'unreachable: validated upstream' }],
    verifications: [{ findingKey: 'R1-AB1-1', status: 'still_open', note: 'still reproduces' }],
    escalation: { reason: 'needs the platform team' },
    children: [{ title: 'Child', body: 'Build the thing end to end.\n\n- [ ] tests green and the page renders the list', assigneeSlug: 'ribel', critical: true }],
  });
  assert.equal(report.findings?.[0]?.severity, 'P0');
  assert.equal(report.children?.[0]?.critical, true);
  assert.equal(agentReportSchema.safeParse({ kind: 'megacorps-report', status: 'completed', summary: 'x', findings: [{ severity: 'P3', title: 't', evidence: 'e', requiredFix: 'f' }] }).success, false);
  assert.equal(agentReportSchema.safeParse({ kind: 'megacorps-report', status: 'completed', summary: 'x', dispositions: [{ findingKey: 'k', disposition: 'ignored' }] }).success, false);
});

test('allows the canonical card status path and blocks invalid skips', () => {
  assert.deepEqual([...cardStatuses], ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'done', 'blocked', 'cancelled']);
  assert.equal(canTransitionCard('todo', 'in_progress'), true);
  // Client checkpoints and brainstorm rounds park the card and hand it back to the owner.
  assert.equal(canTransitionCard('in_progress', 'waiting_on_client'), true);
  assert.equal(canTransitionCard('waiting_on_client', 'in_progress'), true);
  assert.equal(canTransitionCard('in_progress', 'waiting_on_brainstorm'), true);
  assert.equal(canTransitionCard('waiting_on_brainstorm', 'in_progress'), true);
  assert.equal(canTransitionCard('waiting_on_client', 'done'), false);
  assert.equal(inferCardTransitionAction('in_progress', 'waiting_on_client'), 'ask_client');
  assert.equal(inferCardTransitionAction('waiting_on_client', 'in_progress'), 'client_answered');
  assert.equal(inferCardTransitionAction('in_progress', 'waiting_on_brainstorm'), 'open_brainstorm');
  assert.equal(inferCardTransitionAction('waiting_on_brainstorm', 'in_progress'), 'brainstorm_closed');
  assert.equal(canTransitionCard('in_progress', 'done'), true);
  assert.equal(canTransitionCard('in_progress', 'needs_review'), true);
  assert.equal(canTransitionCard('in_progress', 'waiting_on_external'), true);
  assert.equal(canTransitionCard('waiting_on_external', 'in_review'), true);
  assert.equal(canTransitionCard('waiting_on_external', 'in_progress'), true);
  assert.equal(canTransitionCard('needs_review', 'todo'), true);
  assert.equal(canTransitionCard('cancelled', 'done'), true);
  assert.equal(canTransitionCard('todo', 'done'), false);
  assert.equal(canTransitionCard('in_progress', 'cancelled'), true);
});

test('maps legacy backlog input to todo', () => {
  assert.equal(cardStatusSchema.parse('backlog'), 'todo');
});

test('actor-aware card transitions distinguish worker, reviewer, leader, and machine permissions', () => {
  assert.equal(validateCardTransition('claim', 'todo', 'agent:worker'), null);
  assert.equal(validateCardTransition('submit_review', 'in_progress', 'agent:worker'), null);
  assert.equal(validateCardTransition('wait_external', 'in_progress', 'agent:worker'), null);
  assert.equal(validateCardTransition('external_success', 'waiting_on_external', 'agent:reviewer'), null);
  assert.equal(validateCardTransition('external_failure', 'waiting_on_external', 'agent:worker'), null);
  assert.equal(validateCardTransition('approve', 'in_review', 'agent:worker')?.code, 'FORBIDDEN');
  assert.equal(validateCardTransition('approve', 'in_review', 'agent:reviewer'), null);
  assert.equal(validateCardTransition('reject', 'in_review', 'agent:reviewer'), null);
  assert.equal(validateCardTransition('reopen', 'done', 'agent:leader'), null);
  assert.equal(validateCardTransition('complete', 'in_progress', 'machine'), null);
  assert.equal(validateCardTransition('complete', 'cancelled', 'user'), null);
  assert.equal(validateCardTransition('cancel', 'todo', 'agent:worker')?.code, 'FORBIDDEN');
  assert.equal(validateCardTransition('release', 'in_progress', 'machine'), null);
  assert.equal(validateCardTransition('release', 'in_progress', 'agent:worker'), null);
  assert.equal(validateCardTransition('release', 'done', 'machine')?.code, 'INVALID_TRANSITION');
});

test('infers card lifecycle actions from status movement', () => {
  assert.equal(inferCardTransitionAction('todo', 'in_progress'), 'claim');
  assert.equal(inferCardTransitionAction('in_progress', 'in_review'), 'submit_review');
  assert.equal(inferCardTransitionAction('in_progress', 'waiting_on_external'), 'wait_external');
  assert.equal(inferCardTransitionAction('waiting_on_external', 'in_review'), 'external_success');
  assert.equal(inferCardTransitionAction('waiting_on_external', 'in_progress'), 'external_failure');
  assert.equal(inferCardTransitionAction('needs_review', 'done'), 'approve');
  assert.equal(inferCardTransitionAction('cancelled', 'done'), 'complete');
  assert.equal(inferCardTransitionAction('blocked', 'todo'), 'resume');
  assert.equal(inferCardTransitionAction('todo', 'done'), null);
});

test('rejects empty card bodies at schema level', () => {
  const parsed = createCardSchema.safeParse({ title: 'x', body: '' });
  assert.equal(parsed.success, false);
});

test('project workPath must stay relative to the project workspace', () => {
  assert.equal(createProjectSchema.safeParse({ name: 'App', workPath: 'apps/server' }).success, true);
  assert.equal(createProjectSchema.safeParse({ name: 'Root', workPath: null }).success, true);
  assert.equal(createProjectSchema.safeParse({ name: 'Absolute', workPath: '/etc' }).success, false);
  assert.equal(createProjectSchema.safeParse({ name: 'Windows absolute', workPath: 'C:\\temp' }).success, false);
  assert.equal(createProjectSchema.safeParse({ name: 'Traversal', workPath: '../outside' }).success, false);
});

test('createProjectSchema keeps optional companyId so POST can persist a non-default company', () => {
  const companyId = '6c2f0a11-4b8e-4d3a-9f71-2a0c8d5e1b90';
  assert.equal(createProjectSchema.parse({ name: 'App', companyId }).companyId, companyId);
  assert.equal(createProjectSchema.parse({ name: 'App', company_id: companyId }).companyId, companyId);
  assert.equal(createProjectSchema.parse({ name: 'App' }).companyId, undefined);
  assert.equal(createProjectSchema.safeParse({ name: 'App', companyId: 'not-a-uuid' }).success, false);
});

test('agent runtime local roots are runtime-owned paths', () => {
  assert.equal(createAgentRuntimeSchema.safeParse({ name: 'SSH', adapterType: 'hermes-ssh', localWorkspaceRoot: '/home/alice/workspaces', localScratchRoot: '/tmp/megacorps' }).success, true);
  assert.equal(createAgentRuntimeSchema.safeParse({ name: 'Windows', adapterType: 'codex-app', localWorkspaceRoot: 'C:\\Agents\\Alice\\workspaces', localScratchRoot: null }).success, true);
  assert.equal(createAgentRuntimeSchema.safeParse({ name: 'Legacy Mock', adapterType: 'mock' }).success, false);
});

test('machine runner schemas capture runtime capacity and heartbeat state', () => {
  assert.equal(createMachineRunnerSchema.safeParse({ name: 'Build Runner', slug: 'build-runner', supportedRuntimes: ['codex-app', 'hermes-ssh'], maxConcurrent: 2 }).success, true);
  assert.equal(createMachineRunnerSchema.safeParse({ name: 'Bad Runner', slug: 'Bad Runner' }).success, false);
  assert.equal(runnerHeartbeatSchema.safeParse({ supportedRuntimes: ['hermes-ssh'], activeSlots: 0, runtimeStatuses: { 'hermes-ssh': 'ready' } }).success, true);
  assert.equal(runnerHeartbeatSchema.safeParse({ runtimeStatuses: { 'hermes-ssh': 'strange' } }).success, false);
});

test('accepts MVP agent adapter options', () => {
  assert.equal(createAgentSchema.safeParse({ name: 'Alice', slug: 'alice', role: 'worker', adapterType: 'hermes-gateway', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'SSH Alice', slug: 'ssh-alice', role: 'worker', adapterType: 'hermes-ssh', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Codex Alice', slug: 'codex-alice', role: 'worker', adapterType: 'codex-app', soul: 'Careful code reviewer with a concise working style.' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Local', slug: 'local', role: 'worker', adapterType: 'mock', hermesProfile: 'local-debug' }).success, false);
  assert.equal(createAgentSchema.safeParse({ name: 'Legacy Hermes', slug: 'legacy-hermes', role: 'worker', adapterType: 'hermes', hermesProfile: 'alice' }).success, false);
});

test('agent updates do not inherit create-time adapter defaults', () => {
  assert.deepEqual(updateAgentSchema.parse({ bossId: null }), { bossId: null });
});

test('signup requires a real password length', () => {
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'short' }).success, false);
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'long-enough' }).success, true);
});

test('card create and update persist requested decisionMode including legacy delegate', () => {
  assert.equal(createCardSchema.parse({ title: 't', body: 'b', requiresApproval: true, decisionMode: 'delegate' }).decisionMode, 'delegate');
  assert.equal(updateCardSchema.parse({ decisionMode: 'delegate' }).decisionMode, 'delegate');
  assert.equal(updateCardSchema.parse({ title: 'renamed' }).decisionMode, undefined);
  assert.deepEqual(updateCardSchema.parse({ title: 'renamed' }), { title: 'renamed' });
});

test('partial updates leave omitted defaulted fields untouched', () => {
  // A PUT that only renames must not reset priority/tags/requiresApproval/maxRetries.
  assert.deepEqual(updateCardSchema.parse({ title: 'renamed' }), { title: 'renamed' });
  assert.deepEqual(updateProjectSchema.parse({ description: 'x' }), { description: 'x' });
  assert.deepEqual(updateCompanySchema.parse({ mission: 'm' }), { mission: 'm' });
  // Explicit values still validate and defaults still apply on create.
  assert.equal(updateCardSchema.parse({ priority: 'high', tags: ['a'] }).priority, 'high');
  assert.equal(updateCardSchema.safeParse({ priority: 'extreme' }).success, false);
  assert.equal(createCardSchema.parse({ title: 't', body: 'b', requiresApproval: true }).priority, 'normal');
  assert.deepEqual(partialWithoutDefaults(createKnowledgeDocSchema).parse({}), {});
});
