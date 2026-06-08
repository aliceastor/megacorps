import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import WebSocket from 'ws';
import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { buildAgentPrompt, estimateCost, estimateTokens } from './hermes.ts';
import { assertAdapterTargetAllowed, getAdapterNumberConfig, getAdapterOptionalStringConfig } from './config.ts';

type JsonObject = Record<string, unknown>;
type RpcMessage = { id?: number | string; method?: string; params?: JsonObject; result?: unknown; error?: { code?: number; message?: string } };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type RpcConnection = {
  request(method: string, params?: JsonObject): Promise<unknown>;
  notify(method: string, params?: JsonObject): void;
  onNotification(listener: (message: RpcMessage) => void): void;
  close(): void;
};

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function configuredBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function splitArgs(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item) => item.replace(/^["']|["']$/g, '')) ?? [];
}

function createMessageRouter(send: (message: RpcMessage) => void, close: () => void): {
  connection: RpcConnection;
  handleMessage(message: RpcMessage): void;
  failPending(error: Error): void;
} {
  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  const listeners = new Set<(message: RpcMessage) => void>();
  return {
    connection: {
      request(method, params) {
        const id = nextId;
        nextId += 1;
        send({ id, method, params });
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      },
      notify(method, params) {
        send({ method, params });
      },
      onNotification(listener) {
        listeners.add(listener);
      },
      close,
    },
    handleMessage(message) {
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || `Codex app-server JSON-RPC error ${message.error.code ?? ''}`.trim()));
        else request.resolve(message.result);
        return;
      }
      for (const listener of listeners) listener(message);
    },
    failPending(error) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    },
  };
}

