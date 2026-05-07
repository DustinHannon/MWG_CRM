import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema/tasks";

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
    console.error("[notifications] create failed", err);
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
    console.error("[notifications] bulk create failed", err);
  }
}

export async function listNotificationsForUser(
  userId: string,
  limit = 20,
) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
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

void sql;
