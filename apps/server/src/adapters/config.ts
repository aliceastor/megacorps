import type { AgentLike } from './hermes.ts';

const externalAdapterTypes = new Set(['hermes-ssh', 'hermes-gateway', 'codex-app', 'webhook', 'openclaw']);
const blockedAdapterHosts = new Set(['localhost', 'localhost.', '0.0.0.0', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1', '169.254.169.254']);

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function configuredEnv(envName: string | undefined): string | undefined {
  if (!envName || !adapterEnvFallbackEnabled()) return undefined;
  return configuredString(process.env[envName]);
}

function adapterTargetAllowlist(): string[] {
  return (process.env.ADAPTER_TARGET_ALLOWLIST ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function targetHostname(rawTarget: string): string {
  try {
    return new URL(rawTarget).hostname.toLowerCase();
  } catch {
    const target = rawTarget.trim().split('/')[0] ?? '';
    if (target.startsWith('[')) return (target.match(/^\[([^\]]+)\]/)?.[1] ?? target).toLowerCase();
    const colonCount = (target.match(/:/g) ?? []).length;
    return (colonCount > 1 ? target : target.split(':')[0] ?? '').toLowerCase();
  }
}

function matchesAllowlist(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  return host === pattern;
}

export function assertAdapterTargetAllowed(rawTarget: string, label: string): string {
  const host = targetHostname(rawTarget);
  const allowlist = adapterTargetAllowlist();
  if (allowlist.length > 0 && !allowlist.some((pattern) => matchesAllowlist(host, pattern))) {
    throw new Error(`${label} host is not in ADAPTER_TARGET_ALLOWLIST`);
  }
  if (blockedAdapterHosts.has(host) || host.startsWith('127.') || host.startsWith('169.254.')) {
    throw new Error(`${label} host is blocked for adapter egress`);
  }
  return rawTarget;
}

export function adapterEnvFallbackEnabled(): boolean {
  const configured = process.env.ADAPTER_ENV_FALLBACK_ENABLED;
  if (configured !== undefined) return truthy(configured.toLowerCase());
  return process.env.NODE_ENV !== 'production';
}

export function adapterRequiresRuntime(adapterType: string | null | undefined): boolean {
  return externalAdapterTypes.has(adapterType ?? '') && !adapterEnvFallbackEnabled();
}

export function getAdapterStringConfig(agent: AgentLike, key: string, envName?: string, fallback?: string): string {
  const value = configuredString(agent.adapterConfig?.[key]) ?? configuredEnv(envName) ?? fallback;
  if (!value) throw new Error(`${key}${envName ? ` (${envName})` : ''} is required`);
  return value;
}

export function getAdapterOptionalStringConfig(agent: AgentLike, key: string, envName?: string): string | undefined {
  return configuredString(agent.adapterConfig?.[key]) ?? configuredEnv(envName);
}

export function getAdapterNumberConfig(agent: AgentLike, key: string, envName: string | undefined, fallback: number): number {
  const configured = agent.adapterConfig?.[key];
  const raw = typeof configured === 'number'
    ? configured
    : typeof configured === 'string' && configured.trim().length > 0
      ? Number(configured)
      : Number(configuredEnv(envName) ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.round(raw);
}
