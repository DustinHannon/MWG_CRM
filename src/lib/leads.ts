import "server-only";
import { logger } from "@/lib/logger";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { leadTags, tags as tagsTable } from "@/db/schema/tags";
import { users } from "@/db/schema/users";
import { expectAffected } from "@/lib/db/concurrent-update";
import type { SessionUser } from "@/lib/auth-helpers";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import { nameField, urlField } from "@/lib/validation/primitives";

export { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES };

/**
 * The filters arrive from URL query strings (and from saved-view JSON).
 * URL forms always serialise empty <select> values as `key=` — an empty
 * string. zod's z.enum REJECTS empty strings (they're not in the enum),
 * which is the root cause of the "Apply button throws" bug.
 *
 * Fix: pre-process the raw input via `sanitizeFilterInput` below so empty
 * strings collapse to undefined BEFORE the schema parse. This applies to
 * the URL submit path (the Apply button) and to any future programmatic
 * caller, so the schema itself stays strict.
 */
const emptyToUndef = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), s);

export const leadFiltersSchema = z.object({
  q: emptyToUndef(z.string().trim().max(200)).optional(),
  status: emptyToUndef(z.enum(LEAD_STATUSES)).optional(),
  rating: emptyToUndef(z.enum(LEAD_RATINGS)).optional(),
  source: emptyToUndef(z.enum(LEAD_SOURCES)).optional(),
  ownerId: emptyToUndef(z.string().uuid()).optional(),
  tag: emptyToUndef(z.string().trim().max(80)).optional(),
  page: emptyToUndef(z.coerce.number().int().min(1)).default(1),
  pageSize: emptyToUndef(z.coerce.number().int().min(10).max(200)).default(50),
  sort: emptyToUndef(
    z.enum(["lastActivity", "created", "name", "company", "value"]),
  ).default("lastActivity"),
  dir: emptyToUndef(z.enum(["asc", "desc"])).default("desc"),
  // cursor pagination. Cursor format is `<iso8601>:<uuid>`
  // where the timestamp matches the active sort column and the uuid
  // is the row's id. When present, callers SHOULD NOT also pass `page`
  // (cursor wins; offset is ignored).
  cursor: emptyToUndef(z.string().trim().max(80)).optional(),
});

/**
 * cursor codec. Pagination cursors are stable strings of the
 * form `<iso8601>:<uuid>`. The leading timestamp is whichever column
 * drives the active sort (last_activity_at, updated_at, etc.); the
 * trailing uuid is the row's id, used as a tiebreaker so cursor seeks
 * stay deterministic across rows that share a timestamp.
 *
 * NULL timestamps are encoded as the literal string "null" so the
 * `(updated_at, id) < (cursorTs, cursorId)` semantics translate to
 * the SQL-level NULLS LAST ordering used by every list view.
 */
export interface ParsedCursor {
  ts: Date | null;
  id: string;
}

export function parseCursor(raw: string | undefined | null): ParsedCursor | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const tsPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  // basic uuid sanity (avoids letting users inject arbitrary text into
  // the where clause; the parameterised binding in `sql` handles the
  // rest, but parse-time validation lets us drop bad cursors silently).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idPart)) {
    return null;
  }
  if (tsPart === "null" || tsPart === "") return { ts: null, id: idPart };
  const d = new Date(tsPart);
  if (Number.isNaN(d.getTime())) return null;
  return { ts: d, id: idPart };
}

export function encodeCursor(ts: Date | null, id: string): string {
  return `${ts ? ts.toISOString() : "null"}:${id}`;
}

export type LeadFilters = z.infer<typeof leadFiltersSchema>;

/**
 * Belt + suspenders: reject any payload where do_not_contact=true but
 * do_not_email=false or do_not_call=false. The lead-form UX auto-checks
 * + disables those when DNC is on, but a forged form / API caller could
 * skip that — this refinement closes that gap server-side.
 */
