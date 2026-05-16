import "server-only";
import { sql, type SQL, type Column } from "drizzle-orm";
import { z } from "zod";

/**
 * Cascade-archive sentinel.
 *
 * When a parent entity (lead / account / contact / opportunity) is
 * soft-deleted, its dependent child rows (tasks, activities, and — for
 * accounts — child contacts/opportunities) are also soft-deleted so they
 * stop appearing in active feeds, "due today" notifications, scoring,
 * reports, and the public API. Because `is_deleted` is a plain UPDATE
 * (not a DB cascade — that only fires on hard-delete), every read path's
 * existing `is_deleted = false` filter then excludes them automatically.
 *
 * The cascade is reversible. A child archived *by the cascade* carries
 * this exact sentinel in its existing `delete_reason` column; restore
 * reactivates ONLY rows whose `delete_reason` equals the sentinel, so a
 * child the user archived independently *before* the parent is NOT
 * resurrected when the parent is restored.
 *
 * Format: `__cascade__:<parent>:<parentId>`. The `__cascade__:` prefix
 * is reserved — user-supplied delete reasons must never start with it
 * (free-text reason inputs are short human strings; collision is
 * implausible and the double-underscore sentinel makes it impossible in
 * practice). This is data in an existing column, not schema — no
 * migration, no enum.
 *
 * SINGLE SOURCE OF TRUTH: every cascade sentinel — the archive-side
 * write ({@link cascadeMarkerSql} / {@link cascadeMarkerSqlFromExpr}),
 * the restore-side match ({@link cascadeMarker}), and the
 * reserved-namespace guard ({@link isCascadeMarker}) — derives from the
 * one `CASCADE_PREFIX` constant below. Do not hand-build the literal
 * anywhere else: a split definition between the archive write and the
 * restore match silently orphans cascade-archived children forever (no
 * error, no audit) the moment the two drift.
 */
export type CascadeParent = "lead" | "account" | "contact" | "opportunity";

const CASCADE_PREFIX = "__cascade__:";

/** Build the sentinel written into a cascaded child's `delete_reason`. */
export function cascadeMarker(
  parent: CascadeParent,
  parentId: string,
): string {
  return `${CASCADE_PREFIX}${parent}:${parentId}`;
}

/**
 * True when a delete reason is a cascade sentinel (any parent). Used to
 * reject user-supplied reasons that would collide with the reserved
 * namespace.
 */
export function isCascadeMarker(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(CASCADE_PREFIX);
}

/**
 * Build the Drizzle `sql` expression that the ARCHIVE side writes into a
 * cascaded child's `delete_reason`, from a child column holding the
 * parent id (e.g. `tasks.leadId`).
 *
 * This is the single source of truth shared with {@link cascadeMarker}:
 * both derive the sentinel from the one `CASCADE_PREFIX` constant, so a
 * future prefix/format change propagates to BOTH the archive write and
 * the restore match. (Previously the archive side hard-coded
 * `'__cascade__:<entity>:' || col::text` inline in 8 SQL sites while
 * restore used `cascadeMarker()`/`CASCADE_PREFIX`; a one-sided edit
 * would have silently orphaned every cascade-archived child — no error,
 * no audit. Keep this the ONLY place the literal appears on the archive
 * side.)
 *
 * The prefix is interpolated as a bind parameter, so the emitted SQL is
 * `$1 || <parentIdCol>::text` — byte-identical in result to the prior
 * `'<prefix><parent>:' || col::text` literal form, and provably equal
 * to `cascadeMarker(parent, id)` for the same id because the column is
 * cast with `::text` exactly as the verbatim-uuid value `cascadeMarker`
 * formats. INVARIANT (unit-safe): for any parent `p` and uuid `id`,
 * the value produced by `cascadeMarkerSql(p, idCol)` for a row whose
 * `idCol = id` equals `cascadeMarker(p, id)` — restore's exact-equality
 * match depends on this and must never diverge.
 */
export function cascadeMarkerSql(
  parent: CascadeParent,
  parentIdCol: Column,
): SQL {
  return sql`${`${CASCADE_PREFIX}${parent}:`} || ${parentIdCol}::text`;
}

/**
 * Same sentinel as {@link cascadeMarkerSql} but the parent id is
 * supplied as a pre-built text SQL expression rather than a single
 * column — used by the account closure where a grandchild
 * task/activity resolves its owning account via
 * `COALESCE(account_id::text, (subquery), (subquery))`. The expression
 * MUST already yield text (the COALESCE branches cast `::text`); this
 * helper does not add a cast so it composes around arbitrary text
 * expressions. Shares the one `CASCADE_PREFIX` literal with
 * {@link cascadeMarker} / {@link cascadeMarkerSql} so archive and
 * restore can never silently diverge.
 */
export function cascadeMarkerSqlFromExpr(
  parent: CascadeParent,
  parentIdTextExpr: SQL,
): SQL {
  return sql`${`${CASCADE_PREFIX}${parent}:`} || ${parentIdTextExpr}`;
}

/**
 * Per-row optimistic-concurrency input for every bulk mutation that
 * enforces OCC (bulk task complete/reassign/delete, bulk lead/account
 * archive). Each entry pins the `version` the client loaded so the
 * server skips (and reports) rows another writer moved — no silent
 * lost update. Replaces the old ids-only `string[]` bulk payload for
 * OCC-enforced paths.
 *
 * The 500 cap is the existing per-selection bulk cap (these are
 * direct-id paths, not filter-scope-expanded — that is the separate
 * BULK_SCOPE_EXPANSION_CAP=5000 in STANDARDS 19.6.2).
 */
export const bulkRowVersionsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        version: z.coerce.number().int().positive(),
      }),
    )
    .min(1)
    .max(500),
});

export type BulkRowVersionsInput = z.infer<typeof bulkRowVersionsSchema>;
export type BulkRowVersion = BulkRowVersionsInput["items"][number];

/**
 * Bulk reassign payload: row-versioned items + the new assignee.
 */
export const bulkReassignRowVersionsSchema = bulkRowVersionsSchema.extend({
  newAssigneeId: z.string().uuid(),
});

export type BulkReassignRowVersionsInput = z.infer<
  typeof bulkReassignRowVersionsSchema
>;
