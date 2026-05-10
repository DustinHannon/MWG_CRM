import "server-only";
import { sqlClient } from "@/db";
import {
  MARKETING_REPORT_ENTITY_TYPES,
  type ReportEntityType,
  type ReportMetric,
  type SavedReport,
} from "@/db/schema/saved-reports";
import { ForbiddenError } from "@/lib/errors";
import type { SessionUser } from "@/lib/auth-helpers";
import { getPermissions } from "@/lib/auth-helpers";
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
 *
 * Implementation note (post-smoke fix): the dynamic-columns nature of
 * a report builder doesn't fit Drizzle's typed query builder, and
 * Drizzle's `sql` template tag misbehaves when mixing `sql.raw` for
 * identifier substitution with parameterized child fragments. So this
 * file goes through the raw postgres-js tag instead. Identifiers are
 * pre-validated against the report schema whitelist (`isValidField`)
 * and re-escaped (`escapeIdent`) before string interpolation.
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

/* ---------------------------------------------------------------------- */
/* Identifier safety                                                      */
/* ---------------------------------------------------------------------- */

function escapeIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "");
}

function quote(ident: string): string {
  return `"${escapeIdent(ident)}"`;
}

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */

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
  const params: unknown[] = [];
  const conditions: string[] = [];

  // 1. soft-delete (only when the table has the column — marketing
  // entities like marketing_email_events / email_send_log are
  // append-only and have no soft-delete column).
  const softDeleteCol = REPORT_ENTITIES[entityType].softDeleteColumn;
  if (softDeleteCol) {
    conditions.push(`${quote(softDeleteCol)} = false`);
  }

  // 2. viewer scope
  const scope = await buildViewerScope(entityType, viewer);
  if (scope) {
    const placeholder = `$${params.length + 1}`;
    params.push(scope.value);
    conditions.push(`${quote(scope.column)} = ${placeholder}`);
  }

  // 3. user-defined filters
  const userFilters = buildFilterClauses(
    entityType,
    (report.filters as ReportFilters) ?? {},
    params,
  );
  for (const c of userFilters) conditions.push(c);

  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const groupBy = (report.groupBy as string[]) ?? [];
  const metrics = (report.metrics as ReportMetric[]) ?? [];
  const fields = (report.fields as string[]) ?? [];

  if (groupBy.length === 0 && metrics.length === 0) {
    return runFlatQuery(entityType, fields, whereSql, params, limit);
  }
  return runAggregateQuery(entityType, groupBy, metrics, whereSql, params, limit);
}

/* ---------------------------------------------------------------------- */
/* Access gating                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Marketing-entity reports are gated to admins + users with the
 * canManageMarketing permission. Returns true when the viewer is
 * allowed to access the entity type, false otherwise.
 */
async function canViewMarketingEntity(viewer: SessionUser): Promise<boolean> {
  if (viewer.isAdmin) return true;
  const perms = await getPermissions(viewer.id);
  return perms.canManageMarketing === true;
}

