import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { savedViews, userPreferences } from "@/db/schema/views";
import { expectAffected } from "@/lib/db/concurrent-update";
import type { SessionUser } from "@/lib/auth-helpers";
import { encodeCursor, parseCursor } from "@/lib/leads";
import {
  ACCOUNT_COLUMN_KEYS,
  ACCOUNT_SORT_FIELDS,
  AVAILABLE_ACCOUNT_COLUMNS,
  DEFAULT_ACCOUNT_COLUMNS,
  type AccountColumnKey,
  type AccountSortField,
} from "@/lib/account-view-constants";

// Re-export for callers that pulled these from the views module.
export {
  ACCOUNT_COLUMN_KEYS,
  AVAILABLE_ACCOUNT_COLUMNS,
  DEFAULT_ACCOUNT_COLUMNS,
  type AccountColumnKey,
  type AccountSortField,
};

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface AccountViewFilters {
  search?: string;
  owner?: string[];
  industry?: string[];
  city?: string;
  state?: string;
  country?: string;
  hasParentAccount?: boolean;
  recentlyUpdatedDays?: number;
  /**
   * Filter to accounts bearing ANY of the given tag names (OR
   * semantics). Names are case-insensitive; matched against the
   * `tags` table via the `account_tags` junction.
   */
  tags?: string[];
}

export interface AccountViewSort {
  field: AccountSortField;
  direction: "asc" | "desc";
}

export interface AccountViewDefinition {
  source: "builtin" | "saved";
  /** "builtin:<key>" or "saved:<uuid>". */
  id: string;
  name: string;
  scope: "mine" | "all";
  /** Built-in views that gate on canViewAllRecords / isAdmin. */
  requiresAllAccounts?: boolean;
  filters: AccountViewFilters;
  columns: AccountColumnKey[];
  sort: AccountViewSort;
  /** present on saved views. */
  version?: number;
}

/* ----------------------------------------------------------------------------
 * Built-in views — always available, never deleted, identified by a stable
 * string key.
 * ------------------------------------------------------------------------- */

export const BUILTIN_ACCOUNT_VIEWS: AccountViewDefinition[] = [
  {
    source: "builtin",
    id: "builtin:my-open",
    name: "My accounts",
    scope: "mine",
    filters: {},
    columns: DEFAULT_ACCOUNT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all-mine",
    name: "All my accounts",
    scope: "mine",
    filters: {},
    columns: DEFAULT_ACCOUNT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all",
    name: "All accounts",
    scope: "all",
    requiresAllAccounts: true,
    filters: {},
    columns: DEFAULT_ACCOUNT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:recent",
    name: "Recently updated",
    scope: "mine",
    filters: { recentlyUpdatedDays: 30 },
    columns: DEFAULT_ACCOUNT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
];

export function findBuiltinAccountView(
  id: string,
): AccountViewDefinition | null {
  return BUILTIN_ACCOUNT_VIEWS.find((v) => v.id === id) ?? null;
}

export function visibleAccountBuiltins(
  canViewAll: boolean,
): AccountViewDefinition[] {
  return BUILTIN_ACCOUNT_VIEWS.filter(
    (v) => !v.requiresAllAccounts || canViewAll,
  );
}

/* ----------------------------------------------------------------------------
 * Saved view CRUD — scoped to entity_type='account'.
 * ------------------------------------------------------------------------- */

export const accountViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPinned: z.boolean().default(false),
  scope: z.enum(["mine", "all"]).default("mine"),
  filters: z
    .object({
      search: z.string().trim().max(200).optional(),
      owner: z.array(z.string().uuid()).optional(),
      industry: z.array(z.string().max(100)).optional(),
      city: z.string().trim().max(120).optional(),
      state: z.string().trim().max(120).optional(),
      country: z.string().trim().max(80).optional(),
      hasParentAccount: z.boolean().optional(),
      recentlyUpdatedDays: z.number().int().min(1).max(3650).optional(),
      // 50-char cap aligned with the tagName primitive (no tag can be
      // longer than 50 chars; allowing 80 here would persist filter
      // values that match no row).
      tags: z.array(z.string().max(50)).optional(),
    })
    .default({}),
  columns: z
    .array(
      z.enum(
        ACCOUNT_COLUMN_KEYS as [AccountColumnKey, ...AccountColumnKey[]],
      ),
    )
    .default([]),
  sort: z
    .object({
      field: z.enum(ACCOUNT_SORT_FIELDS),
      direction: z.enum(["asc", "desc"]),
    })
    .default({ field: "updatedAt", direction: "desc" }),
});

