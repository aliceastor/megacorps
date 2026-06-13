import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentPrompt, buildHermesCliCommand, extractSessionId, hermesTaskResult, estimateTokens, stripHermesSessionMetadata } from './hermes.ts';
import { buildHermesSshRemoteCommand, resolveHermesSshConnectionConfig } from './hermes-ssh.ts';

test('extracts Hermes session IDs from stdout', () => {
  assert.equal(extractSessionId('ok\nSession: 20260604_120102_abc123\n'), '20260604_120102_abc123');
  assert.equal(extractSessionId('ok\nsession_id: 20260610_151720_016837\n'), '20260610_151720_016837');
});

test('estimates token count conservatively', () => {
  assert.equal(estimateTokens('12345678'), 2);
});

test('Hermes CLI commands use scoped chat query mode', () => {
  const agent = {
    hermesProfile: 'alice',
    currentSessionId: '20260604_120102_abc123',
    adapterConfig: { maxTurns: 7, reasoningEffort: 'high', hermesCommand: '/opt/hermes/.venv/bin/hermes' },
  };
  const task = { id: 'card-1', title: 'Smoke', body: 'Return OK.' };

  const command = buildHermesCliCommand(agent, task);
  assert.equal(command.some((item) => item.includes('reasoning-effort')), false);
  assert.equal(command.includes('-z'), false);
  assert.equal(command.includes('--max-turns=7'), false);
  assert.equal(command[0], 'hermes');
  assert.equal(command[1], '--profile');
  assert.equal(command[2], 'alice');
  assert.equal(command[3], '--resume');
  assert.equal(command[4], '20260604_120102_abc123');
  assert.equal(command[5], 'chat');
  assert.equal(command[6], '-q');
  assert.equal(command.includes('-Q'), true);
  assert.equal(command.includes('--source'), true);
  assert.equal(command.at(-1), 'megacorps-kanban');

  const sshCommand = buildHermesSshRemoteCommand(agent, task);
  assert.equal(sshCommand.includes('reasoning-effort'), false);
  assert.equal(sshCommand.includes("'-z'"), false);
  assert.equal(sshCommand.includes("'--max-turns'"), false);
  assert.match(sshCommand, /^'bash' '-lc' /);
  assert.match(sshCommand, /\/proc\/1\/environ/);
  assert.match(sshCommand, /exec "\$@"/);
  assert.match(sshCommand, /'megacorps-hermes' '\/opt\/hermes\/\.venv\/bin\/hermes' '--profile' 'alice' '--resume' '20260604_120102_abc123' 'chat' '-q' '.+' '-Q' '--source' 'megacorps-kanban'$/s);
});

test('Hermes CLI commands do not resume generated fallback UUIDs', () => {
  const agent = {
    hermesProfile: 'alice',
    currentSessionId: '786f32cd-a377-488e-921b-28d069b29d3f',
    adapterConfig: { hermesCommand: 'hermes' },
  };
  const task = { id: 'card-1', title: 'Smoke', body: 'Return OK.' };

  const command = buildHermesCliCommand(agent, task);
  assert.equal(command.includes('--resume'), false);

  const sshCommand = buildHermesSshRemoteCommand(agent, task);
  assert.equal(sshCommand.includes("'--resume'"), false);
});

test('Hermes CLI commands pass model and provider overrides', () => {
  const command = buildHermesCliCommand({
    hermesProfile: 'alice',
    currentSessionId: '20260604_120102_abc123',
    adapterConfig: {
      model: 'minimax/MiniMax-M3',
      provider: 'openrouter',
    },
  }, { id: 'chat-1', title: 'Direct chat', body: 'Return OK.', kind: 'chat' }, '/opt/hermes/.venv/bin/hermes');

  assert.equal(command[0], '/opt/hermes/.venv/bin/hermes');
  assert.ok(command.includes('--model'));
  assert.ok(command.includes('minimax/MiniMax-M3'));
  assert.ok(command.includes('--provider'));
  assert.ok(command.includes('openrouter'));
  assert.ok(command.includes('--resume'));
  assert.ok(command.includes('chat'));
  assert.equal(command.at(-1), 'megacorps-direct-chat');
});

test('Hermes SSH accepts legacy runtime config aliases', () => {
  const config = resolveHermesSshConnectionConfig({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      host: 'hermes-suite',
      port: '2222',
      username: 'hermes',
      keyPath: '/home/megacorps/.ssh/id_ed25519',
    },
  });

  assert.equal(config.host, 'hermes-suite');
  assert.equal(config.port, 2222);
  assert.equal(config.user, 'hermes');
  assert.equal(config.keyPath, '/home/megacorps/.ssh/id_ed25519');

  const command = buildHermesSshRemoteCommand({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: { command: '/opt/hermes/.venv/bin/hermes' },
  }, { id: 'chat-1', title: 'Direct chat', body: 'Return OK.', kind: 'chat' });
  assert.match(command, /'megacorps-hermes' '\/opt\/hermes\/\.venv\/bin\/hermes' '--profile' 'alice' 'chat' '-q' /);
  assert.match(command, /'--source' 'megacorps-direct-chat'$/);
});

