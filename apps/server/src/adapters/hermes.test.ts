import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentPrompt, buildHermesCliCommand, extractSessionId, estimateTokens } from './hermes.ts';
import { buildHermesSshRemoteCommand } from './hermes-ssh.ts';

test('extracts Hermes session IDs from stdout', () => {
  assert.equal(extractSessionId('ok\nSession: 20260604_120102_abc123\n'), '20260604_120102_abc123');
});

test('estimates token count conservatively', () => {
  assert.equal(estimateTokens('12345678'), 2);
});

test('Hermes CLI commands do not pass unsupported reasoning-effort flag', () => {
  const agent = {
    hermesProfile: 'alice',
    currentSessionId: '20260604_120102_abc123',
    adapterConfig: { maxTurns: 7, reasoningEffort: 'high', hermesCommand: '/opt/hermes/.venv/bin/hermes' },
  };
  const task = { id: 'card-1', title: 'Smoke', body: 'Return OK.' };

  const portainerCommand = buildHermesCliCommand(agent, task);
  assert.equal(portainerCommand.some((item) => item.includes('reasoning-effort')), false);
  assert.equal(portainerCommand.includes('chat'), false);
  assert.equal(portainerCommand.includes('--max-turns=7'), false);
  assert.equal(portainerCommand[0], 'hermes');
  assert.equal(portainerCommand[1], '-z');
  assert.equal(portainerCommand[3], '--profile');
  assert.equal(portainerCommand[4], 'alice');

  const sshCommand = buildHermesSshRemoteCommand(agent, task);
  assert.equal(sshCommand.includes('reasoning-effort'), false);
  assert.equal(sshCommand.includes("'chat'"), false);
  assert.equal(sshCommand.includes("'--max-turns'"), false);
  assert.match(sshCommand, /^'\/opt\/hermes\/\.venv\/bin\/hermes' '-z' '.+' '--profile' 'alice'$/s);
});

test('Hermes SSH command shell-quotes prompt passed through -z', () => {
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

  assert.match(command, /^'hermes' '-z' '.+' '--profile' 'alice'$/s);
  assert.match(command, /Don'\\''t expand \$HOME or `whoami`\./);
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