export async function assertCanViewReport(
  report: SavedReport,
  viewer: SessionUser,
): Promise<void> {
  if (report.isDeleted) throw new ForbiddenError("Report unavailable.");

  // Phase 24 — marketing-entity gate. Applied BEFORE owner/builtin/shared
  // checks so a non-marketing user can't bypass via a shared-report or
  // builtin marketing report.
  const entityType = report.entityType as ReportEntityType;
  if (
    (MARKETING_REPORT_ENTITY_TYPES as readonly string[]).includes(entityType)
  ) {
    if (!(await canViewMarketingEntity(viewer))) {
      throw new ForbiddenError(
        "Marketing reports require admin or marketing manager role.",
      );
    }
  }

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
  // Marketing-entity reports require the marketing permission to edit
  // — same gate as view.
  const entityType = report.entityType as ReportEntityType;
  if (
    (MARKETING_REPORT_ENTITY_TYPES as readonly string[]).includes(entityType)
  ) {
    if (!(await canViewMarketingEntity(viewer))) {
      throw new ForbiddenError(
        "Marketing reports require admin or marketing manager role.",
      );
    }
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
/* Where-clause builders                                                  */
/* ---------------------------------------------------------------------- */

async function buildViewerScope(
  entityType: ReportEntityType,
  viewer: SessionUser,
): Promise<{ column: string; value: string } | undefined> {
  if (viewer.isAdmin) return undefined;
  const perms = await getPermissions(viewer.id);
  if (perms.canViewAllRecords) return undefined;
  switch (entityType) {
    case "lead":
      return { column: "owner_id", value: viewer.id };
    case "account":
      return { column: "owner_id", value: viewer.id };
    case "contact":
      return { column: "owner_id", value: viewer.id };
    case "opportunity":
      return { column: "owner_id", value: viewer.id };
    case "task":
      return { column: "assigned_to_id", value: viewer.id };
    case "activity":
      return { column: "user_id", value: viewer.id };
    // Marketing entities — access is gated at assertCanViewReport
    // (admin OR canManageMarketing). Once past that gate, no per-row
    // viewer scope applies; marketing data isn't per-user-owned.
    case "marketing_campaign":
    case "marketing_email_event":
    case "email_send_log":
      return undefined;
  }
}

/**
 * Filter shape we accept (matches the builder UI for v1):
 *
 *   { status: { in: ["new", "contacted"] }, amount: { gte: 1000 } }
 *
 * Each filter key must be a whitelisted column on the entity. Values
 * are pushed onto the shared `params` array; the returned strings
 * include `$N` placeholders pointing at those slots.
 */
function buildFilterClauses(
  entityType: ReportEntityType,
  filters: ReportFilters,
  params: unknown[],
): string[] {
  if (!filters || typeof filters !== "object") return [];
  const out: string[] = [];
  for (const [field, raw] of Object.entries(filters)) {
    if (!isValidField(entityType, field)) continue;
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    // Cast on the column side so enum-typed columns (lead.status,
    // opportunity.stage, task.status, task.priority, etc.) compare
    // cleanly against the JSON-encoded string filter values without
    // per-enum type knowledge. Plain text columns are unaffected.
    const colExpr = `${quote(field)}::text`;
    if ("eq" in op && op.eq !== undefined && op.eq !== null) {
      params.push(String(op.eq));
      out.push(`${colExpr} = $${params.length}`);
    }
    if ("ilike" in op && typeof op.ilike === "string") {
      params.push(`%${op.ilike}%`);
      out.push(`${colExpr} ILIKE $${params.length}`);
    }
    if ("gte" in op && op.gte !== undefined) {
      params.push(op.gte);
      out.push(`${colExpr} >= $${params.length}`);
    }
    if ("lte" in op && op.lte !== undefined) {
      params.push(op.lte);
      out.push(`${colExpr} <= $${params.length}`);
    }
    if ("gt" in op && op.gt !== undefined) {
      params.push(op.gt);
      out.push(`${colExpr} > $${params.length}`);
    }
    if ("lt" in op && op.lt !== undefined) {
      params.push(op.lt);
      out.push(`${colExpr} < $${params.length}`);
    }
    if ("in" in op && Array.isArray(op.in) && op.in.length > 0) {
      const stringValues = op.in.map((v) => String(v));
      params.push(stringValues);
      out.push(`${colExpr} = ANY($${params.length}::text[])`);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Flat query (no group_by, no aggregations)                              */
/* ---------------------------------------------------------------------- */

async function runFlatQuery(
  entityType: ReportEntityType,
  fields: string[],
  whereSql: string,
  params: unknown[],
  limit: number,
): Promise<ExecutedReport> {
  const columns = fields.length > 0 ? fields : defaultFields(entityType);
  const safeColumns = columns
    .filter((c) => isValidField(entityType, c))
    .map(escapeIdent);

  if (safeColumns.length === 0) {
    return { rows: [], totalCount: 0, columns: [] };
  }

  const meta = REPORT_ENTITIES[entityType];
  const cols = safeColumns.map(quote).join(", ");
  const orderClause = isValidField(entityType, "updated_at")
    ? ' ORDER BY "updated_at" DESC NULLS LAST'
    : "";
  const sqlText = `SELECT ${cols} FROM ${quote(meta.table)}${whereSql}${orderClause} LIMIT ${Number(limit) | 0}`;

  const rows = (await sqlClient.unsafe(sqlText, params as never[])) as Record<
    string,
    unknown
  >[];

  return { rows, totalCount: rows.length, columns: safeColumns };
}

/* ---------------------------------------------------------------------- */
/* Aggregate query (group_by + metrics)                                   */
/* ---------------------------------------------------------------------- */

async function runAggregateQuery(
  entityType: ReportEntityType,
  groupBy: string[],
  metrics: ReportMetric[],
  whereSql: string,
  params: unknown[],
  limit: number,
): Promise<ExecutedReport> {
  const safeGroups = groupBy
    .filter((c) => isValidField(entityType, c))
    .map(escapeIdent);
  if (safeGroups.length === 0) {
    return { rows: [], totalCount: 0, columns: [] };
  }
  const meta = REPORT_ENTITIES[entityType];
  const groupCols = safeGroups.map(quote).join(", ");
  const metricSelects: string[] = [];
  const aliasOut: string[] = [];
  for (const m of metrics) {
    const alias = escapeIdent(m.alias || `${m.fn}_${m.field || "all"}`);
    if (m.fn === "count") {
      metricSelects.push(`count(*) AS "${alias}"`);
      aliasOut.push(alias);
    } else if (m.field && isValidField(entityType, m.field)) {
      const safeField = escapeIdent(m.field);
      const fn = m.fn;
      if (fn === "sum" || fn === "avg" || fn === "min" || fn === "max") {
        metricSelects.push(`${fn}(${quote(safeField)}) AS "${alias}"`);
        aliasOut.push(alias);
      }
    }
  }
  if (metricSelects.length === 0) {
    metricSelects.push('count(*) AS "count"');
    aliasOut.push("count");
  }

  const select = `${groupCols}, ${metricSelects.join(", ")}`;
  const sqlText = `SELECT ${select} FROM ${quote(meta.table)}${whereSql} GROUP BY ${groupCols} ORDER BY ${groupCols} LIMIT ${Number(limit) | 0}`;

  const rows = (await sqlClient.unsafe(sqlText, params as never[])) as Record<
    string,
    unknown
  >[];

  return {
    rows,
    totalCount: rows.length,
    columns: [...safeGroups, ...aliasOut],
  };
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
    case "marketing_campaign":
      return [
        "name",
        "status",
        "sent_at",
        "total_sent",
        "total_delivered",
        "total_opened",
        "total_clicked",
      ];
    case "marketing_email_event":
      return ["email", "event_type", "event_timestamp", "campaign_id", "reason"];
    case "email_send_log":
      return [
        "from_user_email_snapshot",
        "to_email",
        "feature",
        "subject",
        "status",
        "queued_at",
      ];
  }
}
