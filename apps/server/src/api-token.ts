import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from './db/client.ts';
import { appSettings, users } from './db/schema.ts';

export const API_TOKEN_HASH_SETTING = 'auth.api_token_hash';
export const API_TOKEN_OWNER_SETTING = 'auth.api_token_owner_user_id';
export const API_TOKEN_PREVIEW_SETTING = 'auth.api_token_preview';

export type ApiTokenSettings = {
  configured: boolean;
  preview: string | null;
  updatedAt: Date | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
};

export function generateApiToken(): string {
  return `mca_${randomBytes(32).toString('base64url')}`;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function previewApiToken(token: string): string {
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function settingRows(keys: string[]) {
  if (keys.length === 0) return new Map<string, typeof appSettings.$inferSelect>();
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, keys));
  return new Map(rows.map((row) => [row.key, row]));
}

export async function readApiTokenSettings(): Promise<ApiTokenSettings> {
  const rows = await settingRows([API_TOKEN_HASH_SETTING, API_TOKEN_OWNER_SETTING, API_TOKEN_PREVIEW_SETTING]);
  const hash = rows.get(API_TOKEN_HASH_SETTING);
  const ownerUserId = rows.get(API_TOKEN_OWNER_SETTING)?.value ?? null;
  const preview = rows.get(API_TOKEN_PREVIEW_SETTING)?.value ?? null;
  const [owner] = ownerUserId ? await db.select({ email: users.email }).from(users).where(eq(users.id, ownerUserId)).limit(1) : [];
  return {
    configured: Boolean(hash?.value),
    preview,
    updatedAt: hash?.updatedAt ?? null,
    ownerUserId,
    ownerEmail: owner?.email ?? null,
  };
}

export async function rotateApiToken(ownerUserId: string): Promise<{ token: string; settings: ApiTokenSettings }> {
  const token = generateApiToken();
  const now = new Date();
  const values = [
    { key: API_TOKEN_HASH_SETTING, value: hashApiToken(token), updatedAt: now },
    { key: API_TOKEN_OWNER_SETTING, value: ownerUserId, updatedAt: now },
    { key: API_TOKEN_PREVIEW_SETTING, value: previewApiToken(token), updatedAt: now },
  ];
  for (const value of values) {
    await db.insert(appSettings).values(value)
      .onConflictDoUpdate({ target: appSettings.key, set: { value: value.value, updatedAt: now } });
  }
  return { token, settings: await readApiTokenSettings() };
}

export async function revokeApiToken(): Promise<ApiTokenSettings> {
  await db.delete(appSettings).where(inArray(appSettings.key, [
    API_TOKEN_HASH_SETTING,
    API_TOKEN_OWNER_SETTING,
    API_TOKEN_PREVIEW_SETTING,
  ]));
  return readApiTokenSettings();
}

export async function authenticateApiToken(token: string): Promise<typeof users.$inferSelect | null> {
  const rows = await settingRows([API_TOKEN_HASH_SETTING, API_TOKEN_OWNER_SETTING]);
  const hash = rows.get(API_TOKEN_HASH_SETTING)?.value;
  const ownerUserId = rows.get(API_TOKEN_OWNER_SETTING)?.value;
  if (!hash || !ownerUserId) return null;
  const providedHash = hashApiToken(token);
  if (!safeEqual(providedHash, hash)) return null;
  const [user] = await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);
  if (!user || user.status === 'disabled') return null;
  return user;
}

export const apiTokenInternals = { hashApiToken, previewApiToken };
