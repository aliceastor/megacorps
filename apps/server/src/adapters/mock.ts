import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { estimateCost, estimateTokens } from './hermes.ts';

export async function dispatchToMock(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const output = [
    `Mock agent ${agent.hermesProfile ?? 'local-debug'} completed card ${task.id}.`,
    `Title: ${task.title}`,
    task.body,
  ].join('\n');
  const tokensUsed = estimateTokens(output);
  return {
    success: true,
    output,
    sessionId: `mock-${crypto.randomUUID()}`,
    tokensUsed,
    costUsd: estimateCost(tokensUsed),
    durationSeconds: 1,
  };
}
