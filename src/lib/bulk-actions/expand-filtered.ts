import "server-only";
import { z } from "zod";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import {
  findBuiltinView,
  getSavedView,
  runView,
  type ViewDefinition,
  type ViewFilters,
} from "@/lib/views";
import {
  findBuiltinAccountView,
  getSavedAccountView,
  runAccountView,
  type AccountViewDefinition,
  type AccountViewFilters,
} from "@/lib/account-views";
import {
  findBuiltinContactView,
  getSavedContactView,
  runContactView,
  type ContactViewDefinition,
  type ContactViewFilters,
} from "@/lib/contact-views";
import {
  findBuiltinOpportunityView,
  getSavedOpportunityView,
  runOpportunityView,
  type OpportunityViewDefinition,
  type OpportunityViewFilters,
} from "@/lib/opportunity-views";
import {
  findBuiltinTaskView,
  getSavedTaskView,
  TASK_ASSIGNEE_PRESETS,
  TASK_DUE_RANGE_OPTS,
  TASK_PRIORITY_OPTS,
  TASK_RELATED_ENTITY_OPTS,
  TASK_RELATION_OPTS,
  TASK_STATUS_OPTS,
  type TaskViewDefinition,
  type TaskViewFilters,
} from "@/lib/task-views";
import { listTasksForUser } from "@/lib/tasks";
import type { SessionUser } from "@/lib/auth-helpers";

/**
 * Cap on the matching-set expansion. When the active "all matching"
 * scope resolves to more than this, the expansion stops and the
 * caller emits a cap-hit audit event so retroactive forensics can
 * see which bulk operations clipped their reach. 5,000 covers MWG's
 * typical "all matching" expectation without exposing the action to
 * runaway memory / DB pressure on pathological filter sets.
 */
export const BULK_SCOPE_EXPANSION_CAP = 5_000;

/**
 * Cursor stability contract for bulk-filtered expansion:
 *
 * The page walker uses `lastActivityAt DESC, id DESC` (and the
 * per-entity equivalents) for cursor pagination. The walk is NOT
 * a transactional snapshot — records can be created, updated, or
 * soft-deleted concurrently with the walk. Specifically:
 *
 * - A new record matching the filter created mid-walk that sorts
 *   before the current cursor is silently skipped (it sat outside
 *   the cursor's pagination window when the page was fetched).
 * - A record whose sort key (lastActivityAt) is bumped to a value
 *   newer than the current cursor mid-walk is also skipped — the
 *   cursor WHERE predicate excludes it.
 * - A record whose sort key is moved earlier mid-walk may appear
 *   twice; `walkView` does not dedup, but the downstream bulk
 *   action (bulkTagEntities, etc.) calls `Array.from(new Set(...))`
 *   so duplicates collapse to a single mutation.
 * - A record hard-deleted mid-walk is omitted from subsequent pages
 *   (no row exists to fetch); already-collected ids that get
 *   hard-deleted before the bulk mutation produce a FK error that
 *   rolls back the whole transaction (per `bulkTagEntities`).
 * - A record soft-deleted mid-walk follows the same omit-from-page
 *   rule (the view's `is_deleted=false` filter excludes it).
 *
 * The contract: best-effort eventual consistency over the matching
 * set at walk time. Bulk operations are inherently best-effort
 * against concurrent edits; the consistency guarantee is "every id
 * in the expansion was a match at SOME point during the walk." If
 * stricter consistency is required, the caller should use the
 * explicit `ids` scope shape instead of `filtered`.
 */

const PAGE_SIZE = 200;

/**
 * Surface shape returned by every expand-* function. `capped` is
 * true iff the matching set strictly exceeded
 * {@link BULK_SCOPE_EXPANSION_CAP} and the returned `ids` were
 * truncated.
 */
export interface BulkScopeExpansion {
  ids: string[];
  capped: boolean;
}

// ---------------------------------------------------------------
// Shared filter coercion helpers — the client packs filters as
// strings (CSV for multi-select, "1" for booleans, "" for unset).
// These map the client shape into the server view-filter shape
// without diverging from how each list route already parses
// the same payload.
// ---------------------------------------------------------------

const splitCsv = (s: string | undefined | null): string[] | undefined => {
  if (!s) return undefined;
  const parts = s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return parts.length > 0 ? parts : undefined;
};

const parseNonNegNumeric = (
  raw: string | number | undefined | null,
): number | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
};

// ---------------------------------------------------------------
// Per-entity client filter schemas. Each schema mirrors the client
// component's filter interface plus the `view` string that the
// scope payload pins. Unknown fields pass through (`.passthrough()`)
// because we never re-emit the filter object — we project specific
// fields out.
// ---------------------------------------------------------------

