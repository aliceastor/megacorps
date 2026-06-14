import { db } from './db/client.ts';
import { appSettings } from './db/schema.ts';
import { eq } from 'drizzle-orm';

export const KANBAN_TASK_TIMEOUT_SETTING = 'kanban.task_timeout_seconds';
export const MIN_KANBAN_TASK_TIMEOUT_SECONDS = 30;
export const MAX_KANBAN_TASK_TIMEOUT_SECONDS = 14_400;

function defaultKanbanTaskTimeoutSeconds(): number {
  const raw = process.env.KANBAN_TASK_TIMEOUT_SECONDS ?? process.env.DISPATCH_TASK_TIMEOUT_SECONDS;
  return normalizeKanbanTaskTimeoutSeconds(raw, 300);
}

export function normalizeKanbanTaskTimeoutSeconds(value: unknown, fallback = defaultKanbanTaskTimeoutSeconds()): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_KANBAN_TASK_TIMEOUT_SECONDS, Math.max(MIN_KANBAN_TASK_TIMEOUT_SECONDS, Math.trunc(parsed)));
}

export async function readKanbanTaskTimeoutSeconds(): Promise<number> {
  const fallback = defaultKanbanTaskTimeoutSeconds();
  await db.insert(appSettings).values({ key: KANBAN_TASK_TIMEOUT_SETTING, value: String(fallback) }).onConflictDoNothing();
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KANBAN_TASK_TIMEOUT_SETTING)).limit(1);
  return normalizeKanbanTaskTimeoutSeconds(row?.value, fallback);
}

export async function setKanbanTaskTimeoutSeconds(value: number): Promise<number> {
  const normalized = normalizeKanbanTaskTimeoutSeconds(value);
  await db.insert(appSettings).values({ key: KANBAN_TASK_TIMEOUT_SETTING, value: String(normalized) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: String(normalized), updatedAt: new Date() } });
  return normalized;
}
