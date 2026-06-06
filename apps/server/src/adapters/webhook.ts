import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { estimateCost, estimateTokens } from './hermes.ts';
import { assertAdapterTargetAllowed, getAdapterOptionalStringConfig } from './config.ts';

function getWebhookUrl(agent: AgentLike, adapterType: 'webhook' | 'openclaw'): string {
  const configured = adapterType === 'openclaw' ? (agent.adapterConfig?.openclawUrl ?? agent.adapterConfig?.webhookUrl) : agent.adapterConfig?.webhookUrl;
  const envName = adapterType === 'openclaw' ? 'OPENCLAW_WEBHOOK_URL' : 'WEBHOOK_ADAPTER_URL';
  if (typeof configured === 'string' && configured.length > 0) return assertAdapterTargetAllowed(configured, envName);
  const value = getAdapterOptionalStringConfig(agent, envName === 'OPENCLAW_WEBHOOK_URL' ? 'openclawUrl' : 'webhookUrl', envName);
  if (!value) throw new Error(`${envName} is required`);
  return assertAdapterTargetAllowed(value, envName);
}

export async function dispatchToWebhook(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  const started = Date.now();
  const response = await fetch(getWebhookUrl(agent, 'webhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, task }),
  });
  const output = await response.text();
  if (!response.ok) throw new Error(`Webhook dispatch failed: ${response.status} ${output}`);
  const tokensUsed = estimateTokens(output);
  return { success: true, output, sessionId: crypto.randomUUID(), tokensUsed, costUsd: estimateCost(tokensUsed), durationSeconds: Math.round((Date.now() - started) / 1000) };
}

export async function dispatchToOpenClaw(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  const started = Date.now();
  const response = await fetch(getWebhookUrl(agent, 'openclaw'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, task }),
  });
  const output = await response.text();
  if (!response.ok) throw new Error(`OpenClaw dispatch failed: ${response.status} ${output}`);
  const tokensUsed = estimateTokens(output);
  return { success: true, output, sessionId: crypto.randomUUID(), tokensUsed, costUsd: estimateCost(tokensUsed), durationSeconds: Math.round((Date.now() - started) / 1000) };
}