const viewParam = z.string().min(1).max(120);

const leadClientFilters = z
  .object({
    q: z.string().optional(),
    status: z.string().optional(),
    rating: z.string().optional(),
    source: z.string().optional(),
    tag: z.string().optional(),
    view: viewParam,
  })
  .passthrough();

const accountClientFilters = z
  .object({
    q: z.string().optional(),
    owner: z.string().optional(),
    industry: z.string().optional(),
    recentlyUpdatedDays: z.string().optional(),
    tag: z.string().optional(),
    view: viewParam,
  })
  .passthrough();

const contactClientFilters = z
  .object({
    q: z.string().optional(),
    owner: z.string().optional(),
    account: z.string().optional(),
    doNotContact: z.boolean().optional(),
    doNotEmail: z.boolean().optional(),
    doNotCall: z.boolean().optional(),
    doNotMail: z.boolean().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    recentlyUpdatedDays: z.string().optional(),
    tag: z.string().optional(),
    view: viewParam,
  })
  .passthrough();

const opportunityClientFilters = z
  .object({
    q: z.string().optional(),
    owner: z.string().optional(),
    account: z.string().optional(),
    stage: z.string().optional(),
    closingWithinDays: z.string().optional(),
    minAmount: z.string().optional(),
    maxAmount: z.string().optional(),
    tag: z.string().optional(),
    view: viewParam,
  })
  .passthrough();

const taskClientFilters = z
  .object({
    q: z.string().optional(),
    assignee: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    relation: z.string().optional(),
    related: z.string().optional(),
    due: z.string().optional(),
    tag: z.string().optional(),
    view: viewParam,
  })
  .passthrough();

// ---------------------------------------------------------------
// View resolution helpers. Each one mirrors the API route's
// "saved:" vs "builtin:" branching and the canViewAll fallback.
// ---------------------------------------------------------------

async function resolveLeadView(
  userId: string,
  param: string,
  canViewAll: boolean,
): Promise<ViewDefinition | null> {
  if (param.startsWith("saved:")) {
    return getSavedView(userId, param.slice("saved:".length));
  }
  let view = findBuiltinView(param);
  if (view?.requiresAllLeads && !canViewAll) {
    view = findBuiltinView("builtin:my-open");
  }
  return view;
}

async function resolveAccountView(
  userId: string,
  param: string,
  canViewAll: boolean,
): Promise<AccountViewDefinition | null> {
  if (param.startsWith("saved:")) {
    return getSavedAccountView(userId, param.slice("saved:".length));
  }
  let view = findBuiltinAccountView(param);
  if (view?.requiresAllAccounts && !canViewAll) {
    view = findBuiltinAccountView("builtin:my-open");
  }
  return view;
}

async function resolveContactView(
  userId: string,
  param: string,
  canViewAll: boolean,
): Promise<ContactViewDefinition | null> {
  if (param.startsWith("saved:")) {
    return getSavedContactView(userId, param.slice("saved:".length));
  }
  let view = findBuiltinContactView(param);
  if (view?.requiresAllContacts && !canViewAll) {
    view = findBuiltinContactView("builtin:my-open");
  }
  return view;
}

async function resolveOpportunityView(
  userId: string,
  param: string,
  canViewAll: boolean,
): Promise<OpportunityViewDefinition | null> {
  if (param.startsWith("saved:")) {
    return getSavedOpportunityView(userId, param.slice("saved:".length));
  }
  let view = findBuiltinOpportunityView(param);
  if (view?.requiresAllOpportunities && !canViewAll) {
    view = findBuiltinOpportunityView("builtin:my-open");
  }
  return view;
}

async function resolveTaskView(
  userId: string,
  param: string,
  canViewOthers: boolean,
): Promise<TaskViewDefinition | null> {
  if (param.startsWith("saved:")) {
    return getSavedTaskView(userId, param.slice("saved:".length));
  }
  let view = findBuiltinTaskView(param);
  if (view?.id === "builtin:team-open" && !canViewOthers) {
    view = findBuiltinTaskView("builtin:my-open");
  }
  return view;
}

// ---------------------------------------------------------------
// Generic page-walker used by the four non-task entities. Tasks
// uses a parallel implementation because `listTasksForUser` has a
// different signature (no `view` argument; filters flow as direct
// kwargs).
// ---------------------------------------------------------------

async function walkView<T extends { id: string }>(
  fetchPage: (cursor: string | null) => Promise<{
    rows: T[];
    nextCursor: string | null;
  }>,
): Promise<BulkScopeExpansion> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let capped = false;

  while (true) {
    const page = await fetchPage(cursor);
    for (const row of page.rows) {
      if (ids.length >= BULK_SCOPE_EXPANSION_CAP) {
        capped = true;
        break;
      }
      ids.push(row.id);
    }
    if (capped) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { ids, capped };
}