const leadCreateSchemaBase = z.object({
  salutation: z.string().max(20).optional().nullable(),
  firstName: nameField,
  // last_name is now nullable. Manual create form still
  // marks the field required via HTML/UI, but the schema accepts empty
  // so the import path can carry NULL through.
  lastName: nameField.or(z.literal("")).optional().nullable(),
  jobTitle: z.string().max(200).optional().nullable(),
  companyName: z.string().max(200).optional().nullable(),
  industry: z.string().max(100).optional().nullable(),
  email: z.string().email().or(z.literal("")).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  mobilePhone: z.string().max(40).optional().nullable(),
  website: urlField.or(z.literal("")).optional().nullable(),
  linkedinUrl: urlField.or(z.literal("")).optional().nullable(),
  street1: z.string().max(200).optional().nullable(),
  street2: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  description: z.string().max(20_000).optional().nullable(),
  // leads.subject (the "Topic:" line in legacy D365 dumps).
  subject: z.string().max(1000).optional().nullable(),
  status: z.enum(LEAD_STATUSES).default("new"),
  rating: z.enum(LEAD_RATINGS).default("warm"),
  source: z.enum(LEAD_SOURCES).default("other"),
  estimatedValue: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n.toFixed(2) : null;
    }),
  estimatedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  doNotContact: z.boolean().default(false),
  doNotEmail: z.boolean().default(false),
  doNotCall: z.boolean().default(false),
  // `tags` removed from lead create/update schema. Tags are
  // managed via the relational lead_tags table; the lead-form's free-text
  // tags input is silently ignored (will be replaced with a tag picker
  // in a follow-up). Schema is permissive — extra keys are stripped.
  ownerId: z.string().uuid().optional().nullable(),
});

const dncRefinement = (data: {
  doNotContact?: boolean;
  doNotEmail?: boolean;
  doNotCall?: boolean;
}) => {
  if (!data.doNotContact) return true;
  return data.doNotEmail !== false && data.doNotCall !== false;
};

export const leadCreateSchema = leadCreateSchemaBase.refine(dncRefinement, {
  message:
    "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
  path: ["doNotContact"],
});

/**
 * Partial-update schema. Built off the unrefined base because z.refine()
 * turns a ZodObject into ZodEffects, which doesn't have .partial(). Re-
 * apply the DNC refinement after .partial().
 */
export const leadUpdateSchema = leadCreateSchemaBase
  .partial()
  .extend({ id: z.string().uuid() })
  .refine(dncRefinement, {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  });

/** For server-action callers that need a partial without the id field. */
export const leadPartialSchema = leadCreateSchemaBase.partial().refine(
  dncRefinement,
  {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  },
);

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

