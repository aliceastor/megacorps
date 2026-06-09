import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agentRuntimes, machineRunners } from './db/schema.ts';

const RUNNER_STALE_MS = Number(process.env.RUNNER_STALE_MS ?? 90_000);

function runnerCutoff(): Date {
  return new Date(Date.now() - Math.max(15_000, RUNNER_STALE_MS));
}

export function runtimeMatchValues(adapterType: string, runtimeName?: string | null): string[] {
  return [...new Set([adapterType, runtimeName ?? '', adapterType.replace(/-/g, '_')].filter(Boolean))];
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

export async function runnerRuntimeAvailable(input: { companyId: string; adapterType: string; runtimeName?: string | null }): Promise<boolean> {
  const runners = await listOnlineRunners([input.companyId]);
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

export async function agentRuntimeAvailable(input: { companyId: string; runtimeId?: string | null; adapterType: string }): Promise<boolean> {
  if (!input.runtimeId) return true;
  const [runtime] = await db.select().from(agentRuntimes).where(eq(agentRuntimes.id, input.runtimeId)).limit(1);
  if (!runtime || runtime.isActive === false) return false;
  return runnerRuntimeAvailable({ companyId: input.companyId, adapterType: input.adapterType, runtimeName: runtime.name });
}
