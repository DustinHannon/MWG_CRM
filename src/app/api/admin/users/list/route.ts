import { NextResponse, type NextRequest } from "next/server";
import { and, asc, desc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { withInternalListApi } from "@/lib/api/internal-list";
import { decodeCursor, encodeFromValues } from "@/lib/cursors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_JIT_FILTER = "jit-7d";
const PAGE_SIZE = 50;

/**
 * Internal cursor-paginated list endpoint backing the admin users list.
 * Session-authenticated. Admin-only.
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches displayName / email / username).
 *   ?recent=jit-7d     — restrict to JIT-provisioned users from the last 7 days.
 *
 * Default sort: `(display_name ASC, id ASC)` — a fully stable, NULL-free
 * keyset (display_name is NOT NULL, id is the uuid PK), so the list
 * paginates cleanly all the way to the genuine end. Browsing a
 * directory by name is the operative use case; `last_login_at` stays a
 * displayed column. The recent filter swaps to
 * `(jit_provisioned_at DESC, id DESC)` and keeps the canonical
 * timestamp cursor codec.
 *
 * Returns `{ data, nextCursor, total }`. `total` is recomputed per
 * page from the base filter (cursor-independent); under live inserts it
 * may drift slightly from the count actually scrolled — accepted
 * infinite-scroll soft-state (STANDARDS §19.9.2), clamped by the shell.
 */

/**
 * Route-local opaque keyset cursor for the default `(display_name, id)`
 * sort. The canonical `@/lib/cursors` codec keys strictly on a
 * timestamp (`ts: datetime | null`) and cannot carry a text sort
 * column, so this route owns a small base64url-JSON `(name, id)` codec.
 * Precedent for a route/lib-local codec living outside `@/lib/cursors`
 * is `src/lib/leads.ts` (a colon-delimited `ts:id` token); the shape
 * here differs because the sort key is text, not a timestamp.
 * Tolerant by design: any malformed/stale token decodes to `null` and
 * the caller falls back to the first page (matches the canonical
 * codec's contract).
 */
const nameCursorSchema = z.object({
  n: z.string(),
  id: z.string().uuid(),
});

function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, id }), "utf8").toString(
    "base64url",
  );
}

function decodeNameCursor(
  raw: string | null,
): { n: string; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    // Deliberate optional-parse: a malformed/stale cursor is treated
    // as "no cursor" so a bookmarked URL returns the first page.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    // Deliberate optional-parse: a malformed/stale cursor is treated
    // as "no cursor" so a bookmarked URL returns the first page.
    return null;
  }
  const result = nameCursorSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export const GET = withInternalListApi(
  { action: "admin.users.list", auth: "admin" },
  async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const isRecentFilter = sp.get("recent") === RECENT_JIT_FILTER;
  const q = sp.get("q")?.trim() ?? "";
  const cursorRaw = sp.get("cursor");

  const wheres: SQL[] = [];
  if (q) {
    const pattern = `%${q}%`;
    wheres.push(
      or(
        ilike(users.displayName, pattern),
        ilike(users.email, pattern),
        ilike(users.username, pattern),
      )!,
    );
  }
  if (isRecentFilter) {
    wheres.push(eq(users.jitProvisioned, true));
    wheres.push(gt(users.jitProvisionedAt, sql`now() - interval '7 days'`));
  }

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  // Cursor predicate differs by sort. Recent filter sorts by
  // jit_provisioned_at (timestamp keyset, canonical codec); default
  // sorts by (display_name, id) (text keyset, route-local codec).
  let cursorWhere: SQL | undefined;
  if (isRecentFilter) {
    const parsed = cursorRaw ? decodeCursor(cursorRaw, "desc") : null;
    if (parsed && parsed.ts !== null) {
      cursorWhere = sql`(
        ${users.jitProvisionedAt} < ${parsed.ts.toISOString()}::timestamptz
        OR (${users.jitProvisionedAt} = ${parsed.ts.toISOString()}::timestamptz AND ${users.id} < ${parsed.id}::uuid)
      )`;
    }
  } else {
    const parsed = decodeNameCursor(cursorRaw);
    if (parsed) {
      cursorWhere = sql`(
        ${users.displayName} > ${parsed.n}
        OR (${users.displayName} = ${parsed.n} AND ${users.id} > ${parsed.id}::uuid)
      )`;
    }
  }

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  const baseSelect = {
    id: users.id,
    username: users.username,
    email: users.email,
    displayName: users.displayName,
    isAdmin: users.isAdmin,
    isBreakglass: users.isBreakglass,
    isActive: users.isActive,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
    jitProvisioned: users.jitProvisioned,
    jitProvisionedAt: users.jitProvisionedAt,
    photoUrl: users.photoBlobUrl,
    // The Leads column rendered 0 for every user. Drizzle does not
    // table-qualify column refs inside a `sql` template used as a select
    // field, so in db.select(baseSelect).from(users) ${users.id} emits
    // bare "id" — which binds to leads.id inside the subquery, making
    // the predicate leads.owner_id = leads.id (never true) => 0 for
    // everyone, including real owners. Correlate to the outer row via
    // raw "users"."id" (both branches select FROM users, never aliased).
    // .as("leadCount") just names the output column for SQL correctness
    // (postgres-js maps result columns positionally, so the alias is not
    // what fixed the count — the correlation is). Active (non-archived)
    // leads only, matching the /leads list.
    leadCount: sql<number>`(SELECT count(*)::int FROM ${leads} WHERE ${leads.ownerId} = "users"."id" AND ${leads.isDeleted} = false)`.as("leadCount"),
  };

  const [rowsRaw, totalRow] = await Promise.all([
    isRecentFilter
      ? db
          .select(baseSelect)
          .from(users)
          .where(finalWhere)
          .orderBy(desc(users.jitProvisionedAt), desc(users.id))
          .limit(PAGE_SIZE + 1)
      : db
          .select(baseSelect)
          .from(users)
          .where(finalWhere)
          .orderBy(asc(users.displayName), asc(users.id))
          .limit(PAGE_SIZE + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > PAGE_SIZE) {
    data = rowsRaw.slice(0, PAGE_SIZE);
    const last = data[data.length - 1];
    nextCursor = isRecentFilter
      ? last.jitProvisionedAt
        ? encodeFromValues(last.jitProvisionedAt, last.id, "desc")
        : null
      : encodeNameCursor(last.displayName, last.id);
  }

  return NextResponse.json({
    data: data.map((u) => ({
      ...u,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
      jitProvisionedAt: u.jitProvisionedAt
        ? u.jitProvisionedAt.toISOString()
        : null,
    })),
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  });
  },
);
