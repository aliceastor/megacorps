import { dispatchToCodexApp } from './codex-app.ts';
import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { dispatchToHermesGateway } from './hermes-gateway.ts';
import { dispatchToHermesSsh } from './hermes-ssh.ts';
import { dispatchToOpenClaw, dispatchToWebhook } from './webhook.ts';

export type AdapterDispatchHooks = {
  // Incremental stdout/text chunks while the adapter run is still in flight.
  // Adapters that cannot stream simply never call it.
  onOutput?: (chunk: string) => void;
};
export type AgentAdapter = { dispatch: (agent: AgentLike, task: TaskContext, hooks?: AdapterDispatchHooks) => Promise<TaskResult> };
const registry = new Map<string, AgentAdapter>();
registry.set('hermes-gateway', { dispatch: dispatchToHermesGateway });
registry.set('hermes-ssh', { dispatch: dispatchToHermesSsh });
registry.set('codex-app', { dispatch: dispatchToCodexApp });
registry.set('webhook', { dispatch: dispatchToWebhook });
registry.set('openclaw', { dispatch: dispatchToOpenClaw });
export function getAdapter(type: string): AgentAdapter {
  const adapter = registry.get(type);
  if (!adapter) throw new Error(`Adapter not registered: ${type}`);
  return adapter;
}
export function registerAdapter(type: string, adapter: AgentAdapter): void { registry.set(type, adapter); }