export type AccountViewInput = z.infer<typeof accountViewSchema>;

export async function listSavedAccountViewsForUser(
  userId: string,
): Promise<AccountViewDefinition[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(
      and(eq(savedViews.userId, userId), eq(savedViews.entityType, "account")),
    )
    .orderBy(desc(savedViews.isPinned), asc(savedViews.name));
  return rows.map(savedAccountViewRowToDefinition);
}

export async function getSavedAccountView(
  userId: string,
  id: string,
): Promise<AccountViewDefinition | null> {
  const row = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "account"),
      ),
    )
    .limit(1);
  return row[0] ? savedAccountViewRowToDefinition(row[0]) : null;
}

export async function createSavedAccountView(
  userId: string,
  input: AccountViewInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(savedViews)
    .values({
      userId,
      entityType: "account",
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

export async function updateSavedAccountView(
  userId: string,
  id: string,
  expectedVersion: number,
  input: Partial<AccountViewInput>,
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
        eq(savedViews.entityType, "account"),
        eq(savedViews.version, expectedVersion),
      ),
    )
    .returning({ id: savedViews.id, version: savedViews.version });
  expectAffected(rows, { table: savedViews, id, entityLabel: "view" });
  return rows[0];
}

export async function deleteSavedAccountView(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "account"),
      ),
    );
}

function savedAccountViewRowToDefinition(
  row: typeof savedViews.$inferSelect,
): AccountViewDefinition {
  const filters = (row.filters as AccountViewFilters | null) ?? {};
  const columns =
    (row.columns as AccountColumnKey[] | null) ?? DEFAULT_ACCOUNT_COLUMNS;
  const sort =
    (row.sort as AccountViewSort | null) ?? {
      field: "updatedAt",
      direction: "desc",
    };
  return {
    source: "saved",
    id: `saved:${row.id}`,
    name: row.name,
    scope: row.scope === "all" ? "all" : "mine",
    filters,
    columns: columns.length > 0 ? columns : DEFAULT_ACCOUNT_COLUMNS,
    sort,
    version: row.version,
  };
}

/* ----------------------------------------------------------------------------
 * User preferences — default_account_view_id + adhoc column storage.
 *
 * Per-entity adhoc columns are stored under
 * user_preferences.adhoc_columns.account (jsonb object form). The
 * legacy bare-array form (used by leads) maps to .lead — we keep
 * legacy reads working in the leads helpers via a fallback.
 * ------------------------------------------------------------------------- */

export async function getAccountPreferences(userId: string): Promise<{
  lastUsedViewId: string | null;
  defaultAccountViewId: string | null;
  adhocColumns: AccountColumnKey[] | null;
}> {
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row[0]) {
    return {
      lastUsedViewId: null,
      defaultAccountViewId: null,
      adhocColumns: null,
    };
  }
  const adhoc = readAdhocAccount(row[0].adhocColumns);
  return {
    // No dedicated lastUsedAccountViewId column — last-used pointer
    // for accounts derives from defaultAccountViewId only. The leads
    // last_used pattern is a leads-specific affordance we don't port.
    lastUsedViewId: null,
    defaultAccountViewId: row[0].defaultAccountViewId,
    adhocColumns: adhoc,
  };
}

/**
 * adhoc-columns storage migrated from a leads-only bare
 * array to a per-entity object. Old payloads (bare array) remain
 * readable for leads via the leads helper; this account-scoped reader
 * only accepts the object form.
 */