export interface LeadListResult {
  rows: Array<{
    id: string;
    firstName: string;
    lastName: string | null;
    companyName: string | null;
    email: string | null;
    phone: string | null;
    status: (typeof LEAD_STATUSES)[number];
    rating: (typeof LEAD_RATINGS)[number];
    source: (typeof LEAD_SOURCES)[number];
    ownerId: string | null;
    ownerDisplayName: string | null;
    estimatedValue: string | null;
    lastActivityAt: Date | null;
    updatedAt: Date;
    createdAt: Date;
    tags: string[] | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  /**
   * opaque cursor that callers pass back via `?cursor=…` to
   * load the next page. Null when there are no more rows. Always set
   * when cursor pagination is active (ignored on offset paths).
   */
  nextCursor: string | null;
}

export async function listLeads(
  user: SessionUser,
  rawFilters: unknown,
  canViewAll: boolean,
): Promise<LeadListResult> {
  // safeParse + log on failure: an unknown filter shape should NOT throw
  // and crash the page. Bad filters produce an empty result set + warning.
  const parsed = leadFiltersSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    logger.warn("leads.invalid_filters", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const filters = parsed.success
    ? parsed.data
    : leadFiltersSchema.parse({});

  const wheres = [];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    wheres.push(
      or(
        ilike(leads.firstName, pattern),
        ilike(leads.lastName, pattern),
        ilike(leads.email, pattern),
        ilike(leads.companyName, pattern),
        ilike(leads.phone, pattern),
      ),
    );
  }
  if (filters.status) wheres.push(eq(leads.status, filters.status));
  if (filters.rating) wheres.push(eq(leads.rating, filters.rating));
  if (filters.source) wheres.push(eq(leads.source, filters.source));
  if (filters.ownerId) wheres.push(eq(leads.ownerId, filters.ownerId));
  if (filters.tag) {
    // legacy `leads.tags` column was dropped. Membership now
    // resolves via the relational lead_tags table joined to tags.name.
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM ${leadTags} lt
        JOIN ${tagsTable} t ON t.id = lt.tag_id
        WHERE lt.lead_id = ${leads.id} AND lower(t.name) = lower(${filters.tag})
      )`,
    );
  }
  // Non-admin without canViewAllRecords sees only their own.
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }

  // default queries hide archived rows.
  wheres.push(eq(leads.isDeleted, false));

  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;

  const sortColumn = (() => {
    switch (filters.sort) {
      case "name":
        return leads.lastName;
      case "company":
        return leads.companyName;
      case "value":
        return leads.estimatedValue;
      case "created":
        return leads.createdAt;
      default:
        return leads.lastActivityAt;
    }
  })();
  const order = filters.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

  // ------------------------------------------------------------------
  // cursor pagination on the default sort
  // (last_activity_at DESC, id DESC). Fast path: when the sort is the
  // default and a cursor is provided, append a tuple-style WHERE clause
  // and skip the OFFSET. Slow path (custom sort field, or paginated by
  // ?page=N for the existing UI) falls back to OFFSET. The export route
  // pulls 10k rows in a single page=1 request and never sets a cursor,
  // so it stays on the offset path unchanged.
  // ------------------------------------------------------------------
  const useCursor =
    !!filters.cursor && filters.sort === "lastActivity" && filters.dir === "desc";
  const cursor = useCursor ? parseCursor(filters.cursor) : null;
  const cursorWhere = (() => {
    if (!useCursor || !cursor) return undefined;
    // (last_activity_at, id) < (cursorTs, cursorId) with NULLS LAST.
    // PG row-comparison would treat NULL specially, so we expand it.
    if (cursor.ts === null) {
      // NULL last_activity_at means we're already past the
      // non-null block; only id-tiebreak remains.
      return sql`(${leads.lastActivityAt} IS NULL AND ${leads.id} < ${cursor.id})`;
    }
    return sql`(
      ${leads.lastActivityAt} < ${cursor.ts.toISOString()}::timestamptz
      OR (${leads.lastActivityAt} = ${cursor.ts.toISOString()}::timestamptz AND ${leads.id} < ${cursor.id})
    )`;
  })();
  const finalWhere = cursorWhere
    ? whereExpr
      ? and(whereExpr, cursorWhere)
      : cursorWhere
    : whereExpr;

  const offset = useCursor ? 0 : (filters.page - 1) * filters.pageSize;
  // pageSize+1 lets us detect "more available" cheaply without a count.
  const sliceLimit = useCursor ? filters.pageSize + 1 : filters.pageSize;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        email: leads.email,
        phone: leads.phone,
        status: leads.status,
        rating: leads.rating,
        source: leads.source,
        ownerId: leads.ownerId,
        ownerDisplayName: users.displayName,
        estimatedValue: leads.estimatedValue,
        lastActivityAt: leads.lastActivityAt,
        updatedAt: leads.updatedAt,
        createdAt: leads.createdAt,
        // hydrate tag names from the relational lead_tags
        // join. Returns NULL when the lead has no tags so existing UI
        // null-checks keep working.
        tags: sql<string[] | null>`(
          SELECT array_agg(t.name ORDER BY t.name)
          FROM ${leadTags} lt
          JOIN ${tagsTable} t ON t.id = lt.tag_id
          WHERE lt.lead_id = ${leads.id}
        )`,
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(finalWhere)
      .orderBy(order, desc(leads.id))
      .limit(sliceLimit)
      .offset(offset),
    // total count is only required for offset pagination
    // (footer "Page X of Y"). Cursor mode skips it; the +1 row trick
    // tells us whether another page exists, which is what the UI needs.
    useCursor
      ? Promise.resolve([{ count: 0 }])
      : db
          .select({ count: sql<number>`count(*)::int` })
          .from(leads)
          .where(whereExpr),
  ]);

  let nextCursor: string | null = null;
  let rows = rowsRaw;
  if (useCursor && rowsRaw.length > filters.pageSize) {
    rows = rowsRaw.slice(0, filters.pageSize);
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor(last.lastActivityAt, last.id);
  }

  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
    nextCursor,
  };
}

/**
 * Filter shape for the canonical cursor-paginated list. Mirrors the
 * subset of `leadFiltersSchema` that the new StandardListPage UI sends
 * — sort and direction are fixed (`lastActivity DESC`) so the result
 * matches the partial index `leads_last_activity_id_idx`.
 */
export interface LeadCursorFilters {
  q?: string;
  status?: (typeof LEAD_STATUSES)[number];
  rating?: (typeof LEAD_RATINGS)[number];
  source?: (typeof LEAD_SOURCES)[number];
  ownerId?: string;
  tag?: string;
}

export interface LeadCursorRow {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  status: (typeof LEAD_STATUSES)[number];
  rating: (typeof LEAD_RATINGS)[number];
  source: (typeof LEAD_SOURCES)[number];
  ownerId: string | null;
  ownerDisplayName: string | null;
  estimatedValue: string | null;
  lastActivityAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  tags: string[] | null;
}

/**
 * Canonical cursor-paginated list. Sort is fixed
 * `(last_activity_at DESC NULLS LAST, id DESC)` so the query stays on
 * `leads_last_activity_id_idx`.
 *
 * Returns `{ data, nextCursor, total }`:
 * - `data` — up to `pageSize` rows.
 * - `nextCursor` — opaque token for the next page, or `null` when the
 *   result set is exhausted.
 * - `total` — full result-set count for the same filters (used by the
 *   "Showing N of M" affordance).
 *
 * Permission scoping mirrors `listLeads`: non-admin without
 * `canViewAllRecords` sees only their own.
 */
export async function listLeadsCursor(args: {
  user: SessionUser;
  filters: LeadCursorFilters;
  cursor: string | null;
  pageSize?: number;
  canViewAll: boolean;
}): Promise<{ data: LeadCursorRow[]; nextCursor: string | null; total: number }> {
  const pageSize = args.pageSize ?? 50;
  const { user, filters, canViewAll } = args;

  const wheres = [];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    wheres.push(
      or(
        ilike(leads.firstName, pattern),
        ilike(leads.lastName, pattern),
        ilike(leads.email, pattern),
        ilike(leads.companyName, pattern),
        ilike(leads.phone, pattern),
      ),
    );
  }
  if (filters.status) wheres.push(eq(leads.status, filters.status));
  if (filters.rating) wheres.push(eq(leads.rating, filters.rating));
  if (filters.source) wheres.push(eq(leads.source, filters.source));
  if (filters.ownerId) wheres.push(eq(leads.ownerId, filters.ownerId));
  if (filters.tag) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM ${leadTags} lt
        JOIN ${tagsTable} t ON t.id = lt.tag_id
        WHERE lt.lead_id = ${leads.id} AND lower(t.name) = lower(${filters.tag})
      )`,
    );
  }
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }
  wheres.push(eq(leads.isDeleted, false));

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  // Cursor expansion. The default sort is
  // `(last_activity_at DESC NULLS LAST, id DESC)`. PostgreSQL row
  // comparison treats NULL specially, so we expand the tuple manually:
  //   - non-null cursor: row's last_activity_at < cursor.ts, OR equal
  //     and id < cursor.id, OR row's last_activity_at is NULL (already
  //     past the non-null block).
  //   - NULL cursor: row's last_activity_at IS NULL and id < cursor.id.
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) {
      return sql`(${leads.lastActivityAt} IS NULL AND ${leads.id} < ${parsedCursor.id})`;
    }
    return sql`(
      ${leads.lastActivityAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${leads.lastActivityAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${leads.id} < ${parsedCursor.id})
      OR ${leads.lastActivityAt} IS NULL
    )`;
  })();

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  // Fetch pageSize+1 to detect "more available" without a second
  // count query for the cursor side. `total` is a separate cheap count
  // against the unfiltered-by-cursor where clause.
  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        email: leads.email,
        phone: leads.phone,
        status: leads.status,
        rating: leads.rating,
        source: leads.source,
        ownerId: leads.ownerId,
        ownerDisplayName: users.displayName,
        estimatedValue: leads.estimatedValue,
        lastActivityAt: leads.lastActivityAt,
        updatedAt: leads.updatedAt,
        createdAt: leads.createdAt,
        tags: sql<string[] | null>`(
          SELECT array_agg(t.name ORDER BY t.name)
          FROM ${leadTags} lt
          JOIN ${tagsTable} t ON t.id = lt.tag_id
          WHERE lt.lead_id = ${leads.id}
        )`,
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(finalWhere)
      .orderBy(sql`${leads.lastActivityAt} DESC NULLS LAST`, desc(leads.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.lastActivityAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}

export async function getLeadById(
  user: SessionUser,
  id: string,
  canViewAll: boolean,
) {
  const wheres = [eq(leads.id, id)];
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }
  const row = await db
    .select()
    .from(leads)
    .where(and(...wheres))
    .limit(1);
  if (!row[0]) return null;
  // hydrate tag names from the relational lead_tags table.
  // The legacy `leads.tags text[]` column was dropped; consumers still
  // expect `lead.tags: string[] | null` so we fetch and attach.
  const tagRows = await db
    .select({ name: tagsTable.name })
    .from(leadTags)
    .innerJoin(tagsTable, eq(tagsTable.id, leadTags.tagId))
    .where(eq(leadTags.leadId, row[0].id))
    .orderBy(asc(tagsTable.name));
  const tagNames = tagRows.map((t) => t.name);
  return { ...row[0], tags: tagNames.length > 0 ? tagNames : null };
}

