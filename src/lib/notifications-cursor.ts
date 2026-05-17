import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema/tasks";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listNotificationsCursor`. The /notifications
 * page renders the composed `title`, the `createdAt` timestamp, and the
 * clickable `link`; the raw `kind` is intentionally NOT surfaced (it is
 * an internal discriminator, not user copy). `body` carries the human
 * detail for non-activity kinds (e.g. mailbox_blocked); activity rows
 * leave it null and self-describe via `title`.
 */
export interface NotificationListRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Cursor-paginated list of the caller's OWN notification feed (the
 * /notifications activity-log page; the topbar bell uses the separate
 * `listNotificationsForUser`). SESSION-scoped: every query is hard-filtered to
 * `user_id = userId` — there is no cross-user surface here (unlike the
 * admin audit log this mirrors structurally).
 *
 * Default sort: `(created_at DESC, id DESC)`. `created_at` is NOT NULL
 * (schema default `now()`). The composite index
 * `notifications_user_created_idx (user_id, created_at DESC)` backs the
 * `user_id` + `created_at` ordering; the `id` tail is the deterministic
 * tiebreaker for rows sharing a timestamp.
 *
 * Uses the canonical opaque cursor codec (`@/lib/cursors`) so the
 * StandardListPage shell forwards the token unchanged (this replaced
 * the prior page's bespoke ts:id codec, now removed).
 */
export async function listNotificationsCursor(args: {
  userId: string;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: NotificationListRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const baseWhere: SQL = eq(notifications.userId, args.userId);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere =
    parsedCursor && parsedCursor.ts !== null
      ? sql`(
          ${notifications.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
          OR (${notifications.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${notifications.id} < ${parsedCursor.id}::uuid)
        )`
      : undefined;

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        isRead: notifications.isRead,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(finalWhere)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.createdAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
