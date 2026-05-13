import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  contacts,
  crmAccounts,
  opportunities,
  opportunityStageEnum,
} from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { savedViews, userPreferences } from "@/db/schema/views";
import { expectAffected } from "@/lib/db/concurrent-update";
import type { SessionUser } from "@/lib/auth-helpers";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  DEFAULT_OPPORTUNITY_COLUMNS,
  OPPORTUNITY_COLUMN_KEYS,
  OPPORTUNITY_SORT_FIELDS,
  type OpportunityColumnKey,
  type OpportunitySortField,
} from "@/lib/opportunity-view-constants";

// Re-export for callers that pulled these from the views module.
export {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  DEFAULT_OPPORTUNITY_COLUMNS,
  OPPORTUNITY_COLUMN_KEYS,
  type OpportunityColumnKey,
  type OpportunitySortField,
};

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface OpportunityViewFilters {
  search?: string;
  owner?: string[];
  account?: string[];
  stage?: string[];
  closingWithinDays?: number;
  minAmount?: number;
  maxAmount?: number;
  /**
   * Filter to opportunities bearing ANY of the given tag names (OR
   * semantics). Names are case-insensitive; matched against the
   * `tags` table via the `opportunity_tags` junction.
   */
  tags?: string[];
}

export interface OpportunityViewSort {
  field: OpportunitySortField;
  direction: "asc" | "desc";
}

export interface OpportunityViewDefinition {
  source: "builtin" | "saved";
  id: string;
  name: string;
  scope: "mine" | "all";
  requiresAllOpportunities?: boolean;
  filters: OpportunityViewFilters;
  columns: OpportunityColumnKey[];
  sort: OpportunityViewSort;
  version?: number;
}

/* ----------------------------------------------------------------------------
 * Built-in views — always available, never deleted, identified by a stable
 * string key.
 * ------------------------------------------------------------------------- */

// Default sort for opportunities: expectedCloseDate DESC NULLS LAST, id DESC.
// Backed by the composite partial index `opportunities_close_date_id_idx`.
const DEFAULT_OPPORTUNITY_SORT: OpportunityViewSort = {
  field: "expectedCloseDate",
  direction: "desc",
};

export const BUILTIN_OPPORTUNITY_VIEWS: OpportunityViewDefinition[] = [
  {
    source: "builtin",
    id: "builtin:my-open",
    name: "My open opportunities",
    scope: "mine",
    filters: {
      // Stage excludes closed_won / closed_lost. Encoded as a positive
      // include list because the runner filter is `IN (...)`. All
      // open-pipeline stages are listed below.
      stage: ["prospecting", "qualification", "proposal", "negotiation"],
    },
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: DEFAULT_OPPORTUNITY_SORT,
  },
  {
    source: "builtin",
    id: "builtin:all-mine",
    name: "All my opportunities",
    scope: "mine",
    filters: {},
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: DEFAULT_OPPORTUNITY_SORT,
  },
  {
    source: "builtin",
    id: "builtin:all",
    name: "All opportunities",
    scope: "all",
    requiresAllOpportunities: true,
    filters: {},
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: DEFAULT_OPPORTUNITY_SORT,
  },
  {
    source: "builtin",
    id: "builtin:my-pipeline",
    name: "My pipeline",
    scope: "mine",
    filters: {
      stage: ["prospecting", "qualification", "proposal", "negotiation"],
    },
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: DEFAULT_OPPORTUNITY_SORT,
  },
  {
    source: "builtin",
    id: "builtin:my-won",
    name: "My won deals",
    scope: "mine",
    filters: { stage: ["closed_won"] },
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: { field: "closedAt", direction: "desc" },
  },
  {
    source: "builtin",
    id: "builtin:closing-soon",
    name: "Closing in 30 days",
    scope: "mine",
    filters: {
      stage: ["prospecting", "qualification", "proposal", "negotiation"],
      closingWithinDays: 30,
    },
    columns: DEFAULT_OPPORTUNITY_COLUMNS,
    sort: { field: "expectedCloseDate", direction: "asc" },
  },
];