test('Hermes SSH prefers explicit username aliases over legacy sshUser', () => {
  const config = resolveHermesSshConnectionConfig({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      sshHost: '192.168.1.180',
      sshPort: 2222,
      sshUser: 'root',
      sshUsername: 'hermes',
      username: 'hermes',
    },
  });

  assert.equal(config.host, '192.168.1.180');
  assert.equal(config.port, 2222);
  assert.equal(config.user, 'hermes');
});

test('Hermes SSH command shell-quotes prompt passed through chat query mode', () => {
  const command = buildHermesSshRemoteCommand({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: { hermesCommand: 'hermes' },
  }, {
    id: 'chat-1',
    title: 'Direct chat',
    body: "Don't expand $HOME or `whoami`.",
    kind: 'chat',
  });

  assert.match(command, /^'bash' '-lc' /);
  assert.match(command, /\/proc\/1\/environ/);
  assert.match(command, /exec "\$@"/);
  assert.match(command, /'megacorps-hermes' 'hermes' '--profile' 'alice' 'chat' '-q' '.+' '-Q' '--source' 'megacorps-direct-chat'$/s);
  assert.match(command, /Don'\\''t expand \$HOME or `whoami`\./);
});

test('Hermes task results parse session metadata without leaking it into output', () => {
  const result = hermesTaskResult({
    hermesProfile: 'alice',
    currentSessionId: null,
  }, {
    stdout: 'MC_OK\n',
    stderr: 'session_id: 20260610_151720_016837\n',
    exitCode: 0,
    duration: 2,
  });

  assert.equal(result.success, true);
  assert.equal(result.sessionId, '20260610_151720_016837');
  assert.equal(result.output, 'MC_OK');
  assert.equal(stripHermesSessionMetadata('hello\nSession: 20260604_120102_abc123\n'), 'hello');
});

test('Hermes task results fail safely when a new session is not returned', () => {
  const result = hermesTaskResult({
    hermesProfile: 'alice',
    currentSessionId: null,
  }, {
    stdout: 'MC_OK\n',
    stderr: '',
    exitCode: 0,
    duration: 2,
  });

  assert.equal(result.success, false);
  assert.match(result.output, /did not return a session_id/);
});

test('agent prompts prefer megacorpsApiUrl while accepting legacy publicApiUrl', () => {
  const prompt = buildAgentPrompt({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      publicApiUrl: 'http://legacy.example:4000',
      megacorpsApiUrl: 'http://megacorps.example:4000',
    },
  }, { id: 'card-1', title: 'Smoke', body: 'Return OK.' });

  assert.match(prompt, /http:\/\/megacorps\.example:4000\/api\/webhook\/task-complete/);
  assert.doesNotMatch(prompt, /legacy\.example/);
});

test('agent prompts include webhook shared secret header when configured', () => {
  const prompt = buildAgentPrompt({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      megacorpsApiUrl: 'http://megacorps.example:4000',
      webhookSharedSecret: 'super-secret-shared-token',
    },
  }, { id: 'card-1', title: 'Smoke', body: 'Return OK.' });

  assert.match(prompt, /Header: X-MegaCorps-Webhook-Secret: super-secret-shared-token/);
});

test('agent prompts include taskRunId for idempotent webhooks', () => {
  const prompt = buildAgentPrompt({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      megacorpsApiUrl: 'http://megacorps.example:4000',
    },
  }, { id: 'card-1', taskRunId: 'run-1', title: 'Smoke', body: 'Return OK.' });

  assert.match(prompt, /Task Run ID: run-1/);
  assert.match(prompt, /"taskRunId": "run-1"/);
});

test('agent prompts tell task runtimes to delegate through webhook output', () => {
  const prompt = buildAgentPrompt({
    hermesProfile: 'alice',
    currentSessionId: null,
    adapterConfig: {
      megacorpsApiUrl: 'http://megacorps.example:4000',
    },
  }, { id: 'card-1', title: 'Brainstorm', body: 'Run a multi-agent brainstorm.' });

  assert.match(prompt, /status "in_progress" and include a DELEGATE block/);
  assert.match(prompt, /Do not call session-auth endpoints such as POST \/api\/cards/);
  assert.doesNotMatch(prompt, /Create a new card/);
});
