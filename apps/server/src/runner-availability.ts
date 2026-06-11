import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agentRuntimes, machineRunners } from './db/schema.ts';

type RuntimeRow = typeof agentRuntimes.$inferSelect;
type MachineRunnerRow = typeof machineRunners.$inferSelect;

const RUNNER_STALE_MS = Number(process.env.RUNNER_STALE_MS ?? 90_000);

function runnerCutoff(): Date {
  return new Date(Date.now() - Math.max(15_000, RUNNER_STALE_MS));
}

export function runtimeMatchValues(adapterType: string, runtimeName?: string | null): string[] {
  return [...new Set([adapterType, runtimeName ?? '', adapterType.replace(/-/g, '_')].filter(Boolean))];
}

// Short-lived per-call cache so loops that probe many agents (best-agent selection,
// queue claiming) do not re-query the same runtime row and runner list per agent.
export type RuntimeAvailabilityCache = {
  runtimes: Map<string, RuntimeRow | null>;
  runnersByCompany: Map<string, MachineRunnerRow[]>;
};

export function createRuntimeAvailabilityCache(): RuntimeAvailabilityCache {
  return { runtimes: new Map(), runnersByCompany: new Map() };
}

export async function listOnlineRunners(companyIds: string[]) {
  if (companyIds.length === 0) return [];
  return db.select().from(machineRunners).where(and(
    inArray(machineRunners.companyId, companyIds),
    isNull(machineRunners.deletedAt),
    eq(machineRunners.status, 'online'),
    gt(machineRunners.lastHeartbeatAt, runnerCutoff()),
  ));
}

async function onlineRunnersForCompany(companyId: string, cache?: RuntimeAvailabilityCache): Promise<MachineRunnerRow[]> {
  const cached = cache?.runnersByCompany.get(companyId);
  if (cached) return cached;
  const runners = await listOnlineRunners([companyId]);
  cache?.runnersByCompany.set(companyId, runners);
  return runners;
}

export async function runnerRuntimeAvailable(input: { companyId: string; adapterType: string; runtimeName?: string | null }, cache?: RuntimeAvailabilityCache): Promise<boolean> {
  const runners = await onlineRunnersForCompany(input.companyId, cache);
  if (runners.length === 0) return true;
  const values = runtimeMatchValues(input.adapterType, input.runtimeName);
  return runners.some((runner) => {
    const supported = runner.supportedRuntimes ?? [];
    if (!values.some((value) => supported.includes(value))) return false;
    const runtimeStatuses = (runner.runtimeStatuses ?? {}) as Record<string, string>;
    const status = values.map((value) => runtimeStatuses[value]).find(Boolean);
    return !status || status === 'ready';
  });
}

export async function agentRuntimeAvailable(input: { companyId: string; runtimeId?: string | null; adapterType: string }, cache?: RuntimeAvailabilityCache): Promise<boolean> {
  if (!input.runtimeId) return true;
  let runtime: RuntimeRow | null;
  if (cache?.runtimes.has(input.runtimeId)) {
    runtime = cache.runtimes.get(input.runtimeId) ?? null;
  } else {
    const [row] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, input.runtimeId)).limit(1);
    runtime = row ?? null;
    cache?.runtimes.set(input.runtimeId, runtime);
  }
  if (!runtime || runtime.isActive === false) return false;
  return runnerRuntimeAvailable({ companyId: input.companyId, adapterType: input.adapterType, runtimeName: runtime.name }, cache);
}
