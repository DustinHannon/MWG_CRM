import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { savedViews, userPreferences } from "@/db/schema/views";
import type { SessionUser } from "@/lib/auth-helpers";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import {
  AVAILABLE_COLUMNS,
  type ColumnKey,
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
} from "@/lib/view-constants";

// Re-export for callers that already pulled these from the views module.
export { AVAILABLE_COLUMNS, COLUMN_KEYS, DEFAULT_COLUMNS, type ColumnKey };

/* ----------------------------------------------------------------------------
 * Built-in views — always available, never deleted, identified by a stable
 * string key. Each carries its own filter shape and column override.
 * ------------------------------------------------------------------------- */
export interface ViewDefinition {
  source: "builtin" | "saved";
  /** for builtin: e.g. "builtin:my-open"; for saved: "saved:<uuid>" */
  id: string;
  name: string;
  scope: "mine" | "all";
  /** Built-in views that MUST gate on canViewAllLeads / isAdmin. */
  requiresAllLeads?: boolean;
  filters: ViewFilters;
  columns: ColumnKey[];
  sort: { field: SortField; direction: "asc" | "desc" };
}

export type SortField =
  | "lastActivityAt"
  | "createdAt"
  | "updatedAt"
  | "name"
  | "company"
  | "value"
  | "status";

export interface ViewFilters {
  status?: string[];
  rating?: string[];
  source?: string[];
  tags?: string[];
  search?: string;
  doNotContact?: boolean | null;
  /** when set, restrict to created_at >= now() - <days>d */
  createdSinceDays?: number;
  /** when set, restrict to updated_at >= now() - <days>d */
  updatedSinceDays?: number;
}

export const BUILTIN_VIEWS: ViewDefinition[] = [
  {
    source: "builtin",
    id: "builtin:my-open",
    name: "My Open Leads",
    scope: "mine",
    filters: { status: ["new", "contacted", "qualified"] },
    columns: DEFAULT_COLUMNS,
    sort: { field: "lastActivityAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all-mine",
    name: "All My Leads",
    scope: "mine",
    filters: {},
    columns: DEFAULT_COLUMNS,
    sort: { field: "lastActivityAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:all",
    name: "All Leads",
    scope: "all",
    requiresAllLeads: true,
    filters: {},
    columns: DEFAULT_COLUMNS,
    sort: { field: "lastActivityAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:recent",
    name: "Recently Modified",
    scope: "mine",
    filters: { updatedSinceDays: 30 },
    columns: DEFAULT_COLUMNS,
    sort: { field: "updatedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:hot",
    name: "Hot Leads",
    scope: "mine",
    filters: {
      rating: ["hot"],
      // status NOT IN ('converted','lost','unqualified') — handled below.
      // We mark this via a magic key checked in buildLeadQuery.
    },
    columns: DEFAULT_COLUMNS,
    sort: { field: "lastActivityAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:imported",
    name: "Recently Imported",
    scope: "mine",
    filters: { createdSinceDays: 7 },
    columns: [
      "firstName",
      "lastName",
      "companyName",
      "status",
      "owner",
      "createdVia",
      "createdAt",
    ],
    sort: { field: "createdAt", direction: "desc" },
  },
];

export function findBuiltinView(id: string): ViewDefinition | null {
  return BUILTIN_VIEWS.find((v) => v.id === id) ?? null;
}

/** Visible-to-this-user filter applied to BUILTIN_VIEWS. */
export function visibleBuiltins(canViewAll: boolean): ViewDefinition[] {
  return BUILTIN_VIEWS.filter(
    (v) => !v.requiresAllLeads || canViewAll,
  );
}

/* ----------------------------------------------------------------------------
 * Saved view CRUD.
 * ------------------------------------------------------------------------- */
export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPinned: z.boolean().default(false),
  scope: z.enum(["mine", "all"]).default("mine"),
  filters: z
    .object({
      status: z.array(z.enum(LEAD_STATUSES)).optional(),
      rating: z.array(z.enum(LEAD_RATINGS)).optional(),
      source: z.array(z.enum(LEAD_SOURCES)).optional(),
      tags: z.array(z.string().max(80)).optional(),
      search: z.string().trim().max(200).optional(),
      doNotContact: z.boolean().nullable().optional(),
      createdSinceDays: z.number().int().min(1).max(3650).optional(),
      updatedSinceDays: z.number().int().min(1).max(3650).optional(),
    })
    .default({}),
  columns: z.array(z.enum(COLUMN_KEYS as [ColumnKey, ...ColumnKey[]])).default([]),
  sort: z
    .object({
      field: z.enum([
        "lastActivityAt",
        "createdAt",
        "updatedAt",
        "name",
        "company",
        "value",
        "status",
      ]),
      direction: z.enum(["asc", "desc"]),
    })
    .default({ field: "lastActivityAt", direction: "desc" }),
});

export type SavedViewInput = z.infer<typeof savedViewSchema>;

export async function listSavedViewsForUser(
  userId: string,
): Promise<ViewDefinition[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.userId, userId))
    .orderBy(desc(savedViews.isPinned), asc(savedViews.name));
  return rows.map(savedViewRowToDefinition);
}

export async function getSavedView(
  userId: string,
  id: string,
): Promise<ViewDefinition | null> {
  const row = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
    .limit(1);
  return row[0] ? savedViewRowToDefinition(row[0]) : null;
}

export async function createSavedView(
  userId: string,
  input: SavedViewInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(savedViews)
    .values({
      userId,
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

export async function updateSavedView(
  userId: string,
  id: string,
  input: Partial<SavedViewInput>,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined) set.name = input.name;
  if (input.isPinned !== undefined) set.isPinned = input.isPinned;
  if (input.scope !== undefined) set.scope = input.scope;
  if (input.filters !== undefined) set.filters = input.filters;
  if (input.columns !== undefined) set.columns = input.columns;
  if (input.sort !== undefined) set.sort = input.sort;
  await db
    .update(savedViews)
    .set(set)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)));
}