export function findBuiltinOpportunityView(
  id: string,
): OpportunityViewDefinition | null {
  return BUILTIN_OPPORTUNITY_VIEWS.find((v) => v.id === id) ?? null;
}

export function visibleOpportunityBuiltins(
  canViewAll: boolean,
): OpportunityViewDefinition[] {
  return BUILTIN_OPPORTUNITY_VIEWS.filter(
    (v) => !v.requiresAllOpportunities || canViewAll,
  );
}

/* ----------------------------------------------------------------------------
 * Saved view CRUD — scoped to entity_type='opportunity'.
 * ------------------------------------------------------------------------- */

export const opportunityViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPinned: z.boolean().default(false),
  scope: z.enum(["mine", "all"]).default("mine"),
  filters: z
    .object({
      search: z.string().trim().max(200).optional(),
      owner: z.array(z.string().uuid()).optional(),
      account: z.array(z.string().uuid()).optional(),
      stage: z.array(z.enum(OPPORTUNITY_STAGES)).optional(),
      closingWithinDays: z.number().int().min(1).max(3650).optional(),
      minAmount: z.number().nonnegative().optional(),
      maxAmount: z.number().nonnegative().optional(),
      // 50-char cap aligned with the tagName primitive.
      tags: z.array(z.string().max(50)).optional(),
    })
    .default({}),
  columns: z
    .array(
      z.enum(
        OPPORTUNITY_COLUMN_KEYS as [
          OpportunityColumnKey,
          ...OpportunityColumnKey[],
        ],
      ),
    )
    .default([]),
  sort: z
    .object({
      field: z.enum(OPPORTUNITY_SORT_FIELDS),
      direction: z.enum(["asc", "desc"]),
    })
    .default(DEFAULT_OPPORTUNITY_SORT),
});

export type OpportunityViewInput = z.infer<typeof opportunityViewSchema>;

export async function listSavedOpportunityViewsForUser(
  userId: string,
): Promise<OpportunityViewDefinition[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "opportunity"),
      ),
    )
    .orderBy(desc(savedViews.isPinned), asc(savedViews.name));
  return rows.map(savedOpportunityViewRowToDefinition);
}

export async function getSavedOpportunityView(
  userId: string,
  id: string,
): Promise<OpportunityViewDefinition | null> {
  const row = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "opportunity"),
      ),
    )
    .limit(1);
  return row[0] ? savedOpportunityViewRowToDefinition(row[0]) : null;
}

export async function createSavedOpportunityView(
  userId: string,
  input: OpportunityViewInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(savedViews)
    .values({
      userId,
      entityType: "opportunity",
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

export async function updateSavedOpportunityView(
  userId: string,
  id: string,
  expectedVersion: number,
  input: Partial<OpportunityViewInput>,
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
        eq(savedViews.entityType, "opportunity"),
        eq(savedViews.version, expectedVersion),
      ),
    )
    .returning({ id: savedViews.id, version: savedViews.version });
  expectAffected(rows, { table: savedViews, id, entityLabel: "view" });
  return rows[0];
}

export async function deleteSavedOpportunityView(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "opportunity"),
      ),
    );
}

function savedOpportunityViewRowToDefinition(
  row: typeof savedViews.$inferSelect,
): OpportunityViewDefinition {
  const filters = (row.filters as OpportunityViewFilters | null) ?? {};
  const columns =
    (row.columns as OpportunityColumnKey[] | null) ??
    DEFAULT_OPPORTUNITY_COLUMNS;
  const sort =
    (row.sort as OpportunityViewSort | null) ?? DEFAULT_OPPORTUNITY_SORT;
  return {
    source: "saved",
    id: `saved:${row.id}`,
    name: row.name,
    scope: row.scope === "all" ? "all" : "mine",
    filters,
    columns: columns.length > 0 ? columns : DEFAULT_OPPORTUNITY_COLUMNS,
    sort,
    version: row.version,
  };
}

/* ----------------------------------------------------------------------------
 * User preferences — default_opportunity_view_id + adhoc column storage.
 * ------------------------------------------------------------------------- */