export async function createLead(
  user: SessionUser,
  input: LeadCreateInput,
): Promise<{ id: string }> {
  const ownerId = input.ownerId ?? user.id;
  const inserted = await db
    .insert(leads)
    .values({
      ownerId,
      status: input.status,
      rating: input.rating,
      source: input.source,
      salutation: input.salutation ?? null,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      jobTitle: input.jobTitle ?? null,
      companyName: input.companyName ?? null,
      industry: input.industry ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      website: input.website ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
      subject: input.subject ?? null,
      doNotContact: input.doNotContact,
      doNotEmail: input.doNotEmail,
      doNotCall: input.doNotCall,
      estimatedValue: input.estimatedValue,
      estimatedCloseDate: input.estimatedCloseDate ?? null,
      createdById: user.id,
      updatedById: user.id,
      // `last_activity_at` left NULL on creation so scoring
      // recency rules don't treat just-imported / just-created leads as
      // engaged. It bumps when the first counting activity (note / call /
      // email / meeting / task) is logged.
    })
    .returning({ id: leads.id });
  return { id: inserted[0].id };
}

/**
 * OCC backend wiring. Update path is now version-checked:
 * the caller passes the `expectedVersion` it loaded with the row, the
 * UPDATE only fires when the on-disk version still matches, and we
 * bump version + updated_at in the same statement.
 *
 * Throws ConflictError when another writer moved the row between the
 * caller's read and this update; throws NotFoundError when the id is
 * gone. Both carry user-facing public messages.
 */
