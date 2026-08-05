import { randomUUID } from 'node:crypto';
import { sendA2aMessage } from '../a2a-client.ts';
import { ensureA2aTunnel, type TunnelTarget } from '../a2a-tunnel.ts';
import { assertAdapterTargetAllowed, getAdapterNumberConfig, getAdapterOptionalStringConfig } from './config.ts';
import { buildAgentPrompt, estimateCost, estimateTokens, megacorpsApiUrl, type AgentLike, type TaskContext, type TaskResult } from './hermes.ts';
import { resolveHermesSshConnectionConfig } from './hermes-ssh.ts';

// Stage B pure-transport adapter (docs/a2a-adapter-design.md §7.1): same
// prompts and TaskResult contract as hermes-ssh, but delivered over the Hermes
// A2A gateway instead of a cold-started CLI. Native task mode (structured
// DataPart reports, input-required handling) is Stage C.

const FALLBACK_CONTEXT_PREFIX = 'a2a-fallback-';
const GENERATED_CONTEXT_PREFIX = 'a2a-ctx-';
const DEFAULT_A2A_PORT = 9900;
const TIMEOUT_MARGIN_MS = 10_000;

export type A2aDispatchDeps = {
  fetchImpl?: typeof fetch;
  tunnelFn?: (target: TunnelTarget) => Promise<number>;
};

function agentPath(agent: AgentLike): string {
  const configured = getAdapterOptionalStringConfig(agent, 'a2aAgentPath');
  if (configured) return configured.startsWith('/') ? configured : `/${configured}`;
  const slug = agent.hermesProfile?.trim();
  // Root path is the gateway's active-profile agent; served agents live at /<slug>.
  return slug ? `/${slug}` : '';
}

async function resolveBaseUrl(agent: AgentLike, deps: A2aDispatchDeps): Promise<string> {
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
    const prompt = buildAgentPrompt(agent, task);
    const durationSeconds = () => Math.max(1, Math.round((Date.now() - started) / 1000));
    try {
      const baseUrl = await resolveBaseUrl(agent, deps);
      const url = `${baseUrl}${agentPath(agent)}`;
      // Pre-generate the contextId when there is no resumable one: it is the
      // correlation key for push reconciliation even when SendMessage times out.
      const priorContext = agent.currentSessionId && !agent.currentSessionId.startsWith(FALLBACK_CONTEXT_PREFIX)
        ? agent.currentSessionId
        : null;
      const contextId = priorContext ?? `${GENERATED_CONTEXT_PREFIX}${randomUUID()}`;
      const pushEnabled = agent.adapterConfig?.a2aPushEnabled !== false;
      const outcome = await sendA2aMessage({
        baseUrl: url,
        text: prompt,
        contextId,
        configuration: pushEnabled
          ? { taskPushNotificationConfig: { url: `${megacorpsApiUrl(agent)}/api/a2a/push` } }
          : null,
        bearerToken: getAdapterOptionalStringConfig(agent, 'a2aBearerToken', 'A2A_BEARER_TOKEN') ?? null,
        timeoutMs: (task.timeoutSeconds ?? 300) * 1000 + TIMEOUT_MARGIN_MS,
        fetchImpl: deps.fetchImpl,
      });
      const failedState = outcome.state === 'failed' || outcome.state === 'canceled' || outcome.state === 'rejected';
      let output = outcome.text || (failedState ? `a2a_task_${outcome.state}` : '');
      // Surface a DataPart report to the Stage A extractor by embedding it as a
      // fenced JSON block; dispatch-side parsing then needs no A2A awareness.
      if (outcome.report && !output.includes('megacorps-report')) {
        output = `${output}\n\n\`\`\`json\n${JSON.stringify(outcome.report)}\n\`\`\``.trim();
      }
      const tokensUsed = estimateTokens(prompt) + estimateTokens(output);
      return {
        success: !failedState,
        output,
        sessionId: outcome.contextId ?? contextId,
        turnId: outcome.taskId,
        tokensUsed,
        costUsd: estimateCost(tokensUsed),
        durationSeconds: durationSeconds(),
        needsInput: outcome.state === 'input_required' ? { question: outcome.text || 'The agent asked for clarification but sent no question text.' } : null,
        artifacts: outcome.artifacts,
      };
    } catch (error) {
      return {
        success: false,
        output: `a2a_transport_error: ${error instanceof Error ? error.message : 'unknown A2A failure'}`,
        sessionId: agent.currentSessionId ?? '',
        tokensUsed: 0,
        costUsd: 0,
        durationSeconds: durationSeconds(),
      };
    }
  };
}

export const dispatchToA2a = createA2aDispatch();