// ---------------------------------------------------------------
// expand-lead
// ---------------------------------------------------------------

export async function expandLeadFilteredScope(args: {
  user: SessionUser;
  canViewAll: boolean;
  filters: unknown;
}): Promise<BulkScopeExpansion> {
  const parsed = leadClientFilters.parse(args.filters);
  const view = await resolveLeadView(args.user.id, parsed.view, args.canViewAll);
  if (!view) return { ids: [], capped: false };

  // Mirror the cursor route's defensive enum filtering — without
  // this, a stale bulk-tag URL re-applies an unknown enum value via
  // `inArray(leads.status, …)` and Postgres rejects on the enum
  // type, surfacing as a 500 in the tag bulk action.
  const enumOne = <T extends readonly string[]>(
    raw: string | undefined,
    allowed: T,
  ): T[number] | undefined =>
    raw && (allowed as readonly string[]).includes(raw)
      ? (raw as T[number])
      : undefined;

  const statusValid = enumOne(parsed.status, LEAD_STATUSES);
  const ratingValid = enumOne(parsed.rating, LEAD_RATINGS);
  const sourceValid = enumOne(parsed.source, LEAD_SOURCES);

  const extraFilters: ViewFilters = {
    search: parsed.q || undefined,
    status: statusValid ? [statusValid] : undefined,
    rating: ratingValid ? [ratingValid] : undefined,
    source: sourceValid ? [sourceValid] : undefined,
    tags: splitCsv(parsed.tag),
  };

  return walkView((cursor) =>
    runView({
      view,
      user: args.user,
      canViewAll: args.canViewAll,
      page: 1,
      pageSize: PAGE_SIZE,
      columns: view.columns,
      extraFilters,
      cursor,
    }).then((r) => ({ rows: r.rows, nextCursor: r.nextCursor })),
  );
}

// ---------------------------------------------------------------
// expand-account
// ---------------------------------------------------------------

export async function expandAccountFilteredScope(args: {
  user: SessionUser;
  canViewAll: boolean;
  filters: unknown;
}): Promise<BulkScopeExpansion> {
  const parsed = accountClientFilters.parse(args.filters);
  const view = await resolveAccountView(
    args.user.id,
    parsed.view,
    args.canViewAll,
  );
  if (!view) return { ids: [], capped: false };

  const extraFilters: AccountViewFilters = {
    search: parsed.q || undefined,
    owner: splitCsv(parsed.owner),
    industry: splitCsv(parsed.industry),
    recentlyUpdatedDays: parseNonNegNumeric(parsed.recentlyUpdatedDays),
    tags: splitCsv(parsed.tag),
  };

  return walkView((cursor) =>
    runAccountView({
      view,
      user: args.user,
      canViewAll: args.canViewAll,
      page: 1,
      pageSize: PAGE_SIZE,
      columns: view.columns,
      extraFilters,
      cursor,
    }).then((r) => ({ rows: r.rows, nextCursor: r.nextCursor })),
  );
}

// ---------------------------------------------------------------
// expand-contact
// ---------------------------------------------------------------

export async function expandContactFilteredScope(args: {
  user: SessionUser;
  canViewAll: boolean;
  filters: unknown;
}): Promise<BulkScopeExpansion> {
  const parsed = contactClientFilters.parse(args.filters);
  const view = await resolveContactView(
    args.user.id,
    parsed.view,
    args.canViewAll,
  );
  if (!view) return { ids: [], capped: false };

  const extraFilters: ContactViewFilters = {
    search: parsed.q || undefined,
    owner: splitCsv(parsed.owner),
    account: splitCsv(parsed.account),
    doNotContact: parsed.doNotContact || undefined,
    doNotEmail: parsed.doNotEmail || undefined,
    doNotCall: parsed.doNotCall || undefined,
    doNotMail: parsed.doNotMail || undefined,
    city: parsed.city || undefined,
    state: parsed.state || undefined,
    country: parsed.country || undefined,
    recentlyUpdatedDays: parseNonNegNumeric(parsed.recentlyUpdatedDays),
    tags: splitCsv(parsed.tag),
  };

  return walkView((cursor) =>
    runContactView({
      view,
      user: args.user,
      canViewAll: args.canViewAll,
      page: 1,
      pageSize: PAGE_SIZE,
      columns: view.columns,
      extraFilters,
      cursor,
    }).then((r) => ({ rows: r.rows, nextCursor: r.nextCursor })),
  );
}

// ---------------------------------------------------------------
// expand-opportunity
// ---------------------------------------------------------------

