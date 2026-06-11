import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { estimateCost, estimateTokens } from './hermes.ts';
import { assertAdapterTargetAllowed, getAdapterOptionalStringConfig } from './config.ts';

const SENSITIVE_CONFIG_KEY = /(password|pass|token|secret|jwt|apiKey|privateKey|keyPath)/i;
const DEFAULT_WEBHOOK_TIMEOUT_SECONDS = 300;

function getWebhookUrl(agent: AgentLike, adapterType: 'webhook' | 'openclaw'): string {
  const configured = adapterType === 'openclaw' ? (agent.adapterConfig?.openclawUrl ?? agent.adapterConfig?.webhookUrl) : agent.adapterConfig?.webhookUrl;
  const envName = adapterType === 'openclaw' ? 'OPENCLAW_WEBHOOK_URL' : 'WEBHOOK_ADAPTER_URL';
  if (typeof configured === 'string' && configured.length > 0) return assertAdapterTargetAllowed(configured, envName);
  const value = getAdapterOptionalStringConfig(agent, envName === 'OPENCLAW_WEBHOOK_URL' ? 'openclawUrl' : 'webhookUrl', envName);
  if (!value) throw new Error(`${envName} is required`);
  return assertAdapterTargetAllowed(value, envName);
}

function sanitizedAgentPayload(agent: AgentLike): AgentLike {
  const config = agent.adapterConfig && typeof agent.adapterConfig === 'object' && !Array.isArray(agent.adapterConfig)
    ? Object.fromEntries(Object.entries(agent.adapterConfig).filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key)))
    : agent.adapterConfig;
  return { ...agent, adapterConfig: config ?? null };
}

function webhookTimeoutMs(task: TaskContext): number {
  return (task.timeoutSeconds && task.timeoutSeconds > 0 ? task.timeoutSeconds : DEFAULT_WEBHOOK_TIMEOUT_SECONDS) * 1000;
}

async function dispatchToUrl(agent: AgentLike, task: TaskContext, adapterType: 'webhook' | 'openclaw'): Promise<TaskResult> {
  const started = Date.now();
  const label = adapterType === 'openclaw' ? 'OpenClaw' : 'Webhook';
  let response: Response;
  try {
    response = await fetch(getWebhookUrl(agent, adapterType), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: sanitizedAgentPayload(agent), task }),
      signal: AbortSignal.timeout(webhookTimeoutMs(task)),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`${label} dispatch timed out after ${Math.round(webhookTimeoutMs(task) / 1000)}s`);
    }
    throw error;
  }
  const output = await response.text();
  if (!response.ok) throw new Error(`${label} dispatch failed: ${response.status} ${output}`);
  const tokensUsed = estimateTokens(output);
  return { success: true, output, sessionId: crypto.randomUUID(), tokensUsed, costUsd: estimateCost(tokensUsed), durationSeconds: Math.round((Date.now() - started) / 1000) };
}

export async function dispatchToWebhook(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  return dispatchToUrl(agent, task, 'webhook');
}

export async function dispatchToOpenClaw(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  return dispatchToUrl(agent, task, 'openclaw');
}
