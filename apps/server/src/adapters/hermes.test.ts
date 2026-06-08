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
  assert.ok(portainerCommand.includes('--max-turns=7'));

  const sshCommand = buildHermesSshRemoteCommand(agent, task);
  assert.equal(sshCommand.includes('reasoning-effort'), false);
  assert.match(sshCommand, /'--max-turns' '7'/);
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