function stdioConnection(agent: AgentLike): RpcConnection {
  const command = getAdapterOptionalStringConfig(agent, 'codexCommand', 'CODEX_APP_COMMAND') ?? 'codex';
  const args = splitArgs(getAdapterOptionalStringConfig(agent, 'codexArgs', 'CODEX_APP_ARGS') ?? 'app-server');
  let child: ChildProcessWithoutNullStreams | null = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const router = createMessageRouter(
    (message) => {
      if (!child) throw new Error('Codex app-server stdio connection is closed');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    () => {
      child?.kill('SIGTERM');
      child = null;
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      router.handleMessage(JSON.parse(line) as RpcMessage);
    } catch {
      stderr += `\n[unparsed stdout] ${line}`;
    }
  });
  child.on('error', (error) => router.failPending(new Error(`Codex app-server failed to start ${command}: ${error.message}`)));
  child.on('close', (code) => {
    router.failPending(new Error(`Codex app-server exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.slice(-2000)}` : ''}`));
  });
  return router.connection;
}

async function websocketConnection(agent: AgentLike): Promise<RpcConnection> {
  const rawUrl = getAdapterOptionalStringConfig(agent, 'codexAppServerUrl', 'CODEX_APP_SERVER_URL');
  if (!rawUrl) throw new Error('codexAppServerUrl (CODEX_APP_SERVER_URL) is required for websocket transport');
  const url = assertAdapterTargetAllowed(rawUrl, 'CODEX_APP_SERVER_URL');
  const token = configuredString(agent.adapterConfig?.codexWsToken)
    ?? configuredString(agent.adapterConfig?.codexBearerToken)
    ?? getAdapterOptionalStringConfig(agent, 'codexWsToken', 'CODEX_APP_WS_TOKEN');
  const websocket = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const router = createMessageRouter(
    (message) => websocket.send(JSON.stringify(message)),
    () => websocket.close(),
  );
  websocket.on('message', (data) => {
    try {
      router.handleMessage(JSON.parse(String(data)) as RpcMessage);
    } catch {
      // Ignore malformed frames; app-server protocol frames should be JSON.
    }
  });
  websocket.on('error', (error) => router.failPending(new Error(`Codex app-server websocket error: ${error.message}`)));
  websocket.on('close', (code) => router.failPending(new Error(`Codex app-server websocket closed with code ${code}`)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex app-server websocket connection timed out')), 10_000);
    websocket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    websocket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return router.connection;
}

function codexTransport(agent: AgentLike): 'stdio' | 'websocket' {
  const value = getAdapterOptionalStringConfig(agent, 'codexTransport', 'CODEX_APP_TRANSPORT') ?? 'stdio';
  return value === 'websocket' || value === 'ws' ? 'websocket' : 'stdio';
}

async function createConnection(agent: AgentLike): Promise<RpcConnection> {
  return codexTransport(agent) === 'websocket' ? websocketConnection(agent) : stdioConnection(agent);
}

function codexClientInfo(agent: AgentLike): JsonObject {
  return {
    name: configuredString(agent.adapterConfig?.codexClientName) ?? 'megacorps',
    title: configuredString(agent.adapterConfig?.codexClientTitle) ?? 'MegaCorps',
    version: configuredString(agent.adapterConfig?.codexClientVersion) ?? '0.1.0',
  };
}

function threadStartParams(agent: AgentLike): JsonObject {
  const params: JsonObject = {};
  const model = getAdapterOptionalStringConfig(agent, 'codexModel', 'CODEX_APP_MODEL');
  if (model) params.model = model;
  return params;
}

function codexCwd(agent: AgentLike): string | undefined {
  return configuredString(agent.adapterConfig?.codexCwd)
    ?? configuredString(agent.adapterConfig?.localWorkspaceRoot)
    ?? configuredString(agent.adapterConfig?.localScratchRoot)
    ?? getAdapterOptionalStringConfig(agent, 'codexCwd', 'CODEX_APP_CWD');
}

function turnStartParams(agent: AgentLike, threadId: string, prompt: string): JsonObject {
  const params: JsonObject = {
    threadId,
    input: [{ type: 'text', text: prompt }],
  };
  const model = getAdapterOptionalStringConfig(agent, 'codexModel', 'CODEX_APP_MODEL');
  const cwd = codexCwd(agent);
  const sandbox = getAdapterOptionalStringConfig(agent, 'codexSandbox', 'CODEX_APP_SANDBOX');
  const personality = configuredString(agent.adapterConfig?.codexPersonality);
  if (model) params.model = model;
  if (cwd) params.cwd = cwd;
  if (sandbox) params.sandbox = sandbox;
  if (personality) params.personality = personality;
  return params;
}

function extractNestedId(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as JsonObject;
  const nested = object[key];
  if (nested && typeof nested === 'object' && typeof (nested as JsonObject).id === 'string') return (nested as JsonObject).id as string;
  if (typeof object.id === 'string') return object.id;
  return null;
}

function notificationText(message: RpcMessage): string {
  const params = message.params ?? {};
  if (message.method?.includes('agentMessage/delta')) {
    return configuredString(params.delta)
      ?? configuredString(params.text)
      ?? configuredString((params.message as JsonObject | undefined)?.delta)
      ?? '';
  }
  if (message.method === 'item/completed') {
    const item = params.item as JsonObject | undefined;
    if (!item) return '';
    const text = configuredString(item.text) ?? configuredString(item.output);
    if (text) return `\n${text}`;
    if (Array.isArray(item.content)) {
      const parts = item.content.map((part) => part && typeof part === 'object' ? configuredString((part as JsonObject).text) : '').filter(Boolean);
      return parts.length ? `\n${parts.join('\n')}` : '';
    }
  }
  if (message.method?.includes('approval') || message.method?.includes('permission')) {
    return `\n[${message.method}] ${JSON.stringify(params).slice(0, 2000)}`;
  }
  return '';
}

function isCompletedTurn(message: RpcMessage, turnId: string | null): boolean {
  if (message.method !== 'turn/completed') return false;
  if (!turnId) return true;
  const params = message.params ?? {};
  const turn = params.turn as JsonObject | undefined;
  return configuredString(turn?.id) === turnId || configuredString(params.turnId) === turnId || !turn?.id;
}

function completedStatus(message: RpcMessage): string {
  const params = message.params ?? {};
  const turn = params.turn as JsonObject | undefined;
  return configuredString(turn?.status) ?? configuredString(params.status) ?? 'completed';
}

function waitForCompletedTurn(connection: RpcConnection, turnId: string | null, timeoutSeconds: number, output: string[]): Promise<RpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Codex app-server turn timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
    connection.onNotification((message) => {
      const text = notificationText(message);
      if (text) output.push(text);
      if (!isCompletedTurn(message, turnId)) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function buildCodexPrompt(agent: AgentLike, task: TaskContext): string {
  const fallbackIdentity = [
    `Name: ${agent.name ?? agent.hermesProfile ?? 'unknown'}`,
    `Role: ${agent.role ?? 'agent'}`,
    agent.title ? `Title: ${agent.title}` : '',
  ].filter(Boolean).join('\n');
  const soul = configuredString(agent.soul) ?? fallbackIdentity;
  return [
    'You are running through Codex app-server as a MegaCorps agent. MegaCorps is the source of truth for your identity, task scope, goals, and completion protocol.',
    `=== Agent Soul ===\n${soul}`,
    `=== Adapter Session ===\nCodex thread: ${agent.currentSessionId ?? 'new'}\nSession policy: Direct Chat uses one thread per chat session. Kanban uses one thread per card, agent, and dispatch/review kind. Every retry or continuation is a new turn in that thread.`,
    buildAgentPrompt({ ...agent, hermesProfile: agent.hermesProfile ?? agent.name ?? 'codex-agent' }, task),
  ].join('\n\n');
}

export async function dispatchToCodexApp(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  const started = Date.now();
  const timeoutSeconds = getAdapterNumberConfig(agent, 'codexTimeoutSeconds', 'CODEX_APP_TIMEOUT_SECONDS', task.timeoutSeconds ?? 300);
  const output: string[] = [];
  const connection = await createConnection(agent);
  try {
    const initializeParams: JsonObject = { clientInfo: codexClientInfo(agent) };
    if (configuredBoolean(agent.adapterConfig?.codexExperimentalApi) || configuredBoolean(getAdapterOptionalStringConfig(agent, 'codexExperimentalApi', 'CODEX_APP_EXPERIMENTAL_API'))) {
      initializeParams.capabilities = { experimentalApi: true };
    }
    await connection.request('initialize', initializeParams);
    connection.notify('initialized', {});

    let threadId = agent.currentSessionId ?? null;
    if (threadId) {
      try {
        const resumed = await connection.request('thread/resume', { threadId });
        threadId = extractNestedId(resumed, 'thread') ?? threadId;
      } catch {
        threadId = null;
      }
    }
    if (!threadId) {
      const startedThread = await connection.request('thread/start', threadStartParams(agent));
      threadId = extractNestedId(startedThread, 'thread') ?? crypto.randomUUID();
    }

    const turnStarted = await connection.request('turn/start', turnStartParams(agent, threadId, buildCodexPrompt(agent, task)));
    const turnId = extractNestedId(turnStarted, 'turn');
    const completed = await waitForCompletedTurn(connection, turnId, timeoutSeconds, output);
    const status = completedStatus(completed);
    const text = output.join('').trim() || `[Codex app-server turn completed with status ${status}]`;
    const tokensUsed = estimateTokens(text);
    return {
      success: !/fail|error|cancel|interrupt/i.test(status),
      output: text,
      sessionId: threadId,
      turnId,
      tokensUsed,
      costUsd: estimateCost(tokensUsed),
      durationSeconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    connection.close();
  }
}

export const codexAppInternals = {
  buildCodexPrompt,
  turnStartParams,
  threadStartParams,
};