export async function deleteSavedView(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)));
}

function savedViewRowToDefinition(
  row: typeof savedViews.$inferSelect,
): ViewDefinition {
  // jsonb columns come back typed `unknown`; we trust validation on write
  // and fall back to defaults on read.
  const filters = (row.filters as ViewFilters | null) ?? {};
  const columns = (row.columns as ColumnKey[] | null) ?? DEFAULT_COLUMNS;
  const sort =
    (row.sort as { field: SortField; direction: "asc" | "desc" } | null) ?? {
      field: "lastActivityAt",
      direction: "desc",
    };
  return {
    source: "saved",
    id: `saved:${row.id}`,
    name: row.name,
    scope: row.scope === "all" ? "all" : "mine",
    filters,
    columns: columns.length > 0 ? columns : DEFAULT_COLUMNS,
    sort,
  };
}

/* ----------------------------------------------------------------------------
 * User preferences — last_used_view_id + adhoc_columns.
 * ------------------------------------------------------------------------- */
export async function getPreferences(userId: string): Promise<{
  theme: string;
  defaultLandingPage: string;
  lastUsedViewId: string | null;
  adhocColumns: ColumnKey[] | null;
}> {
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row[0]) {
    return {
      theme: "system",
      defaultLandingPage: "/dashboard",
      lastUsedViewId: null,
      adhocColumns: null,
    };
  }
  return {
    theme: row[0].theme,
    defaultLandingPage: row[0].defaultLandingPage,
    lastUsedViewId: row[0].lastUsedViewId,
    adhocColumns: (row[0].adhocColumns as ColumnKey[] | null) ?? null,
  };
}

export async function setLastUsedView(
  userId: string,
  viewId: string | null,
): Promise<void> {
  // viewId is "saved:<uuid>" or "builtin:..." — we only persist saved IDs.
  let savedId: string | null = null;
  if (viewId?.startsWith("saved:")) {
    savedId = viewId.slice("saved:".length);
  }
  await db
    .insert(userPreferences)
    .values({ userId, lastUsedViewId: savedId })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { lastUsedViewId: savedId, updatedAt: sql`now()` },
    });
}

export async function setAdhocColumns(
  userId: string,
  columns: ColumnKey[] | null,
): Promise<void> {
  await db
    .insert(userPreferences)
    .values({
      userId,
      adhocColumns: (columns ?? null) as object | null,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        adhocColumns: (columns ?? null) as object | null,
        updatedAt: sql`now()`,
      },
    });
}

/* ----------------------------------------------------------------------------
 * View → query.
 *
 * Run a view through this to get { rows, total }. Encapsulates the
 * builtin/saved differences (especially the Hot Leads "status NOT IN"
 * carve-out) and applies the actor's owner-scope automatically.
 * ------------------------------------------------------------------------- */
export interface RunViewOptions {
  view: ViewDefinition;
  user: SessionUser;
  canViewAll: boolean;
  page: number;
  pageSize: number;
  /** Override columns at runtime (adhoc / column chooser dirty state). */
  columns?: ColumnKey[];
  /** Override sort at runtime. */
  sort?: { field: SortField; direction: "asc" | "desc" };
  /** Allow the user to widen / narrow filters on top of the view base. */
  extraFilters?: ViewFilters;
}

export interface RunViewResult {
  rows: LeadRow[];
  total: number;
  columns: ColumnKey[];
  sort: { field: SortField; direction: "asc" | "desc" };
}

