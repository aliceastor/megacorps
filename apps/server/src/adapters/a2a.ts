import { createHash } from 'node:crypto';
import { unknownUsage } from '../usage-facts.ts';
import { currentUsageAttempt } from '../usage-context.ts';
import { A2aPollingError, pollA2aMessage, type A2aInvocationStore } from '../a2a-polling.ts';
import { a2aExecutionScope } from '../a2a-execution-scope.ts';
import { wrapA2aPrompt } from '../a2a-final-output.ts';
import { normalizeStoredA2aOutcome } from '../a2a-client.ts';
import { ensureA2aTunnel, type TunnelTarget } from '../a2a-tunnel.ts';
import { assertAdapterTargetAllowed, getAdapterNumberConfig, getAdapterOptionalStringConfig } from './config.ts';
import { buildAgentPrompt, estimateTokens, megacorpsApiUrl, type AgentLike, type TaskContext, type TaskResult } from './hermes.ts';
import { resolveHermesSshConnectionConfig } from './hermes-ssh.ts';

// Stage B pure-transport adapter (docs/a2a-adapter-design.md §7.1): same
// prompts and TaskResult contract as hermes-ssh, but delivered over the Hermes
// A2A gateway instead of a cold-started CLI. Native task mode (structured
// DataPart reports, input-required handling) is Stage C.

const FALLBACK_CONTEXT_PREFIX = 'a2a-fallback-';
const DEFAULT_A2A_PORT = 9900;
const TIMEOUT_MARGIN_MS = 10_000;

export function a2aSendTimeoutMs(timeoutSeconds: number | null | undefined): number {
  return (timeoutSeconds ?? 300) * 1000 + TIMEOUT_MARGIN_MS;
}

export type A2aDispatchDeps = {
  fetchImpl?: typeof fetch;
  tunnelFn?: (target: TunnelTarget) => Promise<number>;
  store?: A2aInvocationStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rpcTimeoutMs?: number;
};

export function routeIdentity(agent: AgentLike): string {
  const direct = getAdapterOptionalStringConfig(agent, 'a2aBaseUrl', 'A2A_BASE_URL');
  const endpoint = direct ? `${direct.replace(/\/+$/, '')}${agentPath(agent)}` : (() => {
    const ssh = resolveHermesSshConnectionConfig(agent);
    return JSON.stringify([ssh.host, ssh.user, ssh.port, getAdapterNumberConfig(agent, 'a2aPort', 'A2A_PORT', DEFAULT_A2A_PORT), agentPath(agent)]);
  })();
  return createHash('sha256').update(JSON.stringify([agent.runtimeId ?? null, endpoint])).digest('hex');
}

export function agentPath(agent: AgentLike): string {
  const configured = getAdapterOptionalStringConfig(agent, 'a2aAgentPath');
  if (configured) return configured.startsWith('/') ? configured : `/${configured}`;
  const slug = agent.hermesProfile?.trim();
  // Root path is the gateway's active-profile agent; served agents live at /<slug>.
  return slug ? `/${slug}` : '';
}

export async function resolveBaseUrl(agent: AgentLike, deps: A2aDispatchDeps): Promise<string> {
  const direct = getAdapterOptionalStringConfig(agent, 'a2aBaseUrl', 'A2A_BASE_URL');
  if (direct) return assertAdapterTargetAllowed(direct, 'a2aBaseUrl').replace(/\/+$/, '');
  const ssh = resolveHermesSshConnectionConfig(agent);
  const target: TunnelTarget = {
    host: ssh.host,
    user: ssh.user,
    sshPort: ssh.port,
    keyPath: ssh.keyPath ?? null,
    sshBin: ssh.sshBin,
    sshOptions: ssh.sshOptions,
    remotePort: getAdapterNumberConfig(agent, 'a2aPort', 'A2A_PORT', DEFAULT_A2A_PORT),
  };
  const tunnelFn = deps.tunnelFn ?? ensureA2aTunnel;
  const localPort = await tunnelFn(target);
  // Tunnel-local URL is derived, not user input; the SSH host above already
  // went through assertAdapterTargetAllowed inside the connection resolver.
  return `http://127.0.0.1:${localPort}`;
}

