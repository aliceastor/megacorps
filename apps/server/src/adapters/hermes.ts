export type ExecResult = { stdout: string; stderr: string; exitCode: number; duration: number };
export type TaskContext = { id: string; title: string; body: string; timeoutSeconds?: number };
export type TaskResult = { success: boolean; output: string; sessionId: string; tokensUsed: number; costUsd: number; durationSeconds: number };
export type AgentLike = { hermesProfile: string | null; currentSessionId: string | null; adapterConfig?: Record<string, unknown> | null };

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function portainerFetch(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const base = getEnv('PORTAINER_URL', 'https://192.168.1.180:31015');
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

export async function portainerLogin(retries = 3): Promise<string> {
  let lastError = 'unknown';
  for (let i = 0; i < retries; i += 1) {
    const response = await portainerFetch('/api/auth', { method: 'POST', body: JSON.stringify({ username: getEnv('PORTAINER_USER'), password: getEnv('PORTAINER_PASS') }) });
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

export async function portainerExec(cmd: string[], timeoutSec = 300): Promise<ExecResult> {
  const started = Date.now();
  const token = await portainerLogin();
  const endpoint = getEnv('PORTAINER_ENDPOINT_ID', '4');
  const containerName = getEnv('HERMES_CONTAINER', 'hermes-suite');
  const containersResponse = await portainerFetch(`/api/endpoints/${endpoint}/docker/containers/json`, { method: 'GET' }, token);
  if (!containersResponse.ok) throw new Error(`Portainer container query failed: ${containersResponse.status}`);
  const containers = await containersResponse.json() as Array<{ Id: string; Names: string[]; State: string }>;
  const container = containers.find((item) => item.Names.some((name) => name.replace(/^\//, '') === containerName) && item.State === 'running');
  if (!container) throw new Error('Hermes container not found or not running');
  const create = await portainerFetch(`/api/endpoints/${endpoint}/docker/containers/${container.Id}/exec`, { method: 'POST', body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd }) }, token);
  if (!create.ok) throw new Error(`Portainer exec create failed: ${create.status}`);
  const { Id } = await create.json() as { Id: string };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const start = await portainerFetch(`/api/endpoints/${endpoint}/docker/exec/${Id}/start`, { method: 'POST', body: JSON.stringify({ Detach: false, Tty: false }), signal: controller.signal }, token);
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

export async function dispatchToHermes(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  const prompt = `MegaCorps task ${task.id}
Title: ${task.title}

${task.body}`;
  const cmd = ['hermes', 'chat', '-q', `--profile=${agent.hermesProfile}`, ...(agent.currentSessionId ? ['--resume', agent.currentSessionId] : []), '--max-turns=60', '--reasoning-effort=medium', prompt];
  const result = await portainerExec(cmd, task.timeoutSeconds ?? 300);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const tokensUsed = estimateTokens(output);
  return { success: result.exitCode === 0, output, sessionId: extractSessionId(output), tokensUsed, costUsd: estimateCost(tokensUsed), durationSeconds: result.duration };
}