export async function getOpportunityPreferences(userId: string): Promise<{
  lastUsedViewId: string | null;
  defaultOpportunityViewId: string | null;
  adhocColumns: OpportunityColumnKey[] | null;
}> {
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row[0]) {
    return {
      lastUsedViewId: null,
      defaultOpportunityViewId: null,
      adhocColumns: null,
    };
  }
  const adhoc = readAdhocOpportunity(row[0].adhocColumns);
  return {
    // No dedicated lastUsedOpportunityViewId column — last-used pointer
    // for opportunities derives from defaultOpportunityViewId only.
    lastUsedViewId: null,
    defaultOpportunityViewId: row[0].defaultOpportunityViewId,
    adhocColumns: adhoc,
  };
}

function readAdhocOpportunity(
  raw: unknown,
): OpportunityColumnKey[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).opportunity;
  if (!Array.isArray(v)) return null;
  const known = new Set<string>(OPPORTUNITY_COLUMN_KEYS);
  const out = v.filter(
    (k): k is OpportunityColumnKey =>
      typeof k === "string" && known.has(k),
  );
  return out.length > 0 ? out : null;
}

export async function setDefaultOpportunityView(
  userId: string,
  viewId: string | null,
): Promise<void> {
  let savedId: string | null = null;
  if (viewId?.startsWith("saved:")) {
    savedId = viewId.slice("saved:".length);
  }
  await db
    .insert(userPreferences)
    .values({ userId, defaultOpportunityViewId: savedId })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { defaultOpportunityViewId: savedId, updatedAt: sql`now()` },
    });
}

export async function setOpportunityAdhocColumns(
  userId: string,
  columns: OpportunityColumnKey[] | null,
): Promise<void> {
  // Read-merge-write to preserve other entities' adhoc choices.
  const [existing] = await db
    .select({ adhoc: userPreferences.adhocColumns })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const base = coerceAdhocMap(existing?.adhoc);
  if (columns === null) {
    delete base.opportunity;
  } else {
    base.opportunity = columns;
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

function coerceAdhocMap(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { lead: raw };
  if (raw && typeof raw === "object")
    return { ...(raw as Record<string, unknown>) };
  return {};
}

/* ----------------------------------------------------------------------------
 * View → query.
 * ------------------------------------------------------------------------- */

export interface OpportunityRow {
  id: string;
  name: string;
  stage: string;
  accountId: string | null;
  accountName: string | null;
  primaryContactId: string | null;
  primaryContactName: string | null;
  amount: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  ownerPhotoUrl: string | null;
  closedAt: Date | null;
  tags: Array<{ id: string; name: string; color: string | null }> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunOpportunityViewOptions {
  view: OpportunityViewDefinition;
  user: SessionUser;
  canViewAll: boolean;
  page: number;
  pageSize: number;
  columns?: OpportunityColumnKey[];
  sort?: OpportunityViewSort;
  extraFilters?: OpportunityViewFilters;
  cursor?: string | null;
}

export interface RunOpportunityViewResult {
  rows: OpportunityRow[];
  total: number;
  columns: OpportunityColumnKey[];
  sort: OpportunityViewSort;
  nextCursor: string | null;
}

/**
 * Date-aware cursor codec for the default sort
 * (expectedCloseDate DESC NULLS LAST, id DESC).
 *
 * Format: `<yyyy-mm-dd|null>:<uuid>`.
 *
 * Reuse from `opportunities/page.tsx` (pre-port) is intentional —
 * `expected_close_date` is a `date` column, not `timestamptz`, so the
 * generic `parseCursor` from `@/lib/leads` (which expects an ISO ts)
 * doesn't apply.
 */
function encodeOpportunityCursor(
  date: string | null,
  id: string,
): string {
  return `${date ?? "null"}:${id}`;
}

function parseOpportunityCursor(
  raw: string | null | undefined,
): { date: string | null; id: string } | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const datePart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idPart,
    )
  ) {
    return null;
  }
  if (datePart === "null" || datePart === "") return { date: null, id: idPart };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return { date: datePart, id: idPart };
}

