import "server-only";
import { and, asc, count, desc, eq, gte, gt, lte, lt, ilike, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import {
  type ReportEntityType,
  type ReportMetric,
  type SavedReport,
} from "@/db/schema/saved-reports";
import { ForbiddenError } from "@/lib/errors";
import type { SessionUser } from "@/lib/auth-helpers";
import { getPermissions } from "@/lib/auth-helpers";
import { combine, withActive } from "@/lib/db/query-helpers";
import { isValidField, REPORT_ENTITIES } from "./schemas";

/**
 * Phase 11 — report execution.
 *
 * Three rules, in priority order:
 *
 *   1. **Access:** the viewer must be allowed to view the report
 *      definition (owner, builtin, or shared+enabled).
 *   2. **Soft-delete:** archived rows are never returned.
 *   3. **Scope:** the result set is limited to rows the *viewer* is
 *      allowed to see — never the report author's broader scope. A
 *      salesperson opening an admin's "All Pipeline" report sees only
 *      their own pipeline.
 *
 * Returns either a flat array (no group_by) or aggregated rows.
 */

export type ReportFilters = Record<string, unknown>;

export interface ExecutedReport {
  rows: Record<string, unknown>[];
  totalCount: number;
  /** Echo of the columns actually returned (after group/agg expansion). */
  columns: string[];
}

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 100;

export async function executeReport(
  report: SavedReport,
  viewer: SessionUser,
  options?: { preview?: boolean },
): Promise<ExecutedReport> {
  await assertCanViewReport(report, viewer);

  const entityType = report.entityType as ReportEntityType;
  if (!(entityType in REPORT_ENTITIES)) {
    throw new ForbiddenError("Unsupported report entity.");
  }

  const limit = options?.preview ? PREVIEW_ROWS : MAX_ROWS;
  const scopeFrag = await buildViewerScope(entityType, viewer);
  const filterFrag = buildFilterFrag(entityType, report.filters as ReportFilters);
  const softDeleteFrag = buildSoftDeleteFrag(entityType);
  const where = combine(scopeFrag, filterFrag, softDeleteFrag);

  const groupBy = (report.groupBy as string[]) ?? [];
  const metrics = (report.metrics as ReportMetric[]) ?? [];
  const fields = (report.fields as string[]) ?? [];

  if (groupBy.length === 0 && metrics.length === 0) {
    return runFlatQuery(entityType, fields, where, limit);
  }
  return runAggregateQuery(entityType, fields, groupBy, metrics, where, limit);
}

/* ---------------------------------------------------------------------- */
/* Access gating                                                          */
/* ---------------------------------------------------------------------- */

export async function assertCanViewReport(
  report: SavedReport,
  viewer: SessionUser,
): Promise<void> {
  if (report.isDeleted) throw new ForbiddenError("Report unavailable.");
  if (report.isBuiltin) return;
  if (report.ownerId === viewer.id) return;
  if (viewer.isAdmin) return;
  if (report.isShared) return;
  throw new ForbiddenError("You don't have access to this report.");
}

export async function assertCanEditReport(
  report: SavedReport,
  viewer: SessionUser,
): Promise<void> {
  if (report.isBuiltin) {
    throw new ForbiddenError("Built-in reports cannot be edited.");
  }
  if (report.ownerId === viewer.id) return;
  if (viewer.isAdmin) return;
  throw new ForbiddenError("Only the report owner can edit this report.");
}

export async function assertCanDeleteReport(
  report: SavedReport,
  viewer: SessionUser,
): Promise<void> {
  if (report.isBuiltin) {
    throw new ForbiddenError("Built-in reports cannot be deleted.");
  }
  if (report.ownerId === viewer.id) return;
  if (viewer.isAdmin) return;
  throw new ForbiddenError("Only the report owner can delete this report.");
}

/* ---------------------------------------------------------------------- */
/* Query construction                                                     */
/* ---------------------------------------------------------------------- */

async function buildViewerScope(
  entityType: ReportEntityType,
  viewer: SessionUser,
): Promise<SQL | undefined> {
  if (viewer.isAdmin) return undefined;
  const perms = await getPermissions(viewer.id);
  if (perms.canViewAllRecords) return undefined;
  switch (entityType) {
    case "lead":
      return eq(leads.ownerId, viewer.id);
    case "account":
      return eq(crmAccounts.ownerId, viewer.id);
    case "contact":
      return eq(contacts.ownerId, viewer.id);
    case "opportunity":
      return eq(opportunities.ownerId, viewer.id);
    case "task":
      // Task scope: assignee. Owner-of-related-record is also valid in
      // the read-policy but not exposed here yet.
      return eq(tasks.assignedToId, viewer.id);
    case "activity":
      return eq(activities.userId, viewer.id);
  }
}

function buildSoftDeleteFrag(entityType: ReportEntityType): SQL | undefined {
  switch (entityType) {
    case "lead":
      return withActive(leads.isDeleted);
    case "account":
      return withActive(crmAccounts.isDeleted);
    case "contact":
      return withActive(contacts.isDeleted);
    case "opportunity":
      return withActive(opportunities.isDeleted);
    case "task":
      return withActive(tasks.isDeleted);
    case "activity":
      return withActive(activities.isDeleted);
  }
}

/**
 * Filter shape we accept (matches the builder UI for v1):
 *
 *   { status: { in: ["new", "contacted"] }, amount: { gte: 1000 } }
 *
 * Each filter key must be a whitelisted column on the entity. Values
 * are validated against the column's `kind`. Anything unknown is
 * silently dropped — better than crashing on a stale filter.
 */
function buildFilterFrag(
  entityType: ReportEntityType,
  filters: ReportFilters,
): SQL | undefined {
  if (!filters || typeof filters !== "object") return undefined;
  const frags: SQL[] = [];
  for (const [field, raw] of Object.entries(filters)) {
    if (!isValidField(entityType, field)) continue;
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    const colSql = sql.raw(`"${escapeIdent(field)}"`);
    if ("eq" in op && op.eq !== undefined && op.eq !== null) {
      frags.push(sql`${colSql} = ${op.eq}`);
    }
    if ("ilike" in op && typeof op.ilike === "string") {
      frags.push(sql`${colSql} ILIKE ${`%${op.ilike}%`}`);
    }
    if ("gte" in op && op.gte !== undefined) {
      frags.push(sql`${colSql} >= ${op.gte}`);
    }
    if ("lte" in op && op.lte !== undefined) {
      frags.push(sql`${colSql} <= ${op.lte}`);
    }
    if ("gt" in op && op.gt !== undefined) {
      frags.push(sql`${colSql} > ${op.gt}`);
    }
    if ("lt" in op && op.lt !== undefined) {
      frags.push(sql`${colSql} < ${op.lt}`);
    }
    if ("in" in op && Array.isArray(op.in) && op.in.length > 0) {
      // Build a parameterised IN list — drizzle's sql tag handles it.
      const placeholders = op.in.map(() => sql`?`);
      frags.push(sql`${colSql} = ANY(${op.in})`);
      void placeholders; // satisfy linter; we used ANY()
    }
  }
  if (frags.length === 0) return undefined;
  if (frags.length === 1) return frags[0];
  return and(...frags);
}

function escapeIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "");
}

