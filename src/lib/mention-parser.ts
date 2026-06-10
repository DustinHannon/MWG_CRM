import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";

// Require a boundary before '@' so we only match deliberate @mentions, not the
// local-after-@ part of an email address or other inline '@'-containing token.
// The leading group is non-captured and excludes username chars (and '@'/'.'/'-')
// so 'someone@dustin.hannon' does not capture 'dustin.hannon' as a mention.
const MENTION_REGEX = /(?:^|[^a-z0-9_.@-])@([a-z][a-z0-9_.-]{0,80})/gi;

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
    new Set(
      matches
        // Strip a trailing '.'/'-' the regex may have captured from
        // sentence punctuation (e.g. '@sales.' -> 'sales').
        .map((m) => m[1].toLowerCase().replace(/[.-]+$/, ""))
        .filter((u) => u.length > 0),
    ),
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
 *
 * The column default is `true`, but that default only materializes once a
 * preferences row exists. A missing row therefore means "default on" — so we
 * exclude only users with an explicit notify_mentions=false row, rather than
 * requiring a notify_mentions=true row to be present (which would silently
 * drop anyone lacking a row).
 */
export async function filterMentionsByPref(
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const optedOut = await db
    .select({ userId: userPreferences.userId })
    .from(userPreferences)
    .where(
      and(
        inArray(userPreferences.userId, userIds),
        eq(userPreferences.notifyMentions, false),
      ),
    );
  const optedOutIds = new Set(optedOut.map((r) => r.userId));
  return userIds.filter((id) => !optedOutIds.has(id));
}