export async function runOpportunityView(
  opts: RunOpportunityViewOptions,
): Promise<RunOpportunityViewResult> {
  const { view, user, canViewAll, page, pageSize } = opts;

  // merge only DEFINED keys from extraFilters so URL-driven
  // empty params don't clobber the view's base filters.
  const merged: OpportunityViewFilters = { ...view.filters };
  const ef = (opts.extraFilters ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ef)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }

  const wheres = [];
  wheres.push(eq(opportunities.isDeleted, false));

  // Owner scope.
  if (!canViewAll && !user.isAdmin) {
    wheres.push(eq(opportunities.ownerId, user.id));
  } else if (view.scope === "mine") {
    wheres.push(eq(opportunities.ownerId, user.id));
  }

  if (merged.search) {
    const pattern = `%${merged.search}%`;
    wheres.push(
      or(
        ilike(opportunities.name, pattern),
        ilike(opportunities.description, pattern),
      ),
    );
  }
  if (merged.owner?.length) {
    wheres.push(inArray(opportunities.ownerId, merged.owner));
  }
  if (merged.account?.length) {
    wheres.push(inArray(opportunities.accountId, merged.account));
  }
  if (merged.stage?.length) {
    // Validate stage values against OPPORTUNITY_STAGES before
    // passing through Drizzle's parameterized inArray to keep SQL
    // safe. Unknown values are dropped silently — the URL parser
    // is untrusted input.
    const validStages = merged.stage.filter(
      (s): s is (typeof OPPORTUNITY_STAGES)[number] =>
        (OPPORTUNITY_STAGES as readonly string[]).includes(s),
    );
    if (validStages.length > 0) {
      wheres.push(inArray(opportunities.stage, validStages));
    }
  }
  if (merged.closingWithinDays && merged.closingWithinDays > 0) {
    wheres.push(
      sql`${opportunities.expectedCloseDate} BETWEEN current_date AND (current_date + (${merged.closingWithinDays} || ' days')::interval)::date`,
    );
  }
  if (typeof merged.minAmount === "number" && Number.isFinite(merged.minAmount)) {
    wheres.push(gte(opportunities.amount, String(merged.minAmount)));
  }
  if (typeof merged.maxAmount === "number" && Number.isFinite(merged.maxAmount)) {
    wheres.push(lte(opportunities.amount, String(merged.maxAmount)));
  }
  if (merged.tags?.length) {
    // tag membership via the relational opportunity_tags table joined
    // to tags.name (case-insensitive). OR semantics.
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM opportunity_tags ot
        JOIN tags t ON t.id = ot.tag_id
        WHERE ot.opportunity_id = ${opportunities.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(${merged.tags}::text[]) AS x
        )
      )`,
    );
  }

  const sort = opts.sort ?? view.sort;
  const sortColumn = (() => {
    switch (sort.field) {
      case "name":
        return opportunities.name;
      case "stage":
        return opportunities.stage;
      case "amount":
        return opportunities.amount;
      case "probability":
        return opportunities.probability;
      case "closedAt":
        return opportunities.closedAt;
      case "createdAt":
        return opportunities.createdAt;
      case "updatedAt":
        return opportunities.updatedAt;
      case "expectedCloseDate":
      default:
        return opportunities.expectedCloseDate;
    }
  })();
  // For the default sort (expectedCloseDate DESC), apply NULLS LAST
  // semantics explicitly. All other sorts use the standard ordering.
  const isDefaultSort =
    sort.field === "expectedCloseDate" && sort.direction === "desc";
  const order = isDefaultSort
    ? sql`${opportunities.expectedCloseDate} DESC NULLS LAST`
    : sort.direction === "asc"
      ? asc(sortColumn)
      : desc(sortColumn);

  // cursor pagination on the default sort
  // (expectedCloseDate DESC NULLS LAST, id DESC). Custom sorts fall
  // back to OFFSET.
  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;
  const useCursor = !!opts.cursor && isDefaultSort;
  const cursorParsed = useCursor ? parseOpportunityCursor(opts.cursor!) : null;
  const cursorWhere = (() => {
    if (!useCursor || !cursorParsed) return null;
    if (cursorParsed.date === null) {
      // Already in the NULL-block tail — only id-tiebreak remains.
      return sql`(${opportunities.expectedCloseDate} IS NULL AND ${opportunities.id} < ${cursorParsed.id})`;
    }
    return sql`(
      ${opportunities.expectedCloseDate} < ${cursorParsed.date}::date
      OR (${opportunities.expectedCloseDate} = ${cursorParsed.date}::date AND ${opportunities.id} < ${cursorParsed.id})
      OR ${opportunities.expectedCloseDate} IS NULL
    )`;
  })();
  const finalWhere = cursorWhere
    ? whereExpr
      ? and(whereExpr, cursorWhere)
      : cursorWhere
    : whereExpr;

  const offset = useCursor ? 0 : (page - 1) * pageSize;
  const sliceLimit = useCursor ? pageSize + 1 : pageSize;

  // Reference opportunityStageEnum to keep import live for callers
  // that may later need explicit enum casting; the import path also
  // documents the source of OPPORTUNITY_STAGES.
  void opportunityStageEnum;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        stage: sql<string>`${opportunities.stage}::text`,
        accountId: opportunities.accountId,
        accountName: crmAccounts.name,
        primaryContactId: opportunities.primaryContactId,
        primaryContactName: sql<
          string | null
        >`CASE WHEN ${contacts.id} IS NULL THEN NULL ELSE concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) END`,
        amount: opportunities.amount,
        probability: opportunities.probability,
        expectedCloseDate: opportunities.expectedCloseDate,
        ownerId: opportunities.ownerId,
        ownerDisplayName: users.displayName,
        ownerPhotoUrl: users.photoBlobUrl,
        closedAt: opportunities.closedAt,
        // hydrate full tag objects ({id,name,color}) so the list cell
        // can render TagChip components.
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
          FROM opportunity_tags ot
          JOIN tags t ON t.id = ot.tag_id
          WHERE ot.opportunity_id = ${opportunities.id}
        )`,
        createdAt: opportunities.createdAt,
        updatedAt: opportunities.updatedAt,
      })
      .from(opportunities)
      .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
      .leftJoin(contacts, eq(contacts.id, opportunities.primaryContactId))
      .leftJoin(users, eq(users.id, opportunities.ownerId))
      .where(finalWhere)
      .orderBy(order, desc(opportunities.id))
      .limit(sliceLimit)
      .offset(offset),
    useCursor
      ? Promise.resolve([{ count: 0 }])
      : db
          .select({ count: sql<number>`count(*)::int` })
          .from(opportunities)
          .where(whereExpr),
  ]);

  let trimmedRows = rowsRaw;
  let nextCursor: string | null = null;
  if (useCursor && rowsRaw.length > pageSize) {
    trimmedRows = rowsRaw.slice(0, pageSize);
    const last = trimmedRows[trimmedRows.length - 1];
    nextCursor = encodeOpportunityCursor(last.expectedCloseDate, last.id);
  }

  const rows: OpportunityRow[] = trimmedRows.map((r) => ({
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
 * Account picker for the filter UI — distinct accounts referenced by
 * opportunities visible to the caller.
 * ------------------------------------------------------------------------- */

export async function listOpportunityAccountPicker(opts: {
  userId: string;
  canViewAll: boolean;
}): Promise<Array<{ id: string; name: string }>> {
  const wheres = [
    eq(opportunities.isDeleted, false),
    eq(crmAccounts.isDeleted, false),
  ];
  if (!opts.canViewAll) {
    wheres.push(eq(opportunities.ownerId, opts.userId));
  }
  const rows = await db
    .selectDistinct({ id: crmAccounts.id, name: crmAccounts.name })
    .from(opportunities)
    .innerJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .where(and(...wheres))
    .orderBy(asc(crmAccounts.name))
    .limit(500);
  return rows;
}