export interface LeadRow {
  id: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  jobTitle: string | null;
  status: string;
  rating: string;
  source: string;
  ownerId: string | null;
  ownerDisplayName: string | null;
  tags: string[] | null;
  city: string | null;
  state: string | null;
  estimatedValue: string | null;
  estimatedCloseDate: string | null;
  createdById: string | null;
  createdByDisplayName: string | null;
  createdVia: "manual" | "imported" | "api";
  importJobId: string | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  updatedAt: Date;
}

export async function runView(opts: RunViewOptions): Promise<RunViewResult> {
  const { view, user, canViewAll, page, pageSize } = opts;
  const merged = { ...view.filters, ...(opts.extraFilters ?? {}) };

  const wheres = [];

  // Owner scope. Built-in 'mine' OR no canViewAll → owned by actor only.
  if (!canViewAll && !user.isAdmin) {
    wheres.push(eq(leads.ownerId, user.id));
  } else if (view.scope === "mine") {
    wheres.push(eq(leads.ownerId, user.id));
  }

  if (merged.search) {
    const pattern = `%${merged.search}%`;
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
  if (merged.status?.length) {
    wheres.push(
      inArray(
        leads.status,
        merged.status as Array<(typeof LEAD_STATUSES)[number]>,
      ),
    );
  }
  if (merged.rating?.length) {
    wheres.push(
      inArray(
        leads.rating,
        merged.rating as Array<(typeof LEAD_RATINGS)[number]>,
      ),
    );
  }
  if (merged.source?.length) {
    wheres.push(
      inArray(
        leads.source,
        merged.source as Array<(typeof LEAD_SOURCES)[number]>,
      ),
    );
  }
  if (merged.tags?.length) {
    wheres.push(sql`${leads.tags} && ${merged.tags}::text[]`);
  }
  if (merged.doNotContact === true) {
    wheres.push(eq(leads.doNotContact, true));
  } else if (merged.doNotContact === false) {
    wheres.push(eq(leads.doNotContact, false));
  }
  if (merged.createdSinceDays && merged.createdSinceDays > 0) {
    wheres.push(
      gte(
        leads.createdAt,
        sql<Date>`now() - interval '1 day' * ${merged.createdSinceDays}`,
      ),
    );
  }
  if (merged.updatedSinceDays && merged.updatedSinceDays > 0) {
    wheres.push(
      gte(
        leads.updatedAt,
        sql<Date>`now() - interval '1 day' * ${merged.updatedSinceDays}`,
      ),
    );
  }

  // Hot Leads carve-out — exclude terminal/unqualified statuses unless the
  // user explicitly filtered status separately.
  if (view.id === "builtin:hot" && !merged.status?.length) {
    wheres.push(
      sql`${leads.status} NOT IN ('converted', 'lost', 'unqualified')`,
    );
  }

  // Avoid no-op linter noise.
  void isNull;
  void ne;

  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;

  const sort = opts.sort ?? view.sort;
  const sortColumn = (() => {
    switch (sort.field) {
      case "name":
        return leads.lastName;
      case "company":
        return leads.companyName;
      case "value":
        return leads.estimatedValue;
      case "createdAt":
        return leads.createdAt;
      case "updatedAt":
        return leads.updatedAt;
      case "status":
        return leads.status;
      default:
        return leads.lastActivityAt;
    }
  })();
  const order = sort.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (page - 1) * pageSize;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        email: leads.email,
        phone: leads.phone,
        mobilePhone: leads.mobilePhone,
        jobTitle: leads.jobTitle,
        status: leads.status,
        rating: leads.rating,
        source: leads.source,
        ownerId: leads.ownerId,
        ownerDisplayName: users.displayName,
        tags: leads.tags,
        city: leads.city,
        state: leads.state,
        estimatedValue: leads.estimatedValue,
        estimatedCloseDate: leads.estimatedCloseDate,
        createdById: leads.createdById,
        createdVia: leads.createdVia,
        importJobId: leads.importJobId,
        createdAt: leads.createdAt,
        lastActivityAt: leads.lastActivityAt,
        updatedAt: leads.updatedAt,
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(whereExpr)
      .orderBy(order, desc(leads.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(whereExpr),
  ]);

  // Hydrate created-by display names in a follow-up query (avoids N+1).
  const creatorIds = Array.from(
    new Set(rowsRaw.map((r) => r.createdById).filter((id): id is string => Boolean(id))),
  );
  const creators = creatorIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, creatorIds))
    : [];
  const creatorById = new Map(creators.map((c) => [c.id, c.displayName]));

  const rows: LeadRow[] = rowsRaw.map((r) => ({
    ...r,
    createdByDisplayName: r.createdById
      ? creatorById.get(r.createdById) ?? null
      : null,
  }));

  const columns = opts.columns ?? view.columns;

  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    columns,
    sort,
  };
}
