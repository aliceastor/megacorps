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

export function isHermesSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{8}_\d{6}_[a-zA-Z0-9_-]+$/.test(value);
}

export function parseHermesSessionId(output: string): string | null {
  const match = output.match(/(?:Session|session_id):\s*(\d{8}_\d{6}_[a-zA-Z0-9_-]+)/i);
  return match?.[1] ?? null;
}

export function extractSessionId(output: string, fallback?: string | null): string {
  return parseHermesSessionId(output) ?? (isHermesSessionId(fallback) ? fallback : crypto.randomUUID());
}

export function stripHermesSessionMetadata(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Session|session_id):\s*\d{8}_\d{6}_[a-zA-Z0-9_-]+\s*$/i.test(line))
    .filter((line) => !/^\s*Resume this session with:/i.test(line))
    .join('\n')
    .trim();
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

Task runtimes usually do not have a browser session cookie. Do not call session-auth endpoints such as POST /api/cards for delegation. If the MegaCorps task prompt asks you to delegate, include the exact DELEGATE block in your output or webhook payload; the MegaCorps server will create Message Board delegation requests inside the same card and assign direct reports.

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

If you are delegating to direct reports, POST status "in_progress" and include a DELEGATE block in summary/output. Do not mark the parent card done and do not try to create Kanban cards yourself; MegaCorps will create same-card Message Board delegation requests.
If the work is complete but needs QA, POST status "in_review" with the completed output.
If you cannot solve the task, do not mark it done. POST status "needs_review" with attempted methods, blocker/root cause, exact reviewer questions, partial output, and logs:
Body: ${escalationBodyExample}
Use status "blocked" only for a hard stop that needs human intervention and cannot be usefully reviewed by another agent.

For full API documentation, fetch: GET ${apiUrl}/api/help
`;
}

function hermesModelOptions(agent: AgentLike): string[] {
  const model = configuredString(agent.adapterConfig?.model) ?? configuredString(agent.adapterConfig?.hermesModel);
  const provider = configuredString(agent.adapterConfig?.provider) ?? configuredString(agent.adapterConfig?.hermesProvider);
  return [
    ...(model ? ['--model', assertSafeCliValue(model, 'Hermes model')] : []),
    ...(provider ? ['--provider', assertSafeCliValue(provider, 'Hermes provider')] : []),
  ];
}

function hermesSource(agent: AgentLike, task: TaskContext): string {
  const configured = configuredString(agent.adapterConfig?.source) ?? configuredString(agent.adapterConfig?.hermesSource);
  if (configured) return assertSafeCliValue(configured, 'Hermes source');
  return task.kind === 'chat' ? 'megacorps-direct-chat' : 'megacorps-kanban';
}

const HERMES_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeCliValue(value: string, label: string): string {
  if (value.startsWith('-') || /[\r\n\0]/.test(value)) throw new Error(`${label} contains unsupported characters for the Hermes CLI`);
  return value;
}

export function buildHermesCliCommand(agent: AgentLike, task: TaskContext, hermesCommand = 'hermes'): string[] {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  if (!HERMES_PROFILE_PATTERN.test(agent.hermesProfile)) throw new Error('Agent Hermes profile must use only letters, digits, dot, underscore, or hyphen and cannot start with a hyphen');
  const prompt = buildAgentPrompt(agent, task);
  return [
    hermesCommand,
    '--profile',
    agent.hermesProfile,
    ...hermesModelOptions(agent),
    ...(isHermesSessionId(agent.currentSessionId) ? ['--resume', agent.currentSessionId] : []),
    'chat',
    '-q',
    prompt,
    '-Q',
    '--source',
    hermesSource(agent, task),
  ];
}

export function hermesTaskResult(agent: AgentLike, result: ExecResult): TaskResult {
  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const sessionId = parseHermesSessionId(combinedOutput) ?? (isHermesSessionId(agent.currentSessionId) ? agent.currentSessionId : null);
  const visibleStdout = stripHermesSessionMetadata(result.stdout);
  const visibleStderr = stripHermesSessionMetadata(result.stderr);
  const success = result.exitCode === 0 && Boolean(sessionId);
  const output = success
    ? visibleStdout || visibleStderr || '[Hermes completed without textual output.]'
    : [
      visibleStdout,
      visibleStderr,
      result.exitCode === 0 && !sessionId ? 'Hermes did not return a session_id; cannot safely resume this scoped MegaCorps session.' : '',
    ].filter(Boolean).join('\n');
  const tokensUsed = estimateTokens(output);
  return {
    success,
    output,
    sessionId: sessionId ?? crypto.randomUUID(),
    tokensUsed,
    costUsd: estimateCost(tokensUsed),
    durationSeconds: result.duration,
  };
}
