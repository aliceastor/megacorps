import assert from 'node:assert/strict';
import test from 'node:test';
import { agentTokenMatches, decideGiteaProvisionAuth, generateAgentToken, looksLikeAgentToken, previewAgentToken } from './agent-auth.ts';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { redactPromptForLog } from './prompt-logs.ts';

test('agent tokens have a stable recognizable shape', () => {
  const token = generateAgentToken();
  assert.ok(looksLikeAgentToken(token));
  assert.ok(token.length > 40);
  assert.notEqual(token, generateAgentToken());
  assert.equal(looksLikeAgentToken('mca_not_an_agent_token'), false);
  assert.equal(looksLikeAgentToken(undefined), false);
});

test('previewAgentToken never reveals the middle of the token', () => {
  const token = generateAgentToken();
  const preview = previewAgentToken(token);
  assert.ok(preview);
  assert.ok(preview.length < 20);
  assert.equal(previewAgentToken(null), null);
});

test('agentTokenMatches is exact', () => {
  const token = generateAgentToken();
  assert.equal(agentTokenMatches(token, token), true);
  assert.equal(agentTokenMatches(token, `${token}x`), false);
  assert.equal(agentTokenMatches(token, null), false);
});

const baseAgent = { hermesProfile: 'alice', currentSessionId: null, adapterConfig: { webhookSharedSecret: 'legacy-shared-secret-123' } };
const task = { id: 'card-1', title: 'Do the thing', body: 'Body.' };

test('task prompts prefer the per-agent token over the shared secret', () => {
  const prompt = buildAgentPrompt({ ...baseAgent, apiToken: 'mcagt_test_token_abc' }, task);
  assert.match(prompt, /Header: Authorization: Bearer mcagt_test_token_abc/);
  assert.doesNotMatch(prompt, /X-MegaCorps-Webhook-Secret/);
});

test('task prompts fall back to the shared secret without a token', () => {
  const prompt = buildAgentPrompt({ ...baseAgent, apiToken: null }, task);
  assert.match(prompt, /Header: X-MegaCorps-Webhook-Secret: legacy-shared-secret-123/);
});

test('prompt logs redact the injected agent token', () => {
  const prompt = buildAgentPrompt({ ...baseAgent, apiToken: 'mcagt_test_token_abc' }, task);
  const redacted = redactPromptForLog(prompt);
  assert.doesNotMatch(redacted, /mcagt_test_token_abc/);
  assert.match(redacted, /Authorization\s*:\s*\[redacted\]/i);
});

test('per-agent tokens may provision only their own Gitea identity', () => {
  const self = '11111111-1111-1111-1111-111111111111';
  const other = '22222222-2222-2222-2222-222222222222';
  assert.deepEqual(decideGiteaProvisionAuth(self, null, null), { mode: 'operator' });
  assert.deepEqual(decideGiteaProvisionAuth(self, 'mca_operator_token', null), { mode: 'operator' });
  assert.deepEqual(decideGiteaProvisionAuth(self, 'mcagt_deadbeef', null), { error: 'agent_token_invalid', status: 401 });
  assert.deepEqual(decideGiteaProvisionAuth(self, 'mcagt_deadbeef', other), { error: 'agent_token_forbidden', status: 403 });
  assert.deepEqual(decideGiteaProvisionAuth(self, 'mcagt_deadbeef', self), { mode: 'agent', agentId: self });
});
