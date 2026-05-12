"use client";

import {
  formatUserTime,
  type TimeMode,
  type TimePrefs,
} from "@/lib/format-time";

/**
 * client-side `<UserTime>`. Identical to the server component
 * except `prefs` is required (client components can't reach into the DB
 * cache). Pass it down from the closest server boundary.
 */
interface UserTimeClientProps {
  value: Date | string | null | undefined;
  prefs: TimePrefs;
  mode?: TimeMode;
  className?: string;
  emptyAsBlank?: boolean;
}

export function UserTimeClient({
  value,
  prefs,
  mode = "date+time",
  className,
  emptyAsBlank = false,
}: UserTimeClientProps) {
  const text = formatUserTime(value, prefs, mode);
  if (emptyAsBlank && text === "—") return null;
  return (
    <span suppressHydrationWarning className={className}>
      {text}
    </span>
  );
}
