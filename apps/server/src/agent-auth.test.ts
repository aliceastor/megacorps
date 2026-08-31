import assert from 'node:assert/strict';
import test from 'node:test';
import { agentTokenMatches, generateAgentToken, looksLikeAgentToken, previewAgentToken } from './agent-auth.ts';
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
