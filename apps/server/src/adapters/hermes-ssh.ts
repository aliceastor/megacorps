import { spawn } from 'node:child_process';
import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { buildAgentPrompt, estimateCost, estimateTokens, extractSessionId } from './hermes.ts';
import { assertAdapterTargetAllowed, getAdapterNumberConfig, getAdapterOptionalStringConfig, getAdapterStringConfig } from './config.ts';

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
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  const prompt = buildAgentPrompt(agent, task);
  const hermesCommand = getAdapterStringConfig(agent, 'hermesCommand', 'HERMES_SSH_COMMAND', 'hermes');
  const command = [
    hermesCommand,
    '-z',
    prompt,
    '--profile',
    agent.hermesProfile,
  ];
  return wrapWithContainerEnv(command);
}

async function runSsh(agent: AgentLike, remoteCommand: string, timeoutSec: number): Promise<SshRunResult> {
  const started = Date.now();
  const host = assertAdapterTargetAllowed(getAdapterStringConfig(agent, 'sshHost', 'HERMES_SSH_HOST'), 'HERMES_SSH_HOST');
  const user = getAdapterOptionalStringConfig(agent, 'sshUser', 'HERMES_SSH_USER') ?? 'root';
  const port = getAdapterNumberConfig(agent, 'sshPort', 'HERMES_SSH_PORT', 22);
  const keyPath = getAdapterOptionalStringConfig(agent, 'sshKeyPath', 'HERMES_SSH_KEY_PATH');
  const sshBin = getAdapterOptionalStringConfig(agent, 'sshBin', 'HERMES_SSH_BIN') ?? 'ssh';
  const sshOptions = splitExtraOptions(getAdapterOptionalStringConfig(agent, 'sshOptions', 'HERMES_SSH_OPTIONS'));
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
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Hermes SSH task timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Hermes SSH failed to start ${sshBin}: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        duration: Math.round((Date.now() - started) / 1000),
      });
    });
  });
}

export async function dispatchToHermesSsh(agent: AgentLike, task: TaskContext): Promise<TaskResult> {
  const remoteCommand = buildHermesSshRemoteCommand(agent, task);
  const result = await runSsh(agent, remoteCommand, task.timeoutSeconds ?? 300);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const tokensUsed = estimateTokens(output);
  return {
    success: result.exitCode === 0,
    output,
    sessionId: extractSessionId(output),
    tokensUsed,
    costUsd: estimateCost(tokensUsed),
    durationSeconds: result.duration,
  };
}
