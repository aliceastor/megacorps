import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { notificationReads, notifications } from './db/schema.ts';
import { publishLiveEvent } from './live.ts';

export type NotifyInput = {
  companyId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  cardId?: string | null;
  agentId?: string | null;
};

const DEDUPE_WINDOW_MINUTES = 30;

// Company-scoped notification feed. Read state is tracked per user in
// notification_reads. Repeated identical events inside the dedupe window collapse
// into the existing row so a flapping card does not flood the bell.
export async function notify(input: NotifyInput): Promise<void> {
  try {
    if (input.entityId) {
      const [recent] = await db.select({ id: notifications.id }).from(notifications).where(and(
        eq(notifications.companyId, input.companyId),
        eq(notifications.type, input.type),
        eq(notifications.entityId, input.entityId),
        drizzleSql`${notifications.createdAt} > now() - interval '${drizzleSql.raw(String(DEDUPE_WINDOW_MINUTES))} minutes'`,
      )).limit(1);
      if (recent) return;
    }
    const [row] = await db.insert(notifications).values({
      companyId: input.companyId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      cardId: input.cardId ?? null,
      agentId: input.agentId ?? null,
    }).returning();
    if (row) {
      publishLiveEvent({ type: 'notification.created', companyId: input.companyId, entityType: 'notification', entityId: row.id, cardId: input.cardId ?? null });
    }
  } catch {
    // Notifications are best effort and must never break the producing flow.
  }
}

export async function listNotifications(userId: string, companyIds: string[], limit = 50) {
  if (companyIds.length === 0) return [];
  const rows = await db.select({
    notification: notifications,
    readAt: notificationReads.readAt,
  }).from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, userId)))
    .where(inArray(notifications.companyId, companyIds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row.notification, readAt: row.readAt ?? null }));
}

export async function unreadNotificationCount(userId: string, companyIds: string[]): Promise<number> {
  if (companyIds.length === 0) return 0;
  const [row] = await db.select({ count: drizzleSql<number>`count(*)::int` }).from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, userId)))
    .where(and(inArray(notifications.companyId, companyIds), isNull(notificationReads.readAt)));
  return Number(row?.count ?? 0);
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  await db.insert(notificationReads).values({ notificationId, userId }).onConflictDoNothing();
}

export async function markAllNotificationsRead(userId: string, companyIds: string[]): Promise<number> {
  if (companyIds.length === 0) return 0;
  const unread = await db.select({ id: notifications.id }).from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, userId)))
    .where(and(inArray(notifications.companyId, companyIds), isNull(notificationReads.readAt)))
    .limit(500);
  if (unread.length === 0) return 0;
  await db.insert(notificationReads).values(unread.map((row) => ({ notificationId: row.id, userId }))).onConflictDoNothing();
  return unread.length;
}
