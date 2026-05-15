import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { savedViews, userPreferences } from "@/db/schema/views";
import { expectAffected } from "@/lib/db/concurrent-update";
import type { SessionUser } from "@/lib/auth-helpers";
import { encodeCursor, parseCursor } from "@/lib/leads";
import {
  CONTACT_COLUMN_KEYS,
  CONTACT_SORT_FIELDS,
  AVAILABLE_CONTACT_COLUMNS,
  DEFAULT_CONTACT_COLUMNS,
  type ContactColumnKey,
  type ContactSortField,
} from "@/lib/contact-view-constants";

// Re-export for callers that pulled these from the views module.
export {
  CONTACT_COLUMN_KEYS,
  AVAILABLE_CONTACT_COLUMNS,
  DEFAULT_CONTACT_COLUMNS,
  type ContactColumnKey,
  type ContactSortField,
};

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface ContactViewFilters {
  search?: string;
  owner?: string[];
  account?: string[];
  doNotContact?: boolean;
  doNotEmail?: boolean;
  doNotCall?: boolean;
  doNotMail?: boolean;
  city?: string;
  state?: string;
  country?: string;
  recentlyUpdatedDays?: number;
  /**
   * Filter to contacts bearing ANY of the given tag names (OR
   * semantics). Names are case-insensitive; matched against the
   * `tags` table via the `contact_tags` junction.
   */
  tags?: string[];
}

export interface ContactViewSort {
  field: ContactSortField;
  direction: "asc" | "desc";
}

export interface ContactViewDefinition {
  source: "builtin" | "saved";
  /** "builtin:<key>" or "saved:<uuid>". */
  id: string;
  name: string;
  scope: "mine" | "all";
  /** Built-in views that gate on canViewAllRecords / isAdmin. */
  requiresAllContacts?: boolean;
  filters: ContactViewFilters;
  columns: ContactColumnKey[];
  sort: ContactViewSort;
  /** present on saved views. */
  version?: number;
}

/* ----------------------------------------------------------------------------
 * Built-in views — always available, never deleted, identified by a stable
 * string key.
 * ------------------------------------------------------------------------- */

export const BUILTIN_CONTACT_VIEWS: ContactViewDefinition[] = [
  {
    source: "builtin",
    id: "builtin:my-open",
    name: "My contacts",
    scope: "mine",
    filters: {},
    columns: DEFAULT_CONTACT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all-mine",
    name: "All my contacts",
    scope: "mine",
    filters: {},
    columns: DEFAULT_CONTACT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all",
    name: "All contacts",
    scope: "all",
    requiresAllContacts: true,
    filters: {},
    columns: DEFAULT_CONTACT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:recent",
    name: "Recently updated",
    scope: "mine",
    filters: { recentlyUpdatedDays: 30 },
    columns: DEFAULT_CONTACT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
];

export function findBuiltinContactView(
  id: string,
): ContactViewDefinition | null {
  return BUILTIN_CONTACT_VIEWS.find((v) => v.id === id) ?? null;
}

export function visibleContactBuiltins(
  canViewAll: boolean,
): ContactViewDefinition[] {
  return BUILTIN_CONTACT_VIEWS.filter(
    (v) => !v.requiresAllContacts || canViewAll,
  );
}

/* ----------------------------------------------------------------------------
 * Saved view CRUD — scoped to entity_type='contact'.
 * ------------------------------------------------------------------------- */

export const contactViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPinned: z.boolean().default(false),
  scope: z.enum(["mine", "all"]).default("mine"),
  filters: z
    .object({
      search: z.string().trim().max(200).optional(),
      owner: z.array(z.string().uuid()).optional(),
      account: z.array(z.string().uuid()).optional(),
      doNotContact: z.boolean().optional(),
      doNotEmail: z.boolean().optional(),
      doNotCall: z.boolean().optional(),
      doNotMail: z.boolean().optional(),
      city: z.string().trim().max(120).optional(),
      state: z.string().trim().max(120).optional(),
      country: z.string().trim().max(80).optional(),
      recentlyUpdatedDays: z.number().int().min(1).max(3650).optional(),
      // 50-char cap aligned with the tagName primitive.
      tags: z.array(z.string().max(50)).optional(),
    })
    .default({}),
  columns: z
    .array(
      z.enum(
        CONTACT_COLUMN_KEYS as [ContactColumnKey, ...ContactColumnKey[]],
      ),
    )
    .default([]),
  sort: z
    .object({
      field: z.enum(CONTACT_SORT_FIELDS),
      direction: z.enum(["asc", "desc"]),
    })
    .default({ field: "updatedAt", direction: "desc" }),
});

