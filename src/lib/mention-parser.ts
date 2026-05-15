import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";

const MENTION_REGEX = /@([a-z][a-z0-9_.-]{0,80})/gi;

/**
 * Extract @username tokens from a note body, look them up against
 * users.username (already lowercased), and return the matching users.
 *
 * Used by activity create flow to fan out 'mention' notifications.
 */
export async function resolveMentions(
  body: string,
): Promise<{ id: string; username: string; displayName: string }[]> {
  const matches = Array.from(body.matchAll(MENTION_REGEX));
  if (matches.length === 0) return [];

  const usernames = Array.from(
    new Set(matches.map((m) => m[1].toLowerCase())),
  );

  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(inArray(users.username, usernames));
}

/**
 * Filter resolveMentions output against `notify_mentions` preference.
 * Users who disabled the preference don't get a notification.
 */
export async function filterMentionsByPref(
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: userPreferences.userId })
    .from(userPreferences)
    .where(
      and(
        inArray(userPreferences.userId, userIds),
        eq(userPreferences.notifyMentions, true),
      ),
    );
  return rows.map((r) => r.userId);
}
