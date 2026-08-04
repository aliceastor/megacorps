import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { closeAllA2aTunnels, ensureA2aTunnel, type TunnelDeps, type TunnelTarget } from './a2a-tunnel.ts';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => void; killed: boolean };
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

const target: TunnelTarget = { host: 'hermes-1.internal', user: 'ops', sshPort: 22, remotePort: 9900 };

function makeDeps(overrides: Partial<TunnelDeps> = {}) {
  const spawned: Array<{ command: string; args: string[]; child: ReturnType<typeof fakeChild> }> = [];
  let nextPort = 40_000;
  const deps: TunnelDeps = {
    spawnFn: (command, args) => {
      const child = fakeChild();
      spawned.push({ command, args, child });
      return child;
    },
    probeFn: async () => true,
    allocatePortFn: async () => nextPort++,
    ...overrides,
  };
  return { deps, spawned };
}

test('ensureA2aTunnel spawns ssh with a local forward and returns the local port', async (t) => {
  t.after(() => closeAllA2aTunnels());
  const { deps, spawned } = makeDeps();
  const port = await ensureA2aTunnel(target, deps);
  assert.equal(port, 40_000);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.command, 'ssh');
  const args = spawned[0]!.args.join(' ');
  assert.match(args, /-N/);
  assert.match(args, /-L 127\.0\.0\.1:40000:127\.0\.0\.1:9900/);
  assert.match(args, /ops@hermes-1\.internal/);
});

test('ensureA2aTunnel reuses a live tunnel for the same target', async (t) => {
  t.after(() => closeAllA2aTunnels());
  const { deps, spawned } = makeDeps();
  const first = await ensureA2aTunnel(target, deps);
  const second = await ensureA2aTunnel(target, deps);
  assert.equal(first, second);
  assert.equal(spawned.length, 1);
});

test('ensureA2aTunnel recreates the tunnel after the child exits', async (t) => {
  t.after(() => closeAllA2aTunnels());
  const { deps, spawned } = makeDeps();
  await ensureA2aTunnel(target, deps);
  spawned[0]!.child.emit('exit', 1);
  const port = await ensureA2aTunnel(target, deps);
  assert.equal(spawned.length, 2);
  assert.equal(port, 40_001);
});

test('ensureA2aTunnel fails and cleans up when the probe never succeeds', async (t) => {
  t.after(() => closeAllA2aTunnels());
  const { deps, spawned } = makeDeps({ probeFn: async () => false, probeTimeoutMs: 200, probeIntervalMs: 20 } as Partial<TunnelDeps>);
  await assert.rejects(ensureA2aTunnel(target, deps), /a2a_tunnel_not_ready/);
  assert.equal(spawned[0]!.child.killed, true);
  const { deps: okDeps, spawned: okSpawned } = makeDeps();
  await ensureA2aTunnel(target, okDeps);
  assert.equal(okSpawned.length, 1);
});
