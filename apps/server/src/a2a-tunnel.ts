import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Socket } from 'node:net';

// SSH local-forward manager for A2A gateways. The Hermes A2A server binds
// 127.0.0.1 by design (no bearer token needed); MegaCorps reaches it through
// one long-lived `ssh -N -L` per host, recreated on demand when it drops.

export type TunnelTarget = {
  host: string;
  user: string;
  sshPort: number;
  keyPath?: string | null;
  sshBin?: string | null;
  sshOptions?: string[];
  remotePort: number;
};

type SpawnedChild = {
  kill: () => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  killed: boolean;
};

export type TunnelDeps = {
  spawnFn: (command: string, args: string[]) => SpawnedChild;
  probeFn: (port: number) => Promise<boolean>;
  allocatePortFn: () => Promise<number>;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
};

type TunnelState = {
  localPort: number;
  child: SpawnedChild;
  ready: Promise<number>;
};

const tunnels = new Map<string, TunnelState>();

function targetKey(target: TunnelTarget): string {
  return `${target.user}@${target.host}:${target.sshPort}->${target.remotePort}`;
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('a2a_tunnel_port_allocation_failed'))));
    });
  });
}

async function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1', () => finish(true));
  });
}

const defaultDeps: TunnelDeps = {
  spawnFn: (command, args) => spawn(command, args, { stdio: 'ignore' }),
  probeFn: probeTcp,
  allocatePortFn: allocateFreePort,
};

function sshArgs(target: TunnelTarget, localPort: number): string[] {
  return [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    ...(target.keyPath ? ['-i', target.keyPath] : []),
    '-p', String(target.sshPort),
    ...(target.sshOptions ?? []),
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${target.remotePort}`,
    `${target.user}@${target.host}`,
  ];
}

async function waitUntilReady(state: { child: SpawnedChild; exited: boolean }, port: number, deps: TunnelDeps): Promise<void> {
  const timeoutMs = Math.max(200, deps.probeTimeoutMs ?? 15_000);
  const intervalMs = Math.max(20, deps.probeIntervalMs ?? 300);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error('a2a_tunnel_not_ready: ssh exited before the forward came up');
    if (await deps.probeFn(port)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`a2a_tunnel_not_ready: forward to port ${port} did not come up within ${timeoutMs}ms`);
}

export async function ensureA2aTunnel(target: TunnelTarget, deps: TunnelDeps = defaultDeps): Promise<number> {
  const key = targetKey(target);
  const existing = tunnels.get(key);
  if (existing) return existing.ready;

  const localPort = await deps.allocatePortFn();
  const child = deps.spawnFn(target.sshBin ?? 'ssh', sshArgs(target, localPort));
  const exitState = { child, exited: false };
  child.on('exit', () => {
    exitState.exited = true;
    if (tunnels.get(key)?.child === child) tunnels.delete(key);
  });
  child.on('error', () => {
    exitState.exited = true;
    if (tunnels.get(key)?.child === child) tunnels.delete(key);
  });

  const ready = waitUntilReady(exitState, localPort, deps).then(() => localPort).catch((error) => {
    if (!child.killed) child.kill();
    if (tunnels.get(key)?.child === child) tunnels.delete(key);
    throw error;
  });
  tunnels.set(key, { localPort, child, ready });
  return ready;
}

export function closeAllA2aTunnels(): void {
  for (const state of tunnels.values()) {
    if (!state.child.killed) state.child.kill();
  }
  tunnels.clear();
}
