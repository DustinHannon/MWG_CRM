import { z } from "zod";

/**
 * Canonical cursor codec for list pagination.
 *
 * Cursors are opaque base64url-encoded JSON tokens with shape:
 *
 *   { ts: string | null, id: string, dir: "asc" | "desc" }
 *
 * - `ts` is the ISO 8601 timestamp of the row's sort column (or `null`
 *   when that column was NULL — NULL rows sit at the end of a
 *   `NULLS LAST` ordering, so the cursor must distinguish them).
 * - `id` is the row's uuid; used as the tiebreaker when two rows share
 *   the same `ts` value.
 * - `dir` is the sort direction this cursor was issued under. Encoding
 *   the direction in the cursor lets the decoder reject a cursor that
 *   was issued against a different ordering than the caller is asking
 *   for, preventing silent drift on a re-sort.
 *
 * The codec is intentionally tolerant: malformed cursors decode to
 * `null` rather than throwing. Pages treat `null` as "no cursor" so a
 * bookmark with a stale token gracefully returns the first page.
 *
 * @see src/lib/leads.ts::listLeadsCursor for the canonical query-side
 *      consumer pattern (`(ts, id) < (cursorTs, cursorId)` with the
 *      NULL-block expansion).
 */

const cursorPayloadSchema = z.object({
  ts: z.union([z.string().datetime({ offset: true }), z.null()]),
  id: z.string().uuid(),
  dir: z.enum(["asc", "desc"]),
});

export type CursorDirection = "asc" | "desc";

interface CursorPayload {
  /** ISO 8601 timestamp string, or `null` when the sort column is NULL. */
  ts: string | null;
  /** Row uuid used as tiebreaker. */
  id: string;
  /** Sort direction this cursor was issued under. */
  dir: CursorDirection;
}

/**
 * Parsed cursor shape used by query callers. Convenience wrapper that
 * presents the timestamp as a JS `Date` instance (or `null`) so callers
 * can pass it straight to a Drizzle `sql` binding.
 */
export interface ParsedCursor {
  ts: Date | null;
  id: string;
  dir: CursorDirection;
}

/**
 * Encode a cursor payload to a URL-safe opaque string.
 *
 * The shape returned by `encodeCursor` is stable across releases — once
 * a token has been issued, the decoder must keep accepting it. Future
 * changes to the codec MUST be backward-compatible (e.g., add an
 * optional field; never rename or repurpose an existing field).
 */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor string. Returns `null` for malformed input
 * (including empty strings, non-base64url payloads, JSON parse
 * failures, schema-validation failures). Callers should treat a `null`
 * decode as "no cursor" and return the first page.
 *
 * Optionally pass `expectedDir` to reject cursors issued under a
 * different sort direction (returns `null` on mismatch).
 */
export function decodeCursor(
  raw: string | undefined | null,
  expectedDir?: CursorDirection,
): ParsedCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) return null;
  if (expectedDir && result.data.dir !== expectedDir) return null;
  const ts = result.data.ts === null ? null : new Date(result.data.ts);
  if (ts !== null && Number.isNaN(ts.getTime())) return null;
  return { ts, id: result.data.id, dir: result.data.dir };
}

/**
 * Encode a parsed cursor with a JS `Date` directly. Convenience wrapper
 * around `encodeCursor` that handles the ISO serialization.
 */
export function encodeFromValues(
  ts: Date | null,
  id: string,
  dir: CursorDirection,
): string {
  return encodeCursor({
    ts: ts ? ts.toISOString() : null,
    id,
    dir,
  });
}
