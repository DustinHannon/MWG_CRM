// multi-line activity column parser.
//
// Real CRM exports cram phone calls, meetings, notes, and emails into
// free-text columns shaped like:
//
// [2026-01-29 02:54 PM UTC] Dental Quote
// Outgoing | Duration: 30 min | By: Tanzania Griffith
// lead called wanting BEST dental plan w/o copays
//
// [2026-02-15 10:30 AM CT] Follow-up
// Outgoing | Left Voicemail | By: Tanzania Griffith
//
// This module turns the column text into ParsedActivity[] for ingestion.
// Pure function; no DB access. Caller resolves ParsedActivity.metadata.byName
// to a CRM user separately (see resolve-users.ts).

export type ActivityKind = "call" | "meeting" | "note" | "email";

export interface ParsedActivity {
  kind: ActivityKind;
  occurredAt: Date;
  subject: string | null;
  body: string;
  metadata: {
    direction?: "outgoing" | "incoming";
    outcome?: string;
    durationMin?: number;
    byName?: string;
    attendees?: string[];
    endAt?: Date;
    status?: string;
    fromEmail?: string;
    toEmail?: string;
  };
}

export interface ParseWarning {
  message: string;
  line?: number;
}

export interface ParseResult {
  activities: ParsedActivity[];
  warnings: ParseWarning[];
}

const MAX_ACTIVITIES_PER_COLUMN = 200;

// Allowed timezone abbreviations and their UTC offsets in minutes.
// We normalise everything to a real Date by adding the offset back to UTC.
const TZ_OFFSET_MIN: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  CT: -6 * 60, // ambiguous; assume CST and warn
  MST: -7 * 60,
  MDT: -6 * 60,
  MT: -7 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
  PT: -8 * 60,
  AKDT: -8 * 60,
  AKST: -9 * 60,
  HST: -10 * 60,
};

const TIMESTAMP_RE =
  /^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,4})\]\s*(.*)$/;

// Notes inline form: "[ts] — by First Last body text..."
//
// "by-name" is taken as the first TWO whitespace-separated tokens
// after "by ". This matches the typical D365 dump shape (Tanzania
// Griffith / Rafael Somarriba). Single-token names degenerate to
// no-match here and fall through to the bracketed-timestamp +
// indented-body branch with empty body — acceptable because real
// CRM exports use first-and-last name. The body capture is optional;
// notes that are just "[ts] — by Name" with nothing after parse with
// empty body.
const NOTE_INLINE_RE =
  /^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,4})\]\s*[—-]\s*by\s+(\S+\s+\S+)(?:\s+(.+))?$/;

interface ParsedTimestamp {
  date: Date;
  trailing: string;
  warning?: string;
}

function parseTimestamp(line: string): ParsedTimestamp | null {
  const m = TIMESTAMP_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, h12, mi, ampm, tz, trailing] = m;
  let hour = parseInt(h12, 10) % 12;
  if (ampm === "PM") hour += 12;
  const minute = parseInt(mi, 10);
  const offsetMin = TZ_OFFSET_MIN[tz];
  const utcMs = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    hour,
    minute,
  );
  let warning: string | undefined;
  if (offsetMin === undefined) {
    warning = `Unknown timezone "${tz}" — interpreting as UTC.`;
  }
  // The timestamp text is local-to-tz. UTC = local - offset.
  const finalMs = utcMs - (offsetMin ?? 0) * 60_000;
  return { date: new Date(finalMs), trailing: trailing.trim(), warning };
}

function parseNoteInline(line: string): {
  date: Date;
  byName: string;
  body: string;
  warning?: string;
} | null {
  const m = NOTE_INLINE_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, h12, mi, ampm, tz, byName, body] = m;
  let hour = parseInt(h12, 10) % 12;
  if (ampm === "PM") hour += 12;
  const minute = parseInt(mi, 10);
  const offsetMin = TZ_OFFSET_MIN[tz];
  const utcMs = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    hour,
    minute,
  );
  let warning: string | undefined;
  if (offsetMin === undefined) {
    warning = `Unknown timezone "${tz}" — interpreting as UTC.`;
  }
  const finalMs = utcMs - (offsetMin ?? 0) * 60_000;
  return {
    date: new Date(finalMs),
    byName: byName.trim(),
    body: (body ?? "").trim(),
    warning,
  };
}

/**
 * Strip a single leading " " (two-space) indent if present. Used when
 * collecting body lines so that a quoted indent inside the cell is
 * preserved relative to the activity's overall indent level.
 */
function stripBodyIndent(line: string): string {
  if (line.startsWith("  ")) return line.slice(2);
  if (line.startsWith("\t")) return line.slice(1);
  return line;
}

interface CallMetaParse {
  direction?: "outgoing" | "incoming";
  outcome?: string;
  durationMin?: number;
  byName?: string;
  warning?: string;
}

