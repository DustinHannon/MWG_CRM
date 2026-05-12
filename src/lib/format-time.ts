import { formatInTimeZone } from "date-fns-tz";
import { formatDistanceToNow } from "date-fns";

/**
 * pure timestamp formatter. Centralizes the user-prefs date /
 * time / timezone choices so every UI path produces the same output for
 * the same instant.
 */

export type TimePrefs = {
  timezone: string;
  dateFormat: string;
  timeFormat: "12h" | "24h";
};

export type TimeMode = "date" | "time" | "date+time" | "relative";

export const DEFAULT_TIME_PREFS: TimePrefs = {
  timezone: "America/Chicago",
  dateFormat: "MM/DD/YYYY",
  timeFormat: "12h",
};

const DATE_PATTERNS: Record<string, string> = {
  "MM/DD/YYYY": "MM/dd/yyyy",
  "DD/MM/YYYY": "dd/MM/yyyy",
  "YYYY-MM-DD": "yyyy-MM-dd",
};

/**
 * Format a Date / ISO-string in the user's preferred timezone + format.
 *
 * Returns an em-dash for null / undefined / unparseable values so callers
 * don't need null-coalescing dance at every call site.
 *
 * Relative mode uses date-fns' `formatDistanceToNow` and is therefore
 * locale-agnostic — no timezone math needed.
 */
export function formatUserTime(
  value: Date | string | null | undefined,
  prefs: TimePrefs = DEFAULT_TIME_PREFS,
  mode: TimeMode = "date+time",
): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  if (mode === "relative") {
    return formatDistanceToNow(d, { addSuffix: true });
  }

  const datePattern = DATE_PATTERNS[prefs.dateFormat] ?? "MM/dd/yyyy";
  const timePattern = prefs.timeFormat === "24h" ? "HH:mm" : "h:mm a";

  const pattern =
    mode === "date"
      ? datePattern
      : mode === "time"
        ? timePattern
        : `${datePattern} ${timePattern}`;

  try {
    return formatInTimeZone(d, prefs.timezone || "America/Chicago", pattern);
  } catch {
    // Bad TZ string. Fall back to the default zone.
    return formatInTimeZone(d, "America/Chicago", pattern);
  }
}
