import { getAdapterStringConfig } from './config.ts';

export type ExecResult = { stdout: string; stderr: string; exitCode: number; duration: number };
export type TaskContext = { id: string; title: string; body: string; timeoutSeconds?: number; kind?: 'task' | 'chat'; taskRunId?: string | null };
export type TaskResult = { success: boolean; output: string; sessionId: string; turnId?: string | null; tokensUsed: number; costUsd: number; durationSeconds: number };
export type AgentLike = {
  id?: string;
  name?: string;
  role?: string;
  title?: string | null;
  soul?: string | null;
  adapterType?: string | null;
  runtimeId?: string | null;
  hermesProfile: string | null;
  currentSessionId: string | null;
  adapterConfig?: Record<string, unknown> | null;
};

async function portainerFetch(agent: AgentLike | null, path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const base = getAdapterStringConfig(agent ?? { hermesProfile: null, currentSessionId: null }, 'portainerUrl', 'PORTAINER_URL');
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function portainerLogin(agent: AgentLike | null, retries = 3): Promise<string> {
  let lastError = 'unknown';
  const configAgent = agent ?? { hermesProfile: null, currentSessionId: null };
  for (let i = 0; i < retries; i += 1) {
    const response = await portainerFetch(agent, '/api/auth', {
      method: 'POST',
      body: JSON.stringify({
        username: getAdapterStringConfig(configAgent, 'portainerUser', 'PORTAINER_USER'),
        password: getAdapterStringConfig(configAgent, 'portainerPass', 'PORTAINER_PASS'),
      }),
    });
    if (response.ok) {
      const data = await response.json() as { jwt?: string };
      if (data.jwt) return data.jwt;
    }
    lastError = `${response.status} ${await response.text()}`;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Portainer auth failed: ${lastError}`);
}

function decodeDockerMultiplexed(buffer: ArrayBuffer): { stdout: string; stderr: string } {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  let stdout = '';
  let stderr = '';
  const decoder = new TextDecoder();
  while (offset + 8 <= bytes.length) {
    const stream = bytes[offset];
    const length = ((bytes[offset + 4] ?? 0) << 24) | ((bytes[offset + 5] ?? 0) << 16) | ((bytes[offset + 6] ?? 0) << 8) | (bytes[offset + 7] ?? 0);
    const chunk = decoder.decode(bytes.slice(offset + 8, offset + 8 + length));
    if (stream === 1) stdout += chunk; else stderr += chunk;
    offset += 8 + length;
  }
  if (offset < bytes.length && stdout === '' && stderr === '') stdout = decoder.decode(bytes);
  return { stdout, stderr };
}

export async function portainerExec(agent: AgentLike, cmd: string[], timeoutSec = 300): Promise<ExecResult> {
  const started = Date.now();
  const token = await portainerLogin(agent);
  const endpoint = getAdapterStringConfig(agent, 'portainerEndpointId', 'PORTAINER_ENDPOINT_ID', '4');
  const containerName = getAdapterStringConfig(agent, 'hermesContainer', 'HERMES_CONTAINER', 'hermes-suite');
  const containersResponse = await portainerFetch(agent, `/api/endpoints/${endpoint}/docker/containers/json`, { method: 'GET' }, token);
  if (!containersResponse.ok) throw new Error(`Portainer container query failed: ${containersResponse.status}`);
  const containers = await containersResponse.json() as Array<{ Id: string; Names: string[]; State: string }>;
  const container = containers.find((item) => item.Names.some((name) => name.replace(/^\//, '') === containerName) && item.State === 'running');
  if (!container) throw new Error('Hermes container not found or not running');
  const create = await portainerFetch(agent, `/api/endpoints/${endpoint}/docker/containers/${container.Id}/exec`, { method: 'POST', body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd }) }, token);
  if (!create.ok) throw new Error(`Portainer exec create failed: ${create.status}`);
  const { Id } = await create.json() as { Id: string };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const start = await portainerFetch(agent, `/api/endpoints/${endpoint}/docker/exec/${Id}/start`, { method: 'POST', body: JSON.stringify({ Detach: false, Tty: false }), signal: controller.signal }, token);
    const raw = await start.arrayBuffer();
    const parsed = decodeDockerMultiplexed(raw);
    return { ...parsed, exitCode: start.ok ? 0 : start.status, duration: Math.round((Date.now() - started) / 1000) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Task timed out after ${timeoutSec}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function extractSessionId(stdout: string): string {
  const match = stdout.match(/Session:\s*(\d{8}_\d{6}_[a-zA-Z0-9_-]+)/);
  return match?.[1] ?? crypto.randomUUID();
}

export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
export function estimateCost(tokens: number): number { return Number(((tokens / 1_000_000) * 3).toFixed(6)); }

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function megacorpsApiUrl(agent: AgentLike): string {
  return configuredString(agent.adapterConfig?.megacorpsApiUrl)
    ?? configuredString(agent.adapterConfig?.callbackUrl)
    ?? configuredString(agent.adapterConfig?.webhookBaseUrl)
    ?? configuredString(agent.adapterConfig?.publicApiUrl)
    ?? configuredString(process.env.MEGACORPS_API_URL)
    ?? configuredString(process.env.MEGACORPS_PUBLIC_URL)
    ?? 'http://localhost:4000';
}

function webhookSharedSecret(agent: AgentLike): string | undefined {
  return configuredString(agent.adapterConfig?.webhookSharedSecret)
    ?? configuredString(agent.adapterConfig?.webhookSecret)
    ?? configuredString(process.env.WEBHOOK_SHARED_SECRET);
}

export function buildAgentPrompt(agent: AgentLike, task: TaskContext): string {
  if (task.kind === 'chat') {
    return `You are in a direct MegaCorps chat session.

=== Your Identity ===
Agent: ${agent.hermesProfile ?? 'unknown'}
Session: ${agent.currentSessionId ?? 'new'}

=== Conversation ===
${task.body}

Respond to the user directly. Do not report task completion or call the Kanban webhook unless the user explicitly asks you to create or update MegaCorps work items.`;
  }

  const apiUrl = megacorpsApiUrl(agent);
  const taskWebhookSecret = webhookSharedSecret(agent);
  const webhookBodyExample = task.taskRunId
    ? `{ "cardId": "${task.id}", "taskRunId": "${task.taskRunId}", "status": "done", "summary": "...", "output": "..." }`
    : `{ "cardId": "${task.id}", "status": "done", "summary": "...", "output": "..." }`;
  const escalationBodyExample = task.taskRunId
    ? `{ "cardId": "${task.id}", "taskRunId": "${task.taskRunId}", "status": "needs_review", "summary": "needs reviewer guidance: ...", "output": "Attempted methods:\\n- ...\\n\\nBlocker/root cause:\\n...\\n\\nReviewer questions:\\n- ...\\n\\nPartial output/logs:\\n..." }`
    : `{ "cardId": "${task.id}", "status": "needs_review", "summary": "needs reviewer guidance: ...", "output": "Attempted methods:\\n- ...\\n\\nBlocker/root cause:\\n...\\n\\nReviewer questions:\\n- ...\\n\\nPartial output/logs:\\n..." }`;
  return `You are now working under PLATFORM MegaCorps at ${apiUrl}.

=== Common API Endpoints ===
- POST ${apiUrl}/api/webhook/task-complete -- Report task progress, delegation, or completion
- GET  ${apiUrl}/api/help -- Read API documentation if network access is available

Task runtimes usually do not have a browser session cookie. Do not call session-auth endpoints such as POST /api/cards for delegation. If the MegaCorps task prompt asks you to delegate, include the exact DELEGATE block in your output or webhook payload; the MegaCorps server will create child cards and assign direct reports.

=== Your Identity ===
Agent: ${agent.hermesProfile ?? 'unknown'}
Card ID: ${task.id}
Task Run ID: ${task.taskRunId ?? 'none'}
Card Title: ${task.title}

=== Task ===
${task.body}

=== Instructions ===
When you complete this task, POST your results to:
POST ${apiUrl}/api/webhook/task-complete
${taskWebhookSecret ? `Header: X-MegaCorps-Webhook-Secret: ${taskWebhookSecret}` : 'Webhook auth: no shared secret was provided in your runtime config.'}
Body: ${webhookBodyExample}

If you are delegating to direct reports, POST status "in_progress" and include a DELEGATE block in summary/output. Do not mark the parent card done and do not try to create child cards yourself.
If the work is complete but needs QA, POST status "in_review" with the completed output.
If you cannot solve the task, do not mark it done. POST status "needs_review" with attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs:
Body: ${escalationBodyExample}
Use status "blocked" only for a hard stop that needs human intervention and cannot be usefully reviewed by another agent.

For full API documentation, fetch: GET ${apiUrl}/api/help
`;
}

export function buildHermesCliCommand(agent: AgentLike, task: TaskContext): string[] {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  const prompt = buildAgentPrompt(agent, task);
  return ['hermes', '-z', prompt, '--profile', agent.hermesProfile];
}

export async function dispatchToHermes(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  const cmd = buildHermesCliCommand(agent, task);
  const result = await portainerExec(agent, cmd, task.timeoutSeconds ?? 300);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const tokensUsed = estimateTokens(output);
  return { success: result.exitCode === 0, output, sessionId: extractSessionId(output), tokensUsed, costUsd: estimateCost(tokensUsed), durationSeconds: result.duration };
}