export function createA2aDispatch(deps: A2aDispatchDeps = {}) {
  return async function dispatchToA2a(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
    const started = Date.now();
    const prompt = wrapA2aPrompt(buildAgentPrompt(agent, task), task.kind);
    const durationSeconds = () => Math.max(1, Math.round((Date.now() - started) / 1000));
    try {
      const executionKey = task.executionKey ?? (task.taskRunId ? `task-run:${task.taskRunId}` : currentUsageAttempt());
      if (!executionKey) throw new Error('a2a_execution_key_missing');
      if (!agent.id) throw new Error('a2a_agent_identity_missing');
      const baseUrl = await resolveBaseUrl(agent, deps);
      const url = `${baseUrl}${agentPath(agent)}`;
      // The journal owns generated contexts and restores them across restart.
      const priorContext = agent.currentSessionId && !agent.currentSessionId.startsWith(FALLBACK_CONTEXT_PREFIX)
        ? agent.currentSessionId
        : null;
      const pushEnabled = agent.adapterConfig?.a2aPushEnabled !== false;
      // Only register accounting callbacks when the receiver can authenticate them.
      // Unconfigured gateways retain context-only reconciliation hints.
      const pushSecret = getAdapterOptionalStringConfig(agent, 'a2aPushSecret') ?? getAdapterOptionalStringConfig(agent, 'a2aBearerToken');
      const accountingKey = pushSecret ? currentUsageAttempt() : undefined;
      const store = deps.store ?? (await import('../a2a-executions.ts')).createA2aExecutionStore(agent.id);
      const outcome = normalizeStoredA2aOutcome(await pollA2aMessage({
        executionKey,
        scope: a2aExecutionScope(agent.id, task),
        route: routeIdentity(agent),
        store,
        now: deps.now,
        sleep: deps.sleep,
        rpcTimeoutMs: deps.rpcTimeoutMs,
        baseUrl: url,
        text: prompt,
        contextId: priorContext,
        configuration: pushEnabled
          ? { taskPushNotificationConfig: { url: `${megacorpsApiUrl(agent)}/api/a2a/push${accountingKey ? `?usageAttemptKey=${encodeURIComponent(accountingKey)}` : ''}` } }
          : null,
        bearerToken: getAdapterOptionalStringConfig(agent, 'a2aBearerToken', 'A2A_BEARER_TOKEN') ?? null,
        timeoutMs: a2aSendTimeoutMs(task.timeoutSeconds),
        fetchImpl: deps.fetchImpl,
      }));
      const failedState = outcome.state === 'failed' || outcome.state === 'canceled' || outcome.state === 'rejected' || outcome.state === 'auth_required';
      let output = outcome.state === 'auth_required'
        ? `a2a_task_auth_required${outcome.text ? `: ${outcome.text}` : ''}`
        : outcome.text || (failedState ? `a2a_task_${outcome.state}` : '');
      // A validated structured report is authoritative, including when replaying
      // older journals whose text still contains historical reports.
      if (outcome.report) {
        output = `\`\`\`json\n${JSON.stringify(outcome.report)}\n\`\`\``;
      }
      const ambiguousOutput = !outcome.report && output.startsWith('a2a_final_output_ambiguous:');
      const tokensUsed = estimateTokens(prompt) + estimateTokens(output);
      return {
        success: !failedState && !ambiguousOutput,
        output,
        sessionId: outcome.contextId ?? priorContext ?? '',
        turnId: outcome.taskId,
        tokensUsed,
        costUsd: Number(outcome.usage?.costUsd ?? 0),
        usage: outcome.usage ?? unknownUsage('character_count_prompt_and_output', tokensUsed),
        durationSeconds: durationSeconds(),
        needsInput: outcome.state === 'input_required' ? { question: outcome.text || 'The agent asked for clarification but sent no question text.' } : null,
        artifacts: outcome.artifacts,
      };
    } catch (error) {
      return {
        success: false,
        output: `a2a_transport_error: ${error instanceof Error ? error.message : 'unknown A2A failure'}`,
        sessionId: error instanceof A2aPollingError ? error.record.contextId : agent.currentSessionId ?? '',
        turnId: error instanceof A2aPollingError ? error.record.taskId : null,
        tokensUsed: 0,
        costUsd: 0,
        usage: unknownUsage('a2a_transport_error'),
        durationSeconds: durationSeconds(),
      };
    }
  };
}

export const dispatchToA2a = createA2aDispatch();
