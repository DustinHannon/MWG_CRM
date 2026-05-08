import "server-only";
import { eq, and, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SessionUser } from "@/lib/auth-helpers";
import { getPermissions } from "@/lib/auth-helpers";

/**
 * Phase 11 — soft-delete + per-viewer scope helpers.
 *
 * The codebase uses Drizzle's column references rather than the
 * query-builder chain Supabase JS exposes, so the brief's
 * `query.eq('is_deleted', false)` form doesn't fit. Instead these
 * helpers return SQL fragments that callers compose into their `where`
 * clauses.
 *
 *   const conds = [withActive(leads.isDeleted), eq(leads.ownerId, user.id)];
 *   const rows = await db.select().from(leads).where(and(...conds));
 *
 * `withScope` resolves the viewer's permission row once and returns a
 * filter that either no-ops (admin / can_view_all_records) or pins to
 * `ownerColumn = viewer.id`.
 */

/** Fragment that filters out soft-deleted rows. */
export function withActive(isDeletedColumn: PgColumn): SQL {
  return eq(isDeletedColumn, false);
}

/** Fragment that filters to soft-deleted rows only. */
export function withArchived(isDeletedColumn: PgColumn): SQL {
  return eq(isDeletedColumn, true);
}

/**
 * Returns a where-fragment scoping a query to the viewer's allowed
 * data. Returns `undefined` if the viewer can see everything (admin or
 * can_view_all_records); call sites should `and(...)` the result with
 * their other conditions, dropping any undefined.
 */
export async function withScope(
  user: SessionUser,
  ownerColumn: PgColumn,
): Promise<SQL | undefined> {
  if (user.isAdmin) return undefined;
  const perms = await getPermissions(user.id);
  if (perms.canViewAllRecords) return undefined;
  return eq(ownerColumn, user.id);
}

/**
 * Combine fragments, dropping undefined. Convenience wrapper so call
 * sites don't have to filter undefined out manually.
 */
export function combine(...frags: Array<SQL | undefined>): SQL | undefined {
  const present = frags.filter((f): f is SQL => f !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}
