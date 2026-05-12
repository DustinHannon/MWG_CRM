import "server-only";
import { eq, and, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Phase 11 — soft-delete query helpers.
 *
 * The codebase uses Drizzle's column references rather than the
 * query-builder chain Supabase JS exposes, so the brief's
 * `query.eq('is_deleted', false)` form doesn't fit. Instead these
 * helpers return SQL fragments that callers compose into their `where`
 * clauses.
 *
 *   const conds = [withActive(leads.isDeleted), eq(leads.ownerId, user.id)];
 *   const rows = await db.select().from(leads).where(and(...conds));
 */

/** Fragment that filters out soft-deleted rows. */
export function withActive(isDeletedColumn: PgColumn): SQL {
  return eq(isDeletedColumn, false);
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
