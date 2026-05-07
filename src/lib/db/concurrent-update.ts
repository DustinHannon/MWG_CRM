import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { ConflictError, NotFoundError } from "@/lib/errors";

/**
 * Optimistic-concurrency UPDATE wrapper.
 *
 * Every mutable record in the schema has a `version int NOT NULL DEFAULT 1`
 * column. Forms read it and post it back; this helper requires that the
 * current row still has the same version, refuses if not, and bumps it on
 * write.
 *
 * The result of the UPDATE is the new row, so callers can immediately
 * re-render with the next version.
 *
 * @throws NotFoundError  if the row no longer exists.
 * @throws ConflictError  if the version on disk has moved since the caller read it.
 */
export async function concurrentUpdate<T extends Record<string, unknown>>(args: {
  // PgTable that has `id: uuid` and `version: integer` columns. We accept any
  // table; the caller is responsible for picking one with those columns.
  table: PgTable & {
    id: { name: string };
    version: { name: string };
    updated_at?: unknown;
  };
  id: string;
  expectedVersion: number;
  patch: T;
  /** Optional `updatedAt` column name to set to now() — defaults to `updated_at`. */
  updatedAtColumn?: string;
  /** Optional human label for the entity, used in error messages. */
  entityLabel?: string;
}) {
  const updatedAtCol = args.updatedAtColumn ?? "updated_at";
  // We use sql template here so we can set updated_at and version in the
  // same statement without mucking with Drizzle's typed updaters; this
  // helper is a narrow utility intended for forms with arbitrary patches.
  const idCol = (args.table as unknown as { id: { name: string } }).id.name;
  const versionCol = (args.table as unknown as { version: { name: string } })
    .version.name;
  const tableName = (args.table as unknown as { _: { name: string } })._.name;

  const setClauses: SQL[] = [];
  for (const [k, v] of Object.entries(args.patch)) {
    setClauses.push(sql`${sql.identifier(k)} = ${v}`);
  }
  setClauses.push(sql`${sql.identifier(updatedAtCol)} = now()`);
  setClauses.push(
    sql`${sql.identifier(versionCol)} = ${args.expectedVersion + 1}`,
  );
  const setSql = sql.join(setClauses, sql`, `);

  // RETURNING * gives caller the updated row.
  const rows = await db.execute(
    sql`UPDATE ${sql.identifier(tableName)} SET ${setSql}
        WHERE ${sql.identifier(idCol)} = ${args.id}
          AND ${sql.identifier(versionCol)} = ${args.expectedVersion}
        RETURNING *`,
  );

  if (rows.length === 0) {
    // Either record doesn't exist or version mismatched. Find out which.
    const exists = await db.execute(
      sql`SELECT 1 FROM ${sql.identifier(tableName)}
          WHERE ${sql.identifier(idCol)} = ${args.id} LIMIT 1`,
    );
    if (exists.length === 0) {
      throw new NotFoundError(args.entityLabel ?? "record");
    }
    throw new ConflictError(
      "This record was modified by someone else. Refresh to see their changes, then try again.",
      { id: args.id, expectedVersion: args.expectedVersion },
    );
  }
  return rows[0] as T & { version: number };
}

/**
 * Typed alternative for callers that already have a Drizzle update builder.
 * Drizzle returns `result.rowCount`-equivalent via the `.returning()` array;
 * the same conflict-vs-not-found inference applies.
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