export async function expandOpportunityFilteredScope(args: {
  user: SessionUser;
  canViewAll: boolean;
  filters: unknown;
}): Promise<BulkScopeExpansion> {
  const parsed = opportunityClientFilters.parse(args.filters);
  const view = await resolveOpportunityView(
    args.user.id,
    parsed.view,
    args.canViewAll,
  );
  if (!view) return { ids: [], capped: false };

  const extraFilters: OpportunityViewFilters = {
    search: parsed.q || undefined,
    owner: splitCsv(parsed.owner),
    account: splitCsv(parsed.account),
    stage: parsed.stage ? [parsed.stage] : undefined,
    closingWithinDays: parseNonNegNumeric(parsed.closingWithinDays),
    minAmount: parseNonNegNumeric(parsed.minAmount),
    maxAmount: parseNonNegNumeric(parsed.maxAmount),
    tags: splitCsv(parsed.tag),
  };

  return walkView((cursor) =>
    runOpportunityView({
      view,
      user: args.user,
      canViewAll: args.canViewAll,
      page: 1,
      pageSize: PAGE_SIZE,
      columns: view.columns,
      extraFilters,
      cursor,
    }).then((r) => ({ rows: r.rows, nextCursor: r.nextCursor })),
  );
}

// ---------------------------------------------------------------
// expand-task. Parallel walker — listTasksForUser's signature is
// not view-shaped so it can't reuse `walkView` directly.
// ---------------------------------------------------------------

export async function expandTaskFilteredScope(args: {
  user: SessionUser;
  canViewOthers: boolean;
  filters: unknown;
}): Promise<BulkScopeExpansion> {
  const parsed = taskClientFilters.parse(args.filters);
  const view = await resolveTaskView(
    args.user.id,
    parsed.view,
    args.canViewOthers,
  );
  if (!view) return { ids: [], capped: false };

  const filterEnum = <T extends readonly string[]>(
    raw: string | undefined,
    allowed: T,
  ): T[number] | undefined =>
    raw && (allowed as readonly string[]).includes(raw)
      ? (raw as T[number])
      : undefined;

  const filterEnumList = <T extends readonly string[]>(
    raw: string | undefined,
    allowed: T,
  ): T[number][] | undefined => {
    const parts = splitCsv(raw);
    if (!parts) return undefined;
    const filtered = parts.filter((v): v is T[number] =>
      (allowed as readonly string[]).includes(v),
    );
    return filtered.length > 0 ? filtered : undefined;
  };

  const assignee =
    parsed.assignee &&
    ((TASK_ASSIGNEE_PRESETS as readonly string[]).includes(parsed.assignee) ||
      /^[a-zA-Z0-9-]+$/.test(parsed.assignee))
      ? (parsed.assignee as TaskViewFilters["assignee"])
      : undefined;
  const statusList = filterEnumList(parsed.status, TASK_STATUS_OPTS);
  const priorityList = filterEnumList(parsed.priority, TASK_PRIORITY_OPTS);
  const relation = filterEnum(parsed.relation, TASK_RELATION_OPTS);
  const relatedEntity = filterEnum(parsed.related, TASK_RELATED_ENTITY_OPTS);
  const dueRange = filterEnum(parsed.due, TASK_DUE_RANGE_OPTS);

  const overlay: Partial<TaskViewFilters> = {
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(assignee ? { assignee } : {}),
    ...(statusList ? { status: statusList } : {}),
    ...(priorityList ? { priority: priorityList } : {}),
    ...(relation ? { relation } : {}),
    ...(relatedEntity ? { relatedEntity } : {}),
    ...(dueRange ? { dueRange } : {}),
    ...(parsed.tag ? { tags: splitCsv(parsed.tag) } : {}),
  };

  const filters: TaskViewFilters = { ...view.filters, ...overlay };
  if (filters.assignee === "any" && !args.canViewOthers) {
    filters.assignee = "me";
  }

  const ids: string[] = [];
  let cursor: string | null = null;
  let capped = false;

  while (true) {
    const page = await listTasksForUser({
      userId: args.user.id,
      isAdmin: args.user.isAdmin,
      assignee: filters.assignee,
      status: filters.status,
      priority: filters.priority,
      relation: filters.relation,
      relatedEntity: filters.relatedEntity,
      dueRange: filters.dueRange,
      q: filters.q,
      tags: filters.tags,
      sort: view.sort,
      cursor,
      pageSize: PAGE_SIZE,
    });
    for (const row of page.rows) {
      if (ids.length >= BULK_SCOPE_EXPANSION_CAP) {
        capped = true;
        break;
      }
      ids.push(row.id);
    }
    if (capped) break;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { ids, capped };
}
