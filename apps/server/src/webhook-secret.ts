import { eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { appSettings } from './db/schema.ts';

export const WEBHOOK_SHARED_SECRET_SETTING = 'webhook.shared_secret';

function configuredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function configuredWebhookSharedSecret(): Promise<string | undefined> {
  const envSecret = configuredString(process.env.WEBHOOK_SHARED_SECRET);
  if (envSecret) return envSecret;
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, WEBHOOK_SHARED_SECRET_SETTING)).limit(1);
  return configuredString(row?.value);
}