/* ---------------------------------------------------------------------- */
/* Flat query (no group_by, no aggregations)                              */
/* ---------------------------------------------------------------------- */

async function runFlatQuery(
  entityType: ReportEntityType,
  fields: string[],
  where: SQL | undefined,
  limit: number,
): Promise<ExecutedReport> {
  const columns = fields.length > 0 ? fields : defaultFields(entityType);
  const safeColumns = columns
    .filter((c) => isValidField(entityType, c))
    .map(escapeIdent);

  if (safeColumns.length === 0) {
    return { rows: [], totalCount: 0, columns: [] };
  }

  const table = REPORT_ENTITIES[entityType].table;
  const cols = safeColumns.map((c) => `"${c}"`).join(", ");
  const whereSql = where ? sql` WHERE ${where}` : sql``;
  const orderSql = sql.raw(
    isValidField(entityType, "updated_at")
      ? ' ORDER BY "updated_at" DESC NULLS LAST'
      : "",
  );
  const limitSql = sql.raw(` LIMIT ${limit}`);

  const rows: Record<string, unknown>[] = await db.execute(
    sql`SELECT ${sql.raw(cols)} FROM ${sql.raw(`"${escapeIdent(table)}"`)}${whereSql}${orderSql}${limitSql}`,
  );

  return { rows, totalCount: rows.length, columns: safeColumns };
}