export type ContactViewInput = z.infer<typeof contactViewSchema>;

export async function listSavedContactViewsForUser(
  userId: string,
): Promise<ContactViewDefinition[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(
      and(eq(savedViews.userId, userId), eq(savedViews.entityType, "contact")),
    )
    .orderBy(desc(savedViews.isPinned), asc(savedViews.name));
  return rows.map(savedContactViewRowToDefinition);
}

export async function getSavedContactView(
  userId: string,
  id: string,
): Promise<ContactViewDefinition | null> {
  const row = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "contact"),
      ),
    )
    .limit(1);
  return row[0] ? savedContactViewRowToDefinition(row[0]) : null;
}

export async function createSavedContactView(
  userId: string,
  input: ContactViewInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(savedViews)
    .values({
      userId,
      entityType: "contact",
      name: input.name,
      isPinned: input.isPinned,
      scope: input.scope,
      filters: input.filters as object,
      columns: input.columns as object,
      sort: input.sort as object,
    })
    .returning({ id: savedViews.id });
  return { id: inserted[0].id };
}

export async function updateSavedContactView(
  userId: string,
  id: string,
  expectedVersion: number,
  input: Partial<ContactViewInput>,
): Promise<{ id: string; version: number }> {
  const set: Record<string, unknown> = {
    updatedAt: sql`now()`,
    version: sql`${savedViews.version} + 1`,
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.isPinned !== undefined) set.isPinned = input.isPinned;
  if (input.scope !== undefined) set.scope = input.scope;
  if (input.filters !== undefined) set.filters = input.filters;
  if (input.columns !== undefined) set.columns = input.columns;
  if (input.sort !== undefined) set.sort = input.sort;
  const rows = await db
    .update(savedViews)
    .set(set)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "contact"),
        eq(savedViews.version, expectedVersion),
      ),
    )
    .returning({ id: savedViews.id, version: savedViews.version });
  expectAffected(rows, { table: savedViews, id, entityLabel: "view" });
  return rows[0];
}

export async function deleteSavedContactView(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "contact"),
      ),
    );
}

function savedContactViewRowToDefinition(
  row: typeof savedViews.$inferSelect,
): ContactViewDefinition {
  const filters = (row.filters as ContactViewFilters | null) ?? {};
  const columns =
    (row.columns as ContactColumnKey[] | null) ?? DEFAULT_CONTACT_COLUMNS;
  const sort =
    (row.sort as ContactViewSort | null) ?? {
      field: "updatedAt",
      direction: "desc",
    };
  return {
    source: "saved",
    id: `saved:${row.id}`,
    name: row.name,
    scope: row.scope === "all" ? "all" : "mine",
    filters,
    columns: columns.length > 0 ? columns : DEFAULT_CONTACT_COLUMNS,
    sort,
    version: row.version,
  };
}

/* ----------------------------------------------------------------------------
 * User preferences — default_contact_view_id + adhoc column storage.
 *
 * Per-entity adhoc columns are stored under
 * user_preferences.adhoc_columns.contact (jsonb object form). The
 * legacy bare-array form (used by leads) maps to .lead — we keep
 * legacy reads working in the leads helpers via a fallback.
 * ------------------------------------------------------------------------- */

export async function getContactPreferences(userId: string): Promise<{
  lastUsedViewId: string | null;
  defaultContactViewId: string | null;
  adhocColumns: ContactColumnKey[] | null;
}> {
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row[0]) {
    return {
      lastUsedViewId: null,
      defaultContactViewId: null,
      adhocColumns: null,
    };
  }
  const adhoc = readAdhocContact(row[0].adhocColumns);
  return {
    // No dedicated lastUsedContactViewId column — last-used pointer
    // for contacts derives from defaultContactViewId only.
    lastUsedViewId: null,
    defaultContactViewId: row[0].defaultContactViewId,
    adhocColumns: adhoc,
  };
}

/**
 * adhoc-columns storage migrated from a leads-only bare
 * array to a per-entity object. Old payloads (bare array) remain
 * readable for leads via the leads helper; this contact-scoped reader
 * only accepts the object form.
 */
function readAdhocContact(
  raw: unknown,
): ContactColumnKey[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).contact;
  if (!Array.isArray(v)) return null;
  const known = new Set<string>(CONTACT_COLUMN_KEYS);
  const out = v.filter(
    (k): k is ContactColumnKey => typeof k === "string" && known.has(k),
  );
  return out.length > 0 ? out : null;
}

export async function setDefaultContactView(
  userId: string,
  viewId: string | null,
): Promise<void> {
  let savedId: string | null = null;
  if (viewId?.startsWith("saved:")) {
    savedId = viewId.slice("saved:".length);
  }
  await db
    .insert(userPreferences)
    .values({ userId, defaultContactViewId: savedId })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { defaultContactViewId: savedId, updatedAt: sql`now()` },
    });
}

