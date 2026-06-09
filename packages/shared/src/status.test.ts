import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionCard, cardStatusSchema, cardStatuses, createAgentRuntimeSchema, createAgentSchema, createCardSchema, createMachineRunnerSchema, createProjectSchema, inferCardTransitionAction, runnerHeartbeatSchema, signupSchema, updateAgentSchema, validateCardTransition } from './index.ts';

test('allows the canonical card status path and blocks invalid skips', () => {
  assert.deepEqual([...cardStatuses], ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'done', 'blocked', 'cancelled']);
  assert.equal(canTransitionCard('todo', 'in_progress'), true);
  assert.equal(canTransitionCard('in_progress', 'done'), true);
  assert.equal(canTransitionCard('in_progress', 'needs_review'), true);
  assert.equal(canTransitionCard('in_progress', 'waiting_on_external'), true);
  assert.equal(canTransitionCard('waiting_on_external', 'in_review'), true);
  assert.equal(canTransitionCard('waiting_on_external', 'in_progress'), true);
  assert.equal(canTransitionCard('needs_review', 'todo'), true);
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

test('agent runtime local roots are runtime-owned paths', () => {
  assert.equal(createAgentRuntimeSchema.safeParse({ name: 'SSH', adapterType: 'hermes-ssh', localWorkspaceRoot: '/home/alice/workspaces', localScratchRoot: '/tmp/megacorps' }).success, true);
  assert.equal(createAgentRuntimeSchema.safeParse({ name: 'Windows', adapterType: 'mock', localWorkspaceRoot: 'C:\\Agents\\Alice\\workspaces', localScratchRoot: null }).success, true);
});

test('machine runner schemas capture runtime capacity and heartbeat state', () => {
  assert.equal(createMachineRunnerSchema.safeParse({ name: 'Build Runner', slug: 'build-runner', supportedRuntimes: ['codex-app', 'mock'], maxConcurrent: 2 }).success, true);
  assert.equal(createMachineRunnerSchema.safeParse({ name: 'Bad Runner', slug: 'Bad Runner' }).success, false);
  assert.equal(runnerHeartbeatSchema.safeParse({ supportedRuntimes: ['mock'], activeSlots: 0, runtimeStatuses: { mock: 'ready' } }).success, true);
  assert.equal(runnerHeartbeatSchema.safeParse({ runtimeStatuses: { mock: 'strange' } }).success, false);
});

test('accepts MVP agent adapter options', () => {
  assert.equal(createAgentSchema.safeParse({ name: 'Alice', slug: 'alice', role: 'worker', adapterType: 'hermes-gateway', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'SSH Alice', slug: 'ssh-alice', role: 'worker', adapterType: 'hermes-ssh', hermesProfile: 'alice' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Codex Alice', slug: 'codex-alice', role: 'worker', adapterType: 'codex-app', soul: 'Careful code reviewer with a concise working style.' }).success, true);
  assert.equal(createAgentSchema.safeParse({ name: 'Local', slug: 'local', role: 'worker', adapterType: 'mock', hermesProfile: 'local-debug' }).success, true);
});

test('agent updates do not inherit create-time adapter defaults', () => {
  assert.deepEqual(updateAgentSchema.parse({ bossId: null }), { bossId: null });
});

test('signup requires a real password length', () => {
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'short' }).success, false);
  assert.equal(signupSchema.safeParse({ email: 'a@example.com', name: 'Alice', password: 'long-enough' }).success, true);
});
