import { spawn } from 'node:child_process';
import type { AgentLike, TaskContext, TaskResult } from './hermes.ts';
import { buildAgentPrompt, estimateCost, estimateTokens, extractSessionId } from './hermes.ts';

type SshRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
};

function getStringConfig(agent: AgentLike, key: string, envName: string, fallback?: string): string {
  const configured = agent.adapterConfig?.[key];
  const value = (typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : undefined) ?? process.env[envName] ?? fallback;
  if (!value) throw new Error(`${key} (${envName}) is required`);
  return value;
}

function getOptionalStringConfig(agent: AgentLike, key: string, envName: string): string | undefined {
  const configured = agent.adapterConfig?.[key];
  const value = (typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : undefined) ?? process.env[envName];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumberConfig(agent: AgentLike, key: string, envName: string, fallback: number): number {
  const configured = agent.adapterConfig?.[key];
  const raw = typeof configured === 'number' ? configured : typeof configured === 'string' ? Number(configured) : Number(process.env[envName] ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.round(raw);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function splitExtraOptions(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function buildRemoteCommand(agent: AgentLike, task: TaskContext): string {
  if (!agent.hermesProfile) throw new Error('Agent has no Hermes profile configured');
  const prompt = buildAgentPrompt(agent, task);
  const hermesCommand = getStringConfig(agent, 'hermesCommand', 'HERMES_SSH_COMMAND', 'hermes');
  const maxTurns = getNumberConfig(agent, 'maxTurns', 'HERMES_MAX_TURNS', 60);
  const reasoningEffort = getOptionalStringConfig(agent, 'reasoningEffort', 'HERMES_REASONING_EFFORT') ?? 'medium';
  const command = [
    hermesCommand,
    'chat',
    '--profile',
    agent.hermesProfile,
    ...(agent.currentSessionId ? ['--resume', agent.currentSessionId] : []),
    '--max-turns',
    String(maxTurns),
    '--reasoning-effort',
    reasoningEffort,
    prompt,
  ];
  return command.map(shellQuote).join(' ');
}

async function runSsh(agent: AgentLike, remoteCommand: string, timeoutSec: number): Promise<SshRunResult> {
  const started = Date.now();
  const host = getStringConfig(agent, 'sshHost', 'HERMES_SSH_HOST', '192.168.1.172');
  const user = getOptionalStringConfig(agent, 'sshUser', 'HERMES_SSH_USER') ?? 'root';
  const port = getNumberConfig(agent, 'sshPort', 'HERMES_SSH_PORT', 22);
  const keyPath = getOptionalStringConfig(agent, 'sshKeyPath', 'HERMES_SSH_KEY_PATH');
  const sshBin = getOptionalStringConfig(agent, 'sshBin', 'HERMES_SSH_BIN') ?? 'ssh';
  const sshOptions = splitExtraOptions(getOptionalStringConfig(agent, 'sshOptions', 'HERMES_SSH_OPTIONS'));
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
  const remoteCommand = buildRemoteCommand(agent, task);
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