function parseCallOrEmailMetaLine(line: string): CallMetaParse {
  // Examples:
  // "Outgoing | Duration: 30 min | By: Tanzania Griffith"
  // "Outgoing | Left Voicemail | By: Tanzania Griffith"
  // "Incoming | No Answer | By: Tanzania Griffith"
  // "Outgoing | Connected | By: Tanzania Griffith"
  const segments = line.split("|").map((s) => s.trim());
  const result: CallMetaParse = {};
  for (const seg of segments) {
    if (!seg) continue;
    const lower = seg.toLowerCase();
    if (lower === "outgoing" || lower === "incoming") {
      result.direction = lower as "outgoing" | "incoming";
      continue;
    }
    const durMatch = /^Duration:\s*(\d+)\s*min/i.exec(seg);
    if (durMatch) {
      result.durationMin = parseInt(durMatch[1], 10);
      continue;
    }
    const byMatch = /^By:\s*(.+)$/i.exec(seg);
    if (byMatch) {
      result.byName = byMatch[1].trim();
      continue;
    }
    // Anything not matched is treated as outcome (e.g., "Left Voicemail",
    // "No Answer", "Connected"). Last one wins if multiple — unusual.
    if (!result.outcome) {
      result.outcome = seg;
    }
  }
  return result;
}

interface MeetingMetaParse {
  status?: string;
  endAt?: Date;
  durationMin?: number;
  byName?: string;
  warning?: string;
}

function parseMeetingMetaLine(line: string): MeetingMetaParse {
  // Example: "Status: Completed | End: 2024-12-16 05:00 PM UTC | Duration: 30 min | Owner: Tanzania Griffith"
  const segments = line.split("|").map((s) => s.trim());
  const result: MeetingMetaParse = {};
  for (const seg of segments) {
    if (!seg) continue;
    const statusMatch = /^Status:\s*(.+)$/i.exec(seg);
    if (statusMatch) {
      result.status = statusMatch[1].trim();
      continue;
    }
    const endMatch = /^End:\s*(.+)$/i.exec(seg);
    if (endMatch) {
      const ts = parseTimestamp(`[${endMatch[1].trim()}] `);
      if (ts) result.endAt = ts.date;
      continue;
    }
    const durMatch = /^Duration:\s*(\d+)\s*min/i.exec(seg);
    if (durMatch) {
      result.durationMin = parseInt(durMatch[1], 10);
      continue;
    }
    const ownerMatch = /^Owner:\s*(.+)$/i.exec(seg);
    if (ownerMatch) {
      result.byName = ownerMatch[1].trim();
      continue;
    }
  }
  return result;
}

function parseEmailMetaLine(line: string): {
  fromEmail?: string;
  toEmail?: string;
} {
  // Example: "From: a@x.com | To: b@y.com"
  const segments = line.split("|").map((s) => s.trim());
  const result: { fromEmail?: string; toEmail?: string } = {};
  for (const seg of segments) {
    const fromMatch = /^From:\s*(.+)$/i.exec(seg);
    if (fromMatch) {
      result.fromEmail = fromMatch[1].trim();
      continue;
    }
    const toMatch = /^To:\s*(.+)$/i.exec(seg);
    if (toMatch) {
      result.toEmail = toMatch[1].trim();
      continue;
    }
  }
  return result;
}

