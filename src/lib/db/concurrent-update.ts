import "server-only";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { ConflictError, NotFoundError } from "@/lib/errors";

/**
 * Typed conflict/not-found inference for callers that already issued a
 * Drizzle update with `.returning()`. Pass the returned-rows array; if
 * empty, this probes whether the row exists and throws the appropriate
 * typed error.
 *
 * empty rows + row exists → `ConflictError` (version mismatch / stale write).
 * empty rows + row absent → `NotFoundError`.
 * non-empty rows → no-op.
 */
export async function expectAffected(
  rowsReturned: unknown[],
  args: {
    table: PgTable & { id: { name: string } };
    id: string;
    entityLabel?: string;
  },
) {
  if (rowsReturned.length > 0) return;
  const idCol = (args.table as unknown as { id: { name: string } }).id.name;
  const tableName = (args.table as unknown as { _: { name: string } })._.name;
  const exists = await db.execute(
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