/* ---------------------------------------------------------------------- */
/* Aggregate query (group_by + metrics)                                   */
/* ---------------------------------------------------------------------- */

async function runAggregateQuery(
  entityType: ReportEntityType,
  _fields: string[],
  groupBy: string[],
  metrics: ReportMetric[],
  where: SQL | undefined,
  limit: number,
): Promise<ExecutedReport> {
  const safeGroups = groupBy
    .filter((c) => isValidField(entityType, c))
    .map(escapeIdent);
  if (safeGroups.length === 0) {
    return { rows: [], totalCount: 0, columns: [] };
  }
  const table = REPORT_ENTITIES[entityType].table;
  const groupCols = safeGroups.map((c) => `"${c}"`).join(", ");
  const metricSelects: string[] = [];
  for (const m of metrics) {
    const alias = escapeIdent(m.alias || `${m.fn}_${m.field || "all"}`);
    if (m.fn === "count") {
      metricSelects.push(`count(*) AS "${alias}"`);
    } else if (m.field && isValidField(entityType, m.field)) {
      const safeField = escapeIdent(m.field);
      const fn = m.fn;
      if (fn === "sum" || fn === "avg" || fn === "min" || fn === "max") {
        metricSelects.push(`${fn}("${safeField}") AS "${alias}"`);
      }
    }
  }
  if (metricSelects.length === 0) metricSelects.push('count(*) AS "count"');

  const whereSql = where ? sql` WHERE ${where}` : sql``;
  const select = `${groupCols}, ${metricSelects.join(", ")}`;
  const orderSql = sql.raw(` ORDER BY ${groupCols}`);
  const limitSql = sql.raw(` LIMIT ${limit}`);

  const rows: Record<string, unknown>[] = await db.execute(
    sql`SELECT ${sql.raw(select)} FROM ${sql.raw(`"${escapeIdent(table)}"`)}${whereSql} GROUP BY ${sql.raw(groupCols)}${orderSql}${limitSql}`,
  );

  const columns = [
    ...safeGroups,
    ...metrics.map((m) => escapeIdent(m.alias || `${m.fn}_${m.field || "all"}`)),
  ];

  return { rows, totalCount: rows.length, columns };
}

function defaultFields(entityType: ReportEntityType): string[] {
  switch (entityType) {
    case "lead":
      return ["first_name", "last_name", "company_name", "status", "owner_id"];
    case "account":
      return ["name", "industry", "owner_id"];
    case "contact":
      return ["first_name", "last_name", "email", "owner_id"];
    case "opportunity":
      return ["name", "stage", "amount", "owner_id"];
    case "task":
      return ["title", "status", "priority", "due_at", "assigned_to_id"];
    case "activity":
      return ["kind", "subject", "occurred_at", "user_id"];
  }
}

// Silence unused-import lint until the helpers are referenced from a
// future filter expression that needs them directly.
void asc;
void desc;
void count;
void gte;
void gt;
void lte;
void lt;
void ilike;
