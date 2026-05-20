import { fromZonedTime, toZonedTime } from "date-fns-tz";

/**
 * Convert a date-only `YYYY-MM-DD` value to the UTC instant for
 * **00:00 in the user's timezone** — the same instant the canonical
 * client paths (`entity-tasks-quick-add`, `task-edit-dialog`) store by
 * doing `new Date("${date}T00:00:00")` in the browser (Central), and
 * the exact inverse of the `formatUserTime` display path. `fromZonedTime`
 * treats the zoneless wall clock as local time in `timeZone` and is
 * DST-aware, so this is correct under any server `TZ` (Vercel is
 * `TZ=UTC`) for both CDT and CST dates. `timeZone` MUST be the same
 * source the display uses (`getCurrentUserTimePrefs().timezone`, default
 * `America/Chicago`) so entry → store → render round-trips.
 *
 * A non-`YYYY-MM-DD` value (the `Due date` input is `type="date"`, so
 * this should not occur) or an unparseable one yields `null`, mirroring
 * `parseOccurredAt` — never an Invalid Date the column rejects with a 500.
 */
export function parseDueDateInUserTz(
  value: string | undefined,
  timeZone: string,
): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = fromZonedTime(`${value}T00:00:00`, timeZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface SnoozePresets {
  laterToday: Date;
  tomorrowMorning: Date;
  nextMondayMorning: Date;
  twoWeeks: Date;
}

/**
 * Compute snooze targets relative to `now` in the user's timezone, then
 * convert back to UTC instants for storage. All targets are DST-aware
 * via `fromZonedTime` so a Central-tz user crossing the spring-forward
 * boundary still lands at the wall-clock time they expect (9 AM stays
 * 9 AM, not 8 or 10).
 *
 * - laterToday: now + 3h OR 16:00 in user tz, whichever is LATER.
 * - tomorrowMorning: next calendar day at 09:00 in user tz.
 * - nextMondayMorning: next Monday at 09:00 in user tz (if today is Mon,
 *   jump 7 days).
 * - twoWeeks: now + 14 days at 09:00 in user tz.
 */
export function snoozePresets(now: Date, timeZone: string): SnoozePresets {
  const zoned = toZonedTime(now, timeZone);

  const year = zoned.getFullYear();
  const month = zoned.getMonth();
  const day = zoned.getDate();
  const dow = zoned.getDay();

  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (y: number, m0: number, d: number, h: number) =>
    `${y}-${pad(m0 + 1)}-${pad(d)}T${pad(h)}:00:00`;

  const plus3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const sixteenLocal = fromZonedTime(fmt(year, month, day, 16), timeZone);
  const laterToday = plus3.getTime() > sixteenLocal.getTime() ? plus3 : sixteenLocal;

  const tomorrow = new Date(year, month, day + 1);
  const tomorrowMorning = fromZonedTime(
    fmt(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9),
    timeZone,
  );

  const daysUntilMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  const nextMon = new Date(year, month, day + daysUntilMonday);
  const nextMondayMorning = fromZonedTime(
    fmt(nextMon.getFullYear(), nextMon.getMonth(), nextMon.getDate(), 9),
    timeZone,
  );

  const twoWeeksDate = new Date(year, month, day + 14);
  const twoWeeks = fromZonedTime(
    fmt(twoWeeksDate.getFullYear(), twoWeeksDate.getMonth(), twoWeeksDate.getDate(), 9),
    timeZone,
  );

  return { laterToday, tomorrowMorning, nextMondayMorning, twoWeeks };
}
