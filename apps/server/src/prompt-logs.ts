import { createHash } from 'node:crypto';
import type { AgentLike, TaskContext } from './adapters/hermes.ts';
import { buildAgentPrompt } from './adapters/hermes.ts';
import { codexAppInternals } from './adapters/codex-app.ts';
import { db } from './db/client.ts';
import { promptLogs } from './db/schema.ts';

type PromptLogInput = {
  companyId: string;
  agentId?: string | null;
  cardId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  heartbeatRunId?: string | null;
  taskRunId?: string | null;
  chatSessionId?: string | null;
  source: string;
  adapterType?: string | null;
  title: string;
  prompt: string;
  metadata?: Record<string, unknown>;
};

const jsonSecretPattern = /(["']?(?:api[_-]?key|token|secret|password|bearer[_-]?token|webhook[_-]?shared[_-]?secret|webhook[_-]?secret|codex[_-]?ws[_-]?token)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi;
const headerSecretPattern = /((?:Header:\s*)?(?:X-MegaCorps-Webhook-Secret|Authorization)\s*:\s*)([^\r\n]+)/gi;
const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const secretKeyPattern = /(?:api[_-]?key|token|secret|password|bearer[_-]?token|webhook[_-]?shared[_-]?secret|webhook[_-]?secret|codex[_-]?ws[_-]?token)/i;

export function redactPromptForLog(prompt: string): string {
  return prompt
    .replace(jsonSecretPattern, '$1[redacted]$3')
    .replace(headerSecretPattern, '$1[redacted]')
    .replace(bearerPattern, '$1[redacted]');
}

function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function redactedJson(value: unknown): string {
  return JSON.stringify(value, (key, nested) => secretKeyPattern.test(key) ? '[redacted]' : nested, 2);
}

export function promptSnapshotForAdapter(agent: AgentLike, task: TaskContext): string {
  if (agent.adapterType === 'codex-app') return codexAppInternals.buildCodexPrompt(agent, task);
  if (agent.adapterType === 'hermes-ssh' || agent.adapterType === 'hermes-gateway') return buildAgentPrompt(agent, task);
  return redactedJson({ agent, task });
}

export async function recordPromptLog(input: PromptLogInput) {
  const prompt = redactPromptForLog(input.prompt);
  await db.insert(promptLogs).values({
    companyId: input.companyId,
    agentId: input.agentId ?? null,
    cardId: input.cardId ?? null,
    projectId: input.projectId ?? null,
    goalId: input.goalId ?? null,
    heartbeatRunId: input.heartbeatRunId ?? null,
    taskRunId: input.taskRunId ?? null,
    chatSessionId: input.chatSessionId ?? null,
    source: input.source,
    adapterType: input.adapterType ?? 'unknown',
    title: input.title,
    prompt,
    promptHash: promptHash(prompt),
    metadata: input.metadata ?? {},
  });
}