function parseAttendeesLine(line: string): string[] | null {
  const m = /^Attendees:\s*(.+)$/i.exec(line.trim());
  if (!m) return null;
  const raw = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Dedup case-insensitively while preserving first-seen casing.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function detectAttendeesLine(line: string): boolean {
  return /^\s*Attendees:/i.test(line);
}

function detectCallOrEmailMeta(line: string): boolean {
  return /^\s*(Outgoing|Incoming)\b/i.test(line);
}

function detectMeetingMeta(line: string): boolean {
  return /^\s*Status:/i.test(line);
}

function detectEmailMeta(line: string): boolean {
  return /^\s*From:/i.test(line);
}

/**
 * Parse a multi-line activity-column cell value into structured
 * activities. The cell content can be one or more bracketed-timestamp
 * activities; a blank line or the next bracketed-timestamp ends the
 * current activity.
 */
export function parseActivityColumn(
  text: string | null | undefined,
  kind: ActivityKind,
): ParseResult {
  const warnings: ParseWarning[] = [];
  if (text === null || text === undefined) return { activities: [], warnings };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { activities: [], warnings };

  const lines = trimmed.split(/\r?\n/);
  const activities: ParsedActivity[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    if (kind === "note") {
      // Notes can be either an inline "[ts] — by Name body" form or a
      // bracketed-timestamp + indented body form.
      const inline = parseNoteInline(line);
      if (inline) {
        if (inline.warning) warnings.push({ message: inline.warning, line: i + 1 });
        // Body may continue on subsequent indented lines.
        const bodyParts = [inline.body];
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j];
          if (next.trim().length === 0) break;
          if (parseTimestamp(next)) break;
          if (parseNoteInline(next)) break;
          bodyParts.push(stripBodyIndent(next).trim());
          j += 1;
        }
        activities.push({
          kind: "note",
          occurredAt: inline.date,
          subject: null,
          body: bodyParts.join("\n"),
          metadata: { byName: inline.byName },
        });
        i = j;
        continue;
      }
    }

    const ts = parseTimestamp(line);
    if (!ts) {
      // Stray content. Most likely a label that the section splitter
      // shouldn't have handed us. Warn and skip.
      warnings.push({
        message: `Skipped unrecognized line: ${line.slice(0, 80)}`,
        line: i + 1,
      });
      i += 1;
      continue;
    }
    if (ts.warning) warnings.push({ message: ts.warning, line: i + 1 });

    const subject = ts.trailing.length > 0 ? ts.trailing : null;
    const metadata: ParsedActivity["metadata"] = {};
    const bodyParts: string[] = [];

    let j = i + 1;
    // Read metadata lines (any combination of meta-line types) until we
    // hit body / blank / next activity.
    while (j < lines.length) {
      const next = lines[j];
      const trimmedNext = next.trim();
      if (trimmedNext.length === 0) break;
      if (parseTimestamp(next) || parseNoteInline(next)) break;

      if ((kind === "call" || kind === "email") && detectCallOrEmailMeta(next)) {
        const meta = parseCallOrEmailMetaLine(trimmedNext);
        if (meta.direction) metadata.direction = meta.direction;
        if (meta.durationMin !== undefined)
          metadata.durationMin = meta.durationMin;
        if (meta.byName) metadata.byName = meta.byName;
        if (meta.outcome) metadata.outcome = meta.outcome;
        j += 1;
        continue;
      }

      if (kind === "email" && detectEmailMeta(next)) {
        const m = parseEmailMetaLine(trimmedNext);
        if (m.fromEmail) metadata.fromEmail = m.fromEmail;
        if (m.toEmail) metadata.toEmail = m.toEmail;
        j += 1;
        continue;
      }

      if (kind === "meeting" && detectMeetingMeta(next)) {
        const m = parseMeetingMetaLine(trimmedNext);
        if (m.status) metadata.status = m.status;
        if (m.endAt) metadata.endAt = m.endAt;
        if (m.durationMin !== undefined) metadata.durationMin = m.durationMin;
        if (m.byName) metadata.byName = m.byName;
        j += 1;
        continue;
      }

      if (kind === "meeting" && detectAttendeesLine(next)) {
        const attendees = parseAttendeesLine(next);
        if (attendees) metadata.attendees = attendees;
        j += 1;
        continue;
      }

      // Otherwise it's body content.
      bodyParts.push(stripBodyIndent(next).trim());
      j += 1;
    }

    activities.push({
      kind,
      occurredAt: ts.date,
      subject,
      body: bodyParts.join("\n"),
      metadata,
    });
    i = j;
  }

  // Cap at 200 most-recent activities.
  if (activities.length > MAX_ACTIVITIES_PER_COLUMN) {
    const original = activities.length;
    activities.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    activities.length = MAX_ACTIVITIES_PER_COLUMN;
    warnings.push({
      message: `Truncated to ${MAX_ACTIVITIES_PER_COLUMN} most-recent activities (parsed ${original}).`,
    });
  }

  return { activities, warnings };
}

/**
 * Convenience: parse all four activity columns for one row, in one call.
 */
export function parseAllActivityColumns(args: {
  notes?: string | null;
  phoneCalls?: string | null;
  meetings?: string | null;
  emails?: string | null;
}): ParseResult {
  const allWarnings: ParseWarning[] = [];
  const allActivities: ParsedActivity[] = [];

  const sections: Array<[string | null | undefined, ActivityKind]> = [
    [args.notes, "note"],
    [args.phoneCalls, "call"],
    [args.meetings, "meeting"],
    [args.emails, "email"],
  ];
  for (const [text, kind] of sections) {
    const r = parseActivityColumn(text, kind);
    allActivities.push(...r.activities);
    allWarnings.push(...r.warnings);
  }

  // Re-cap across the union.
  if (allActivities.length > MAX_ACTIVITIES_PER_COLUMN) {
    const original = allActivities.length;
    allActivities.sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
    );
    allActivities.length = MAX_ACTIVITIES_PER_COLUMN;
    allWarnings.push({
      message: `Combined activities exceeded the per-lead cap; kept the ${MAX_ACTIVITIES_PER_COLUMN} most-recent (parsed ${original}).`,
    });
  }

  return { activities: allActivities, warnings: allWarnings };
}
