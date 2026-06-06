import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { buildAgentPrompt, estimateTokens, estimateCost } from './hermes.ts';
import { assertAdapterTargetAllowed, getAdapterOptionalStringConfig, getAdapterStringConfig } from './config.ts';

async function hermesFetch(agent: AgentLike, path: string, init: RequestInit = {}): Promise<Response> {
  const base = assertAdapterTargetAllowed(getAdapterStringConfig(agent, 'hermesGatewayUrl', 'HERMES_GATEWAY_URL'), 'HERMES_GATEWAY_URL');
  const token = getAdapterOptionalStringConfig(agent, 'hermesDashboardToken', 'HERMES_DASHBOARD_TOKEN');
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function dispatchToHermesGateway(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');

  const started = Date.now();
  const prompt = buildAgentPrompt(agent, task);

  // Step 1: Create Kanban task via HTTP API
  const createResp = await hermesFetch(agent, '/api/plugins/kanban/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `[MegaCorps] ${task.title}`,
      body: prompt,
      assignee: agent.hermesProfile,
      priority: 1,
    }),
  });
  if (!createResp.ok) throw new Error(`Hermes task create failed: ${createResp.status} ${await createResp.text()}`);
  const created = await createResp.json() as { id?: string; task_id?: string };
  const taskId = created.id ?? created.task_id;
  if (!taskId) throw new Error('Hermes task create returned no id');

  // Step 2: Trigger dispatch
  await hermesFetch(agent, '/api/plugins/kanban/dispatch', { method: 'POST' });

  // Step 3: Poll until done/blocked (max timeout)
  const timeoutMs = (task.timeoutSeconds ?? 300) * 1000;
  const pollInterval = 10_000;
  let output = '';
  let status = 'running';

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const statusResp = await hermesFetch(agent, `/api/plugins/kanban/tasks/${taskId}`);
    if (!statusResp.ok) continue;
    const detail = await statusResp.json() as { status?: string; summary?: string; result?: string };
    status = detail.status ?? 'running';
    if (status === 'done' || status === 'blocked') {
      output = detail.summary ?? detail.result ?? '';
      // Try to get worker log for full output
      const logResp = await hermesFetch(agent, `/api/plugins/kanban/tasks/${taskId}/log?tail=50000`);
      if (logResp.ok) {
        const logData = await logResp.json() as { log?: string; content?: string };
        output = logData.log ?? logData.content ?? output;
      }
      break;
    }
  }

  if (status !== 'done' && status !== 'blocked') {
    throw new Error(`Hermes task ${taskId} timed out after ${Math.round((Date.now() - started) / 1000)}s (status: ${status})`);
  }

  const tokensUsed = estimateTokens(output);
  return {
    success: status === 'done',
    output,
    sessionId: taskId,
    tokensUsed,
    costUsd: estimateCost(tokensUsed),
    durationSeconds: Math.round((Date.now() - started) / 1000),
  };
}
