import { db } from './db/client.ts';
import { appSettings } from './db/schema.ts';
import { eq } from 'drizzle-orm';

export const KANBAN_TASK_TIMEOUT_SETTING = 'kanban.task_timeout_seconds';
export const CHAT_TASK_TIMEOUT_SETTING = 'chat.task_timeout_seconds';
export const MIN_KANBAN_TASK_TIMEOUT_SECONDS = 30;
export const MAX_KANBAN_TASK_TIMEOUT_SECONDS = 14_400;

function clampTimeoutSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_KANBAN_TASK_TIMEOUT_SECONDS, Math.max(MIN_KANBAN_TASK_TIMEOUT_SECONDS, Math.trunc(parsed)));
}

async function readTimeoutSetting(key: string, fallback: number): Promise<number> {
  await db.insert(appSettings).values({ key, value: String(fallback) }).onConflictDoNothing();
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return clampTimeoutSeconds(row?.value, fallback);
}

async function writeTimeoutSetting(key: string, value: number, fallback: number): Promise<number> {
  const normalized = clampTimeoutSeconds(value, fallback);
  await db.insert(appSettings).values({ key, value: String(normalized) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: String(normalized), updatedAt: new Date() } });
  return normalized;
}

function defaultKanbanTaskTimeoutSeconds(): number {
  const raw = process.env.KANBAN_TASK_TIMEOUT_SECONDS ?? process.env.DISPATCH_TASK_TIMEOUT_SECONDS;
  return clampTimeoutSeconds(raw, 300);
}

// Direct Chat used to be pinned at 300s in chat.ts with no way to raise it, so
// a slow model could never finish a turn. It gets its own setting rather than
// borrowing the Kanban one: a chat turn and an autonomous card run have very
// different patience budgets.
function defaultChatTaskTimeoutSeconds(): number {
  return clampTimeoutSeconds(process.env.CHAT_TASK_TIMEOUT_SECONDS, 300);
}

export function normalizeKanbanTaskTimeoutSeconds(value: unknown, fallback = defaultKanbanTaskTimeoutSeconds()): number {
  return clampTimeoutSeconds(value, fallback);
}

export function normalizeChatTaskTimeoutSeconds(value: unknown, fallback = defaultChatTaskTimeoutSeconds()): number {
  return clampTimeoutSeconds(value, fallback);
}

export async function readKanbanTaskTimeoutSeconds(): Promise<number> {
  return readTimeoutSetting(KANBAN_TASK_TIMEOUT_SETTING, defaultKanbanTaskTimeoutSeconds());
}

export async function setKanbanTaskTimeoutSeconds(value: number): Promise<number> {
  return writeTimeoutSetting(KANBAN_TASK_TIMEOUT_SETTING, value, defaultKanbanTaskTimeoutSeconds());
}

export async function readChatTaskTimeoutSeconds(): Promise<number> {
  return readTimeoutSetting(CHAT_TASK_TIMEOUT_SETTING, defaultChatTaskTimeoutSeconds());
}

export async function setChatTaskTimeoutSeconds(value: number): Promise<number> {
  return writeTimeoutSetting(CHAT_TASK_TIMEOUT_SETTING, value, defaultChatTaskTimeoutSeconds());
}