export async function setContactAdhocColumns(
  userId: string,
  columns: ContactColumnKey[] | null,
): Promise<void> {
  // Read-merge-write to preserve other entities' adhoc choices.
  const [existing] = await db
    .select({ adhoc: userPreferences.adhocColumns })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const base = coerceAdhocMap(existing?.adhoc);
  if (columns === null) {
    delete base.contact;
  } else {
    base.contact = columns;
  }
  await db
    .insert(userPreferences)
    .values({
      userId,
      adhocColumns: base as object,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        adhocColumns: base as object,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Coerce the historical adhoc_columns payload (which could be a
 * bare array for leads, an object, or null) into the canonical
 * `{ lead?:[], account?:[], contact?:[], ... }` object form.
 */
function coerceAdhocMap(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { lead: raw };
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  return {};
}

/* ----------------------------------------------------------------------------
 * View → query.
 * ------------------------------------------------------------------------- */

export interface ContactRow {
  id: string;
  firstName: string;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  birthdate: string | null;
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  doNotMail: boolean;
  accountId: string | null;
  accountName: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  ownerPhotoUrl: string | null;
  tags: Array<{ id: string; name: string; color: string | null }> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunContactViewOptions {
  view: ContactViewDefinition;
  user: SessionUser;
  canViewAll: boolean;
  page: number;
  pageSize: number;
  columns?: ContactColumnKey[];
  sort?: ContactViewSort;
  extraFilters?: ContactViewFilters;
  cursor?: string | null;
}

export interface RunContactViewResult {
  rows: ContactRow[];
  total: number;
  columns: ContactColumnKey[];
  sort: ContactViewSort;
  nextCursor: string | null;
}

export async function runContactView(
  opts: RunContactViewOptions,
): Promise<RunContactViewResult> {
  const { view, user, canViewAll, page, pageSize } = opts;

  // merge only DEFINED keys from extraFilters so URL-driven
  // empty params don't clobber the view's base filters.
  const merged: ContactViewFilters = { ...view.filters };
  const ef = (opts.extraFilters ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ef)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }

  const wheres = [];
  wheres.push(eq(contacts.isDeleted, false));

  // Owner scope.
  if (!canViewAll && !user.isAdmin) {
    wheres.push(eq(contacts.ownerId, user.id));
  } else if (view.scope === "mine") {
    wheres.push(eq(contacts.ownerId, user.id));
  }

  if (merged.search) {
    const pattern = `%${merged.search}%`;
    wheres.push(
      or(
        ilike(contacts.firstName, pattern),
        ilike(contacts.lastName, pattern),
        ilike(contacts.email, pattern),
        ilike(contacts.jobTitle, pattern),
      ),
    );
  }
  if (merged.owner?.length) {
    wheres.push(inArray(contacts.ownerId, merged.owner));
  }
  if (merged.account?.length) {
    wheres.push(inArray(contacts.accountId, merged.account));
  }
  if (merged.doNotContact === true) {
    wheres.push(eq(contacts.doNotContact, true));
  }
  if (merged.doNotEmail === true) {
    wheres.push(eq(contacts.doNotEmail, true));
  }
  if (merged.doNotCall === true) {
    wheres.push(eq(contacts.doNotCall, true));
  }
  if (merged.doNotMail === true) {
    wheres.push(eq(contacts.doNotMail, true));
  }
  if (merged.city) {
    wheres.push(ilike(contacts.city, `%${merged.city}%`));
  }
  if (merged.state) {
    wheres.push(eq(contacts.state, merged.state));
  }
  if (merged.country) {
    wheres.push(eq(contacts.country, merged.country));
  }
  if (merged.recentlyUpdatedDays && merged.recentlyUpdatedDays > 0) {
    wheres.push(
      gte(
        contacts.updatedAt,
        sql<Date>`now() - interval '1 day' * ${merged.recentlyUpdatedDays}`,
      ),
    );
  }
  if (merged.tags?.length) {
    // tag membership via the relational contact_tags table joined to
    // tags.name (case-insensitive). OR semantics.
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM contact_tags ct
        JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ${contacts.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(ARRAY[${sql.join(merged.tags.map((t) => sql`${t}`), sql`, `)}]::text[]) AS x
        )
      )`,
    );
  }

  const sort = opts.sort ?? view.sort;
  const sortColumn = (() => {
    switch (sort.field) {
      case "firstName":
        return contacts.firstName;
      case "lastName":
        return contacts.lastName;
      case "jobTitle":
        return contacts.jobTitle;
      case "email":
        return contacts.email;
      case "city":
        return contacts.city;
      case "state":
        return contacts.state;
      case "createdAt":
        return contacts.createdAt;
      case "updatedAt":
      default:
        return contacts.updatedAt;
    }
  })();
  const order = sort.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  // cursor pagination on the default sort
  // (updatedAt DESC, id DESC). Custom sorts fall back to OFFSET.
  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;
  // useCursor: caller is in cursor-pagination mode. The cursor route signals
  // this by passing `cursor` (null/empty on first page; encoded on subsequent).
  // `!!opts.cursor` short-circuit was a bug — first page evaluated false,
  // sliceLimit dropped to pageSize (no +1), nextCursor never returned. F-89.
  const useCursor =
    opts.cursor !== undefined && sort.field === "updatedAt" && sort.direction === "desc";
  const cursorParsed = useCursor && !!opts.cursor ? parseCursor(opts.cursor) : null;
  const cursorWhere = (() => {
    if (!useCursor || !cursorParsed || !cursorParsed.ts) return null;
    return sql`(
      ${contacts.updatedAt} < ${cursorParsed.ts.toISOString()}::timestamptz
      OR (${contacts.updatedAt} = ${cursorParsed.ts.toISOString()}::timestamptz AND ${contacts.id} < ${cursorParsed.id})
    )`;
  })();
  const finalWhere = cursorWhere
    ? whereExpr
      ? and(whereExpr, cursorWhere)
      : cursorWhere
    : whereExpr;

  const offset = useCursor ? 0 : (page - 1) * pageSize;
  const sliceLimit = useCursor ? pageSize + 1 : pageSize;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        email: contacts.email,
        phone: contacts.phone,
        mobilePhone: contacts.mobilePhone,
        city: contacts.city,
        state: contacts.state,
        postalCode: contacts.postalCode,
        country: contacts.country,
        birthdate: contacts.birthdate,
        doNotContact: contacts.doNotContact,
        doNotEmail: contacts.doNotEmail,
        doNotCall: contacts.doNotCall,
        doNotMail: contacts.doNotMail,
        accountId: contacts.accountId,
        accountName: crmAccounts.name,
        ownerId: contacts.ownerId,
        ownerDisplayName: users.displayName,
        ownerPhotoUrl: users.photoBlobUrl,
        // hydrate full tag objects so the cell renders TagChip.
        tags: sql<
          Array<{ id: string; name: string; color: string | null }> | null
        >`(
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', t.id,
                'name', t.name,
                'color', t.color
              )
              ORDER BY t.name
            ),
            '[]'::jsonb
          )
          FROM contact_tags ct
          JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = ${contacts.id}
        )`,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .leftJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
      .leftJoin(users, eq(contacts.ownerId, users.id))
      .where(finalWhere)
      .orderBy(order, desc(contacts.id))
      .limit(sliceLimit)
      .offset(offset),
    // Always run COUNT — sync_load_state dispatch in client consumes total
    // on every page; returning 0 on subsequent pages would zero out the
    // bulk-selection reducer's total counter. Cheap parallel query.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
          .where(whereExpr),
  ]);

  let trimmedRows = rowsRaw;
  let nextCursor: string | null = null;
  if (useCursor && rowsRaw.length > pageSize) {
    trimmedRows = rowsRaw.slice(0, pageSize);
    const last = trimmedRows[trimmedRows.length - 1];
    nextCursor = encodeCursor(last.updatedAt, last.id);
  }

  const rows: ContactRow[] = trimmedRows.map((r) => ({
    ...r,
  }));

  const columns = opts.columns ?? view.columns;
  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    columns,
    sort,
    nextCursor,
  };
}

/* ----------------------------------------------------------------------------
 * Account picker — distinct accounts referenced by the user's contacts.
 * Returns id+name pairs for the filter picker UI.
 * ------------------------------------------------------------------------- */

export async function listContactAccountPicks(opts: {
  userId: string;
  canViewAll: boolean;
}): Promise<Array<{ id: string; name: string }>> {
  // pull accounts that are referenced by the user's visible contacts. Limit
  // to 200 entries; the order is alphabetical by account name.
  const wheres = [
    eq(contacts.isDeleted, false),
    eq(crmAccounts.isDeleted, false),
  ];
  if (!opts.canViewAll) {
    wheres.push(eq(contacts.ownerId, opts.userId));
  }
  const rows = await db
    .selectDistinct({
      id: crmAccounts.id,
      name: crmAccounts.name,
    })
    .from(contacts)
    .innerJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
    .where(and(...wheres))
    .orderBy(asc(crmAccounts.name))
    .limit(200);
  return rows;
}
