import { dispatchToHermes } from './hermes.ts';

export type AgentAdapter = { dispatch: typeof dispatchToHermes };
const registry = new Map<string, AgentAdapter>();
registry.set('hermes', { dispatch: dispatchToHermes });
export function getAdapter(type: string): AgentAdapter {
  const adapter = registry.get(type);
  if (!adapter) throw new Error(`Adapter not registered: ${type}`);
  return adapter;
}
export function registerAdapter(type: string, adapter: AgentAdapter): void { registry.set(type, adapter); }
