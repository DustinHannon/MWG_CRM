import "server-only";
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { ConflictError, NotFoundError } from "@/lib/errors";

/** Minimal executor surface satisfied by both `db` and a transaction handle. */
type Executor = Pick<typeof db, "execute">;

/**
 * Typed conflict/not-found inference for callers that already issued a
 * Drizzle update with `.returning()`. Pass the returned-rows array; if
 * empty, this probes whether the row exists and throws the appropriate
 * typed error.
 *
 * empty rows + row exists → `ConflictError` (version mismatch / stale write).
 * empty rows + row absent → `NotFoundError`.
 * non-empty rows → no-op.
 *
 * When the UPDATE was issued inside an explicit transaction, pass that
 * transaction handle as `executor` so the existence probe observes the same
 * (possibly uncommitted) snapshot as the UPDATE. Without it the probe runs on
 * the pooled module-level `db`, which cannot see uncommitted rows (yielding a
 * spurious `NotFoundError`) and, under the app pool's `max: 1`, would contend
 * with the open transaction for the single connection.
 */
export async function expectAffected(
  rowsReturned: unknown[],
  args: {
    table: PgTable & { id: { name: string } };
    id: string;
    entityLabel?: string;
    executor?: Executor;
  },
) {
  if (rowsReturned.length > 0) return;
  const idCol = args.table.id.name;
  const tableName = getTableName(args.table);
  if (!tableName || !idCol) {
    // Drizzle's public name accessors returned empty — the table shape is not
    // what we expect (e.g. an internal-API change on upgrade). Fail loudly
    // here rather than interpolate an empty identifier into raw SQL.
    throw new Error(
      `expectAffected: could not resolve table/column name (table=${String(
        tableName,
      )}, idCol=${String(idCol)})`,
    );
  }
  const executor = args.executor ?? db;
  const exists = await executor.execute(
    sql`SELECT 1 FROM ${sql.identifier(tableName)}
        WHERE ${sql.identifier(idCol)} = ${args.id} LIMIT 1`,
  );
  if (exists.length === 0) {
    throw new NotFoundError(args.entityLabel ?? "record");
  }
  throw new ConflictError(
    "This record was modified by someone else. Refresh to see their changes, then try again.",
    { id: args.id },
  );
}
