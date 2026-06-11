import { spawn } from 'node:child_process';
import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { buildHermesCliCommand, hermesTaskResult } from './hermes.ts';
import { adapterEnvFallbackEnabled, assertAdapterTargetAllowed } from './config.ts';

type SshRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function splitExtraOptions(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function configuredEnv(envName: string | undefined): string | undefined {
  return envName && adapterEnvFallbackEnabled() ? configuredString(process.env[envName]) : undefined;
}

function getStringConfigAliases(agent: AgentLike, keys: string[], envName?: string, fallback?: string): string {
  const value = keys.map((key) => configuredString(agent.adapterConfig?.[key])).find(Boolean) ?? configuredEnv(envName) ?? fallback;
  if (!value) throw new Error(`${keys[0]}${envName ? ` (${envName})` : ''} is required`);
  return value;
}

function getOptionalStringConfigAliases(agent: AgentLike, keys: string[], envName?: string): string | undefined {
  return keys.map((key) => configuredString(agent.adapterConfig?.[key])).find(Boolean) ?? configuredEnv(envName);
}

function getNumberConfigAliases(agent: AgentLike, keys: string[], envName: string | undefined, fallback: number): number {
  const configured = keys.map((key) => agent.adapterConfig?.[key]).find((value) => value !== undefined && value !== null && value !== '');
  const raw = typeof configured === 'number'
    ? configured
    : typeof configured === 'string' && configured.trim().length > 0
      ? Number(configured)
      : Number(configuredEnv(envName) ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

export function resolveHermesCommand(agent: AgentLike): string {
  return getStringConfigAliases(agent, ['hermesCommand', 'command'], 'HERMES_SSH_COMMAND', 'hermes');
}

export function resolveHermesSshConnectionConfig(agent: AgentLike) {
  return {
    host: assertAdapterTargetAllowed(getStringConfigAliases(agent, ['sshHost', 'host'], 'HERMES_SSH_HOST'), 'HERMES_SSH_HOST'),
    user: getOptionalStringConfigAliases(agent, ['sshUser', 'sshUsername', 'username', 'user'], 'HERMES_SSH_USER') ?? 'root',
    port: getNumberConfigAliases(agent, ['sshPort', 'port'], 'HERMES_SSH_PORT', 22),
    keyPath: getOptionalStringConfigAliases(agent, ['sshKeyPath', 'keyPath'], 'HERMES_SSH_KEY_PATH'),
    sshBin: getOptionalStringConfigAliases(agent, ['sshBin'], 'HERMES_SSH_BIN') ?? 'ssh',
    sshOptions: splitExtraOptions(getOptionalStringConfigAliases(agent, ['sshOptions'], 'HERMES_SSH_OPTIONS')),
  };
}

function wrapWithContainerEnv(command: string[]): string {
  const script = [
    'if [ -r /proc/1/environ ]; then',
    'while IFS= read -r -d \'\' env_kv; do',
    'case "$env_kv" in *=*) export "$env_kv";; esac;',
    'done < /proc/1/environ;',
    'fi;',
    'exec "$@"',
  ].join(' ');
  return ['bash', '-lc', script, 'megacorps-hermes', ...command].map(shellQuote).join(' ');
}

export function buildHermesSshRemoteCommand(agent: AgentLike, task: TaskContext): string {
  const hermesCommand = resolveHermesCommand(agent);
  return wrapWithContainerEnv(buildHermesCliCommand(agent, task, hermesCommand));
}

async function runSsh(agent: AgentLike, remoteCommand: string, timeoutSec: number, onOutput?: (chunk: string) => void): Promise<SshRunResult> {
  const started = Date.now();
  const { host, user, port, keyPath, sshBin, sshOptions } = resolveHermesSshConnectionConfig(agent);
  const target = user ? `${user}@${host}` : host;
  const args = [
    '-p',
    String(port),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'UserKnownHostsFile=/tmp/megacorps-known-hosts',
    ...(keyPath ? ['-i', keyPath] : []),
    ...sshOptions,
    target,
    remoteCommand,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // If the ssh client ignores SIGTERM (e.g. wedged connection), force-kill so
      // timed-out dispatches cannot accumulate orphaned ssh processes.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      }, 5_000);
      reject(new Error(`Hermes SSH task timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onOutput) {
        try { onOutput(String(chunk)); } catch { /* streaming is best effort */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Hermes SSH failed to start ${sshBin}: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        duration: Math.round((Date.now() - started) / 1000),
      });
    });
  });
}

export async function dispatchToHermesSsh(agent: AgentLike, task: TaskContext, hooks?: { onOutput?: (chunk: string) => void }): Promise<TaskResult> {
  const remoteCommand = buildHermesSshRemoteCommand(agent, task);
  const result = await runSsh(agent, remoteCommand, task.timeoutSeconds ?? 300, hooks?.onOutput);
  return hermesTaskResult(agent, result);
}
