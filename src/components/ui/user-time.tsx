import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";
import {
  DEFAULT_TIME_PREFS,
  formatUserTime,
  type TimeMode,
  type TimePrefs,
} from "@/lib/format-time";

/**
 * `<UserTime>` server component. Renders a Date / ISO string
 * in the current user's timezone + date/time format pulled from
 * user_preferences. The prefs are fetched via React's `cache()` so the
 * cost is one query per request regardless of how many <UserTime>s the
 * page has.
 *
 * For client components, accept `prefs` as a prop and call
 * `formatUserTime` directly — see `src/components/ui/user-time-client.tsx`.
 */

export const getCurrentUserTimePrefs = cache(async (): Promise<TimePrefs> => {
  const session = await auth();
  if (!session?.user?.id) return DEFAULT_TIME_PREFS;
  const [row] = await db
    .select({
      timezone: userPreferences.timezone,
      dateFormat: userPreferences.dateFormat,
      timeFormat: userPreferences.timeFormat,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);
  if (!row) return DEFAULT_TIME_PREFS;
  return {
    timezone: row.timezone || DEFAULT_TIME_PREFS.timezone,
    dateFormat: row.dateFormat || DEFAULT_TIME_PREFS.dateFormat,
    timeFormat: row.timeFormat === "24h" ? "24h" : "12h",
  };
});

interface UserTimeProps {
  value: Date | string | null | undefined;
  mode?: TimeMode;
  /** Override the per-request prefs (used in print pages, tests, etc.). */
  prefs?: TimePrefs;
  className?: string;
  /**
   * When true, render an empty string instead of the em-dash placeholder
   * for null values. Useful inside conditional layouts that already hide
   * absent dates.
   */
  emptyAsBlank?: boolean;
}

export async function UserTime({
  value,
  mode = "date+time",
  prefs,
  className,
  emptyAsBlank = false,
}: UserTimeProps) {
  const p = prefs ?? (await getCurrentUserTimePrefs());
  const text = formatUserTime(value, p, mode);
  if (emptyAsBlank && text === "—") return null;
  return (
    <span suppressHydrationWarning className={className}>
      {text}
    </span>
  );
}
