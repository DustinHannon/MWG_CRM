import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema/tasks";
import { logger } from "@/lib/logger";

interface CreateNotificationInput {
  userId: string;
  kind: "task_assigned" | "task_due" | "mention" | "saved_search";
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Insert a single notification. Bell icon picks it up on next poll/render.
 * Falls back silently on failure — a missed notification shouldn't fail
 * the parent action.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  try {
    await db.insert(notifications).values({
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    });
  } catch (err) {
    logger.error("notifications.create_failed", {
      userId: input.userId,
      kind: input.kind,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function createNotifications(
  list: CreateNotificationInput[],
): Promise<void> {
  if (list.length === 0) return;
  try {
    await db.insert(notifications).values(
      list.map((n) => ({
        userId: n.userId,
        kind: n.kind,
        title: n.title,
        body: n.body ?? null,
        link: n.link ?? null,
      })),
    );
  } catch (err) {
    logger.error("notifications.bulk_create_failed", {
      count: list.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listNotificationsForUser(
  userId: string,
  limit = 20,
) {
  // Phase 9C — verified cursor-friendly: queries the composite partial
  // index `notifications_user_unread_idx (user_id, is_read, created_at DESC)`
  // and is bounded by `limit`, so even a high-volume user (100k+
  // notifications) seeks the leading rows by user_id and stops early.
  // No cursor parameter is exposed because the bell + /notifications
  // page UX is "show recent N"; pagination beyond the top N would
  // need a redesign (mark-read-as-you-scroll behaviour, etc).
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/**
 * Phase 9C — cursor-paginated variant for the /notifications page so
 * power users with 100k+ notifications can scroll past the top batch.
 * The /notifications page calls this; the bell popover keeps the
 * unbounded `listNotificationsForUser(userId, 10)` form because it's
 * always capped at 10.
 */
export interface NotificationCursor {
  ts: Date;
  id: string;
}
export function parseNotificationCursor(raw: string | undefined): NotificationCursor | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const tsPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idPart)) {
    return null;
  }
  const d = new Date(tsPart);
  if (Number.isNaN(d.getTime())) return null;
  return { ts: d, id: idPart };
}
export function encodeNotificationCursor(ts: Date, id: string): string {
  return `${ts.toISOString()}:${id}`;
}

export async function listNotificationsPage(
  userId: string,
  cursor: string | undefined,
  pageSize = 50,
): Promise<{ rows: typeof notifications.$inferSelect[]; nextCursor: string | null }> {
  const parsed = parseNotificationCursor(cursor);
  const wheres = [eq(notifications.userId, userId)];
  if (parsed) {
    wheres.push(
      sql`(
        ${notifications.createdAt} < ${parsed.ts.toISOString()}::timestamptz
        OR (${notifications.createdAt} = ${parsed.ts.toISOString()}::timestamptz AND ${notifications.id} < ${parsed.id}::uuid)
      )`,
    );
  }
  const rowsRaw = await db
    .select()
    .from(notifications)
    .where(and(...wheres))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(pageSize + 1);
  if (rowsRaw.length <= pageSize) {
    return { rows: rowsRaw, nextCursor: null };
  }
  const rows = rowsRaw.slice(0, pageSize);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: encodeNotificationCursor(last.createdAt, last.id),
  };
}

export async function countUnread(userId: string): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );
  return r[0]?.n ?? 0;
}

export async function markAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );
}

export async function markRead(id: string, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}