function readAdhocAccount(
  raw: unknown,
): AccountColumnKey[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).account;
  if (!Array.isArray(v)) return null;
  const known = new Set<string>(ACCOUNT_COLUMN_KEYS);
  const out = v.filter(
    (k): k is AccountColumnKey => typeof k === "string" && known.has(k),
  );
  return out.length > 0 ? out : null;
}

export async function setDefaultAccountView(
  userId: string,
  viewId: string | null,
): Promise<void> {
  let savedId: string | null = null;
  if (viewId?.startsWith("saved:")) {
    savedId = viewId.slice("saved:".length);
  }
  await db
    .insert(userPreferences)
    .values({ userId, defaultAccountViewId: savedId })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { defaultAccountViewId: savedId, updatedAt: sql`now()` },
    });
}

export async function setAccountAdhocColumns(
  userId: string,
  columns: AccountColumnKey[] | null,
): Promise<void> {
  // Read-merge-write to preserve other entities' adhoc choices. Tiny
  // jsonb payload — single round trip in practice.
  const [existing] = await db
    .select({ adhoc: userPreferences.adhocColumns })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const base = coerceAdhocMap(existing?.adhoc);
  if (columns === null) {
    delete base.account;
  } else {
    base.account = columns;
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
 * `{ lead?:[], account?:[], ... }` object form. Bare arrays are
 * lifted under the `.lead` key to preserve legacy behavior.
 */
function coerceAdhocMap(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { lead: raw };
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  return {};
}

/* ----------------------------------------------------------------------------
 * View → query.
 * ------------------------------------------------------------------------- */

export interface AccountRow {
  id: string;
  name: string;
  accountNumber: string | null;
  industry: string | null;
  website: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  numberOfEmployees: number | null;
  annualRevenue: string | null;
  parentAccountId: string | null;
  parentAccountName: string | null;
  primaryContactId: string | null;
  primaryContactName: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  ownerPhotoUrl: string | null;
  wonDeals: number;
  tags: Array<{ id: string; name: string; color: string | null }> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunAccountViewOptions {
  view: AccountViewDefinition;
  user: SessionUser;
  canViewAll: boolean;
  page: number;
  pageSize: number;
  columns?: AccountColumnKey[];
  sort?: AccountViewSort;
  extraFilters?: AccountViewFilters;
  cursor?: string | null;
}

export interface RunAccountViewResult {
  rows: AccountRow[];
  total: number;
  columns: AccountColumnKey[];
  sort: AccountViewSort;
  nextCursor: string | null;
}

export async function runAccountView(
  opts: RunAccountViewOptions,
): Promise<RunAccountViewResult> {
  const { view, user, canViewAll, page, pageSize } = opts;

  // merge only DEFINED keys from extraFilters so URL-driven
  // empty params don't clobber the view's base filters.
  const merged: AccountViewFilters = { ...view.filters };
  const ef = (opts.extraFilters ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ef)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }

  const wheres = [];
  wheres.push(eq(crmAccounts.isDeleted, false));

  // Owner scope.
  if (!canViewAll && !user.isAdmin) {
    wheres.push(eq(crmAccounts.ownerId, user.id));
  } else if (view.scope === "mine") {
    wheres.push(eq(crmAccounts.ownerId, user.id));
  }

  if (merged.search) {
    const pattern = `%${merged.search}%`;
    wheres.push(
      or(
        ilike(crmAccounts.name, pattern),
        ilike(crmAccounts.website, pattern),
        ilike(crmAccounts.email, pattern),
        ilike(crmAccounts.industry, pattern),
        ilike(crmAccounts.accountNumber, pattern),
      ),
    );
  }
  if (merged.owner?.length) {
    wheres.push(inArray(crmAccounts.ownerId, merged.owner));
  }
  if (merged.industry?.length) {
    wheres.push(inArray(crmAccounts.industry, merged.industry));
  }
  if (merged.city) {
    wheres.push(ilike(crmAccounts.city, `%${merged.city}%`));
  }
  if (merged.state) {
    wheres.push(eq(crmAccounts.state, merged.state));
  }
  if (merged.country) {
    wheres.push(eq(crmAccounts.country, merged.country));
  }
  if (merged.hasParentAccount === true) {
    wheres.push(sql`${crmAccounts.parentAccountId} IS NOT NULL`);
  } else if (merged.hasParentAccount === false) {
    wheres.push(sql`${crmAccounts.parentAccountId} IS NULL`);
  }
  if (merged.recentlyUpdatedDays && merged.recentlyUpdatedDays > 0) {
    wheres.push(
      gte(
        crmAccounts.updatedAt,
        sql<Date>`now() - interval '1 day' * ${merged.recentlyUpdatedDays}`,
      ),
    );
  }
  if (merged.tags?.length) {
    // tag membership via the relational account_tags table joined to
    // tags.name (case-insensitive). OR semantics: a record matches
    // when it bears ANY selected tag.
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM account_tags at
        JOIN tags t ON t.id = at.tag_id
        WHERE at.account_id = ${crmAccounts.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(${merged.tags}::text[]) AS x
        )
      )`,
    );
  }

  const sort = opts.sort ?? view.sort;
  const sortColumn = (() => {
    switch (sort.field) {
      case "name":
        return crmAccounts.name;
      case "accountNumber":
        return crmAccounts.accountNumber;
      case "industry":
        return crmAccounts.industry;
      case "city":
        return crmAccounts.city;
      case "state":
        return crmAccounts.state;
      case "country":
        return crmAccounts.country;
      case "annualRevenue":
        return crmAccounts.annualRevenue;
      case "numberOfEmployees":
        return crmAccounts.numberOfEmployees;
      case "createdAt":
        return crmAccounts.createdAt;
      case "updatedAt":
      default:
        return crmAccounts.updatedAt;
    }
  })();
  const order = sort.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  // cursor pagination on the default sort
  // (updatedAt DESC, id DESC). Custom sorts fall back to OFFSET.
  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;
  const useCursor =
    !!opts.cursor && sort.field === "updatedAt" && sort.direction === "desc";
  const cursorParsed = useCursor ? parseCursor(opts.cursor!) : null;
  const cursorWhere = (() => {
    if (!useCursor || !cursorParsed || !cursorParsed.ts) return null;
    return sql`(
      ${crmAccounts.updatedAt} < ${cursorParsed.ts.toISOString()}::timestamptz
      OR (${crmAccounts.updatedAt} = ${cursorParsed.ts.toISOString()}::timestamptz AND ${crmAccounts.id} < ${cursorParsed.id})
    )`;
  })();
  const finalWhere = cursorWhere
    ? whereExpr
      ? and(whereExpr, cursorWhere)
      : cursorWhere
    : whereExpr;

  const offset = useCursor ? 0 : (page - 1) * pageSize;
  const sliceLimit = useCursor ? pageSize + 1 : pageSize;

  // Won deals subquery — kept inline to mirror the pre-port query plan.
  const wonDealsExpr = sql<number>`(
    SELECT COUNT(*)::int FROM ${opportunities}
    WHERE ${opportunities.accountId} = ${crmAccounts.id}
      AND ${opportunities.stage} = 'closed_won'
      AND ${opportunities.isDeleted} = false
  )`;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: crmAccounts.id,
        name: crmAccounts.name,
        accountNumber: crmAccounts.accountNumber,
        industry: crmAccounts.industry,
        website: crmAccounts.website,
        email: crmAccounts.email,
        city: crmAccounts.city,
        state: crmAccounts.state,
        country: crmAccounts.country,
        phone: crmAccounts.phone,
        numberOfEmployees: crmAccounts.numberOfEmployees,
        annualRevenue: crmAccounts.annualRevenue,
        parentAccountId: crmAccounts.parentAccountId,
        // The parent-account join is a self-join on crm_accounts; we
        // resolve it in a separate pass below to avoid the Drizzle
        // column-aliasing complexity. Leave the name null at SELECT.
        primaryContactId: crmAccounts.primaryContactId,
        ownerId: crmAccounts.ownerId,
        ownerDisplayName: users.displayName,
        ownerPhotoUrl: users.photoBlobUrl,
        wonDeals: wonDealsExpr,
        // hydrate full tag objects ({id,name,color}) so the list cell
        // can render TagChip components without a follow-up query.
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
          FROM account_tags at
          JOIN tags t ON t.id = at.tag_id
          WHERE at.account_id = ${crmAccounts.id}
        )`,
        createdAt: crmAccounts.createdAt,
        updatedAt: crmAccounts.updatedAt,
      })
      .from(crmAccounts)
      .leftJoin(users, eq(crmAccounts.ownerId, users.id))
      .where(finalWhere)
      .orderBy(order, desc(crmAccounts.id))
      .limit(sliceLimit)
      .offset(offset),
    useCursor
      ? Promise.resolve([{ count: 0 }])
      : db
          .select({ count: sql<number>`count(*)::int` })
          .from(crmAccounts)
          .where(whereExpr),
  ]);

  let trimmedRows = rowsRaw;
  let nextCursor: string | null = null;
  if (useCursor && rowsRaw.length > pageSize) {
    trimmedRows = rowsRaw.slice(0, pageSize);
    const last = trimmedRows[trimmedRows.length - 1];
    nextCursor = encodeCursor(last.updatedAt, last.id);
  }

  // Resolve parent-account-name and primary-contact-name via two
  // small lookups instead of a left-join (avoids self-join aliasing
  // and keeps the projection select clean). Page-size capped at 200
  // so the lookups never explode.
  const parentIds = Array.from(
    new Set(
      trimmedRows
        .map((r) => r.parentAccountId)
        .filter((v): v is string => v != null),
    ),
  );
  const primaryContactIds = Array.from(
    new Set(
      trimmedRows
        .map((r) => r.primaryContactId)
        .filter((v): v is string => v != null),
    ),
  );

  const [parentRows, primaryContactRows] = await Promise.all([
    parentIds.length > 0
      ? db
          .select({ id: crmAccounts.id, name: crmAccounts.name })
          .from(crmAccounts)
          .where(
            and(
              inArray(crmAccounts.id, parentIds),
              // Exclude archived parents — a soft-deleted account is
              // not a valid display target. FK ON DELETE SET NULL
              // only fires on hard delete; archived rows keep their
              // FK referenced and would otherwise render a stale
              // name here.
              eq(crmAccounts.isDeleted, false),
            ),
          )
      : Promise.resolve([]),
    primaryContactIds.length > 0
      ? db
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
          })
          .from(contacts)
          .where(
            and(
              inArray(contacts.id, primaryContactIds),
              eq(contacts.isDeleted, false),
            ),
          )
      : Promise.resolve([]),
  ]);

  const parentNameById = new Map(parentRows.map((p) => [p.id, p.name]));
  const primaryContactNameById = new Map(
    primaryContactRows.map((c) => [
      c.id,
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "(unnamed)",
    ]),
  );

  const rows: AccountRow[] = trimmedRows.map((r) => ({
    ...r,
    parentAccountName: r.parentAccountId
      ? (parentNameById.get(r.parentAccountId) ?? null)
      : null,
    primaryContactName: r.primaryContactId
      ? (primaryContactNameById.get(r.primaryContactId) ?? null)
      : null,
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
 * Distinct industry values for the filter picker.
 * ------------------------------------------------------------------------- */

export async function listAccountIndustries(opts: {
  userId: string;
  canViewAll: boolean;
}): Promise<string[]> {
  const wheres = [
    eq(crmAccounts.isDeleted, false),
    sql`${crmAccounts.industry} IS NOT NULL AND length(${crmAccounts.industry}) > 0`,
  ];
  if (!opts.canViewAll) {
    wheres.push(eq(crmAccounts.ownerId, opts.userId));
  }
  const rows = await db
    .selectDistinct({ industry: crmAccounts.industry })
    .from(crmAccounts)
    .where(and(...wheres))
    .orderBy(asc(crmAccounts.industry))
    .limit(200);
  return rows
    .map((r) => r.industry)
    .filter((v): v is string => Boolean(v));
}
