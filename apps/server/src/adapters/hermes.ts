import { unknownUsage, type UsageFacts } from '../usage-facts.ts';
import { currentUsageAttempt } from '../usage-context.ts';
import { agentReportGuidance, type ReportingMode } from '../agent-report-guidance.ts';
export type ExecResult = { stdout: string; stderr: string; exitCode: number; duration: number };
export type TaskContext = { id: string; title: string; body: string; timeoutSeconds?: number; kind?: 'task' | 'chat' | 'maintenance'; taskRunId?: string | null; reportingMode?: ReportingMode; informationalOnly?: boolean };
export type TaskResult = {
  success: boolean;
  output: string;
  sessionId: string;
  turnId?: string | null;
  tokensUsed: number;
  costUsd: number;
  durationSeconds: number;
  usage?: UsageFacts;
  // Native A2A task-mode extensions (optional; legacy adapters never set them).
  needsInput?: { question: string } | null;
  artifacts?: Array<{ artifactId: string; name?: string; uri?: string; text?: string }>;
};
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
  apiToken?: string | null;
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

export function megacorpsApiUrl(agent: AgentLike): string {
  return configuredString(agent.adapterConfig?.megacorpsApiUrl)
    ?? configuredString(agent.adapterConfig?.callbackUrl)
    ?? configuredString(agent.adapterConfig?.webhookBaseUrl)
    ?? configuredString(agent.adapterConfig?.publicApiUrl)
    ?? configuredString(process.env.INTERNAL_API_URL)
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
  if (task.informationalOnly && task.kind === 'chat') {
    return `This is an informational colleague question, not authorization to execute work or change the board.\n\n${task.body}\n\nReply with the answer text only; MegaCorps posts it to the original thread.`;
  }
  if (task.reportingMode && task.kind !== 'chat' && task.kind !== 'maintenance') {
    return [`Agent: ${agent.hermesProfile ?? 'unknown'}; Card: ${task.id}; Run: ${task.taskRunId ?? 'none'}`,
      task.body, agentReportGuidance(task.reportingMode)].join('\n\n');
  }
  if (task.kind === 'chat') {
    return `You are in a direct MegaCorps chat session.

=== Your Identity ===
Agent: ${agent.hermesProfile ?? 'unknown'}
Session: ${agent.currentSessionId ?? 'new'}

=== Conversation ===
${task.body}

Respond to the user directly.

=== Following Up On The Kanban Board ===
This chat and the Kanban board are separate contexts, so anything agreed here
is invisible to the board unless you say so. When the user asks you to do,
track, schedule, or change a piece of work, end your reply with a fenced JSON
block and MegaCorps will apply it to the board on the user's behalf:

\`\`\`json
{ "kind": "megacorps-chat-actions", "actions": [
  { "action": "create_card", "title": "Short task title", "body": "What to do and what done looks like.", "priority": "normal", "assigneeSlug": "optional-agent-slug" },
  { "action": "update_card", "cardId": "uuid-from-the-kanban-context", "status": "in_progress", "body": "optional replacement body" },
  { "action": "note", "body": "One-line conclusion worth remembering, e.g. agreed with the user to use the v2 format." }
] }
\`\`\`

Rules: priority is low|normal|high|urgent. status is todo|in_progress|in_review|needs_review|waiting_on_external|done|blocked|cancelled. Only use a cardId that appears in the Kanban context you were given. Prefer update_card over create_card when the work already has a card. Omit the block entirely for ordinary conversation — questions, explanations, and advice do not belong on the board. Do not call the Kanban webhook and do not call session-auth endpoints such as POST /api/cards from a chat turn; this block is your channel.

The "note" action is your own cross-session memory: whenever this conversation reaches a decision, correction, or fact you will need in later work (including your Kanban runs), record it as a note. Notes are injected back to you in future sessions as part of your activity digest. A conversation that changed nothing needs no note.`;
  }

  if (task.kind === 'maintenance') {
    return `You are in a MegaCorps shift-end maintenance session.

=== Your Identity ===
Agent: ${agent.hermesProfile ?? 'unknown'}

=== Maintenance Task ===
${task.body}

This session is only for consolidating your own memory and skills. Do not call the MegaCorps Kanban webhook, do not create or update work items, and do not start new project work.`;
  }

  const apiUrl = megacorpsApiUrl(agent);
  const taskWebhookSecret = webhookSharedSecret(agent);
  // Per-agent token wins over the shared secret: the webhook then knows which
  // agent is reporting instead of trusting whatever the payload claims.
  const webhookAuthLine = agent.apiToken
    ? `Header: Authorization: Bearer ${agent.apiToken}`
    : taskWebhookSecret
      ? `Header: X-MegaCorps-Webhook-Secret: ${taskWebhookSecret}`
      : 'Webhook auth: no shared secret was provided in your runtime config.';
  const webhookBodyExample = task.taskRunId
    ? `{ "cardId": "${task.id}", "taskRunId": "${task.taskRunId}", "status": "done", "summary": "...", "output": "..." }`
    : `{ "cardId": "${task.id}", ${currentUsageAttempt() ? `"usageAttemptKey": "${currentUsageAttempt()}", ` : ''}"status": "done", "summary": "...", "output": "..." }`;
  // The conversation endpoint authenticates with the per-agent token only, so
  // it is advertised only when the agent actually has one.
  const commentsEndpointLine = agent.apiToken
    ? `\n- POST ${apiUrl}/api/cards/${task.id}/comments -- Leave a message on the card conversation ({ "body": "..." }); @<slug> wakes that agent`
    : '';
  return `You are now working under PLATFORM MegaCorps at ${apiUrl}.

Task runtimes usually do not have a browser session cookie. Do not call session-auth endpoints such as POST /api/cards for delegation. Return structured report.delegations for same-card help or report.children for authorized independent deliverables as specified in the task. MegaCorps validates and creates the assignments.

=== Your Identity ===
Agent: ${agent.hermesProfile ?? 'unknown'}
Card ID: ${task.id}
Task Run ID: ${task.taskRunId ?? 'none'}
Card Title: ${task.title}

=== Task ===
${task.body}

=== Native Reporting Instructions ===
Return one structured megacorps-report JSON directly in your final response. This native response is the primary and sufficient reporting channel. No HTTP request is needed to report progress, delegation, or results. MegaCorps records the response and evidence, validates assignments, and applies review, approval, and merge gates. A completed report does not bypass those gates.
The notation report.children means the top-level "children" key beside kind/status/summary in that JSON; the same applies to delegations, workProducts, notes and request. Do not add another "report" wrapper to your native response. The optional HTTP webhook body's "report" envelope is a separate API format.

Completed work example:
\`\`\`json
{ "kind": "megacorps-report", "version": 1, "status": "completed", "summary": "Completed the assigned work; evidence is attached.", "workProducts": [{ "type": "report", "title": "Deliverable", "url": "https://example.com/deliverable" }] }
\`\`\`
Replace example values with actual evidence. workProducts.type is report | file | preview_url | pull_request | commit | screenshot | artifact | external. For a review, include verdict approved | revision_requested | escalate.
For an ordinary review with no actionable defects, omit findings or use []. Put successful checks in summary or explanatory output, not findings.
Ordinary review example: { "kind": "megacorps-report", "version": 1, "status": "completed", "summary": "Reviewed the assigned evidence against the requirements; no actionable defects found.", "verdict": "approved" }
When included, findings must be an array of objects, each with severity (P0 | P1 | P2) and nonempty title, evidence, and requiredFix strings. Do not use an object of checks, strings, or success/info severities as findings.
Actionable finding example: { "kind": "megacorps-report", "version": 1, "status": "completed", "summary": "Evidence shows an unmet requirement.", "verdict": "revision_requested", "findings": [{ "severity": "P1", "title": "<specific unmet requirement>", "evidence": "<observed behavior and its location>", "requiredFix": "<concrete correction and verification>" }] }
For panel and verification tasks, follow the task-specific required findings, verifications, and dispositions contract; do not omit required fields based on the ordinary review example. Use examples only when supported by the actual evidence.
Report states: completed | progress (legacy in_progress accepted) | input_required | failed | rejected. Use completed for finished work, including work awaiting ordinary QA; MegaCorps selects the next review stage.
For input_required, use request.kind permission | help | checkpoint and request.question; checkpoint accepts checkpointKind direction | interim (default direction), options and recommendation. A permission blocker cannot approve work. Keep delegations in report.delegations when needed.
The legacy DELEGATE block still works but is deprecated.

To ask another agent a question WITHOUT delegating work, add mentions to the report:
"mentions": [{ "to": "<agent-slug>", "question": "..." }]
MegaCorps posts each question to this card's message board and the target agent answers in the same thread shortly after; check the message board on your next turn for the answer. Use a mention when you need information or a decision from a peer; use a delegation only when transferring actual work. Maximum 3 mentions per report.

To leave a message on the card conversation for the humans and colleagues following it, add notes to the report:
"notes": ["..."]
Each note is posted as your comment on the card (maximum 3 per report). Writing @<agent-slug> inside a note wakes that agent with the message; @client pings the human client without blocking the card.

For same-card delegation, return status "progress" with "delegations": [{ "to": "<direct-report-slug>", "objective": "<specific work and expected evidence>" }]. For independent deliverables use the task's report.children instructions. Do not mark the parent done while delegating, and do not create Kanban cards yourself.
If you cannot solve the task, return status "input_required" with request.kind "help", request.question, and attempted methods, blocker/root cause, partial output, and logs in summary/output. For an actual permission blocker on the task action, use request.kind "permission" and state the exact authorization needed; do not claim that work is complete.

=== Optional Asynchronous API Integration ===
The existing authorized webhook is optional. Use your native response for normal reporting even when HTTP is unavailable. If an optional reporting call is declined, do not retry the reporting call or weaken its security gate; return your report directly, distinguishing completed work from any genuinely blocked task action. This does not authorize a denied task action or remove a real permission blocker.
- POST ${apiUrl}/api/webhook/task-complete -- Optional asynchronous task report${commentsEndpointLine}
${webhookAuthLine}
Optional webhook body: ${webhookBodyExample}
If using this integration, include the same structured object as its "report" field. The report state controls completion even when the webhook status says done. Use only this card and task run's authorized endpoint and identity.
- GET ${apiUrl}/api/help -- Optional full API documentation when network access is available; no fetch is required to return a report.
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
  if (task.kind === 'chat') return 'megacorps-direct-chat';
  if (task.kind === 'maintenance') return 'megacorps-maintenance';
  return 'megacorps-kanban';
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
    costUsd: 0,
    usage: unknownUsage('character_count_output', tokensUsed),
    durationSeconds: result.duration,
  };
}