export async function updateLead(
  user: SessionUser,
  id: string,
  expectedVersion: number,
  input: Partial<LeadCreateInput>,
): Promise<{ id: string; version: number }> {
  const update: Record<string, unknown> = {
    updatedById: user.id,
    updatedAt: sql`now()`,
    version: sql`${leads.version} + 1`,
  };
  for (const key of Object.keys(input) as Array<keyof LeadCreateInput>) {
    update[key] = input[key];
  }
  // 046 — `is_deleted = false` clause prevents a stale
  // edit form from silently overwriting a row that was archived between
  // load and submit. With this filter the UPDATE matches zero rows,
  // expectAffected throws NotFoundError, and the user sees the correct
  // public message instead of a phantom success.
  const rows = await db
    .update(leads)
    .set(update)
    .where(
      and(
        eq(leads.id, id),
        eq(leads.version, expectedVersion),
        eq(leads.isDeleted, false),
      ),
    )
    .returning({ id: leads.id, version: leads.version });
  expectAffected(rows, { table: leads, id, entityLabel: "lead" });
  return rows[0];
}

/**
 * Hard-delete a batch of lead ids. Cascades through activities, tasks,
 * lead_tags, attachments. Use only from admin flows or the purge cron;
 * regular users archive via `archiveLeadsById()`.
 *
 * @actor admin or purge cron only
 */
export async function deleteLeadsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(leads).where(inArray(leads.id, ids));
}

/**
 * soft delete (archive). Sets `is_deleted=true` and the
 * deletion-attribution columns. Reversible via `restoreLeadsById()`.
 *
 * @actor lead owner or admin
 */
export async function archiveLeadsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(leads)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: reason ?? null,
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(leads.id, ids));
}

/**
 * restore archived leads. Returns row count for logging.
 *
 * @actor admin only
 */
export async function restoreLeadsById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(leads)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      updatedAt: sql`now()`,
      updatedById: actorId,
    })
    .where(inArray(leads.id, ids));
}
