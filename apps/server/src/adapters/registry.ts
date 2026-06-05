import { dispatchToHermes } from './hermes.ts';
import { dispatchToHermesGateway } from './hermes-gateway.ts';
import { dispatchToHermesSsh } from './hermes-ssh.ts';
import { dispatchToMock } from './mock.ts';
import { dispatchToOpenClaw, dispatchToWebhook } from './webhook.ts';

export type AgentAdapter = { dispatch: typeof dispatchToHermes };
const registry = new Map<string, AgentAdapter>();
registry.set('hermes', { dispatch: dispatchToHermes });
registry.set('hermes-gateway', { dispatch: dispatchToHermesGateway });
registry.set('hermes-ssh', { dispatch: dispatchToHermesSsh });
registry.set('mock', { dispatch: dispatchToMock });
registry.set('webhook', { dispatch: dispatchToWebhook });
registry.set('openclaw', { dispatch: dispatchToOpenClaw });
export function getAdapter(type: string): AgentAdapter {
  const adapter = registry.get(type);
  if (!adapter) throw new Error(`Adapter not registered: ${type}`);
  return adapter;
}
export function registerAdapter(type: string, adapter: AgentAdapter): void { registry.set(type, adapter); }
