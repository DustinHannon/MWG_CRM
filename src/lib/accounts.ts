import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import { expectAffected } from "@/lib/db/concurrent-update";
import { ConflictError } from "@/lib/errors";
import { urlField } from "@/lib/validation/primitives";

/**
 * direct Account creation from `/accounts/new`,
 * separate from the lead-conversion path. The conversion path lives in
 * `src/lib/conversion.ts` and stays single-transaction; this is the
 * stand-alone "I already know who this customer is" entry point.
 *
 * Schema mirrors the columns the convert flow populates (name + a small
 * core of optional fields). Address fields are accepted but optional —
 * the form keeps the create surface small; users edit details from the
 * account detail page after the fact.
 */
export const accountCreateSchema = z.object({
  name: z.string().trim().min(1, "Required").max(200),
  industry: z.string().trim().max(100).optional().nullable(),
  website: urlField.or(z.literal("")).optional().nullable(),
  phone: z.string().trim().max(60).optional().nullable(),
  email: z
    .string()
    .trim()
    .email("Not a valid email")
    .max(254)
    .or(z.literal(""))
    .optional()
    .nullable(),
  accountNumber: z.string().trim().max(100).optional().nullable(),
  numberOfEmployees: z.coerce.number().int().min(0).max(10_000_000).optional().nullable(),
  annualRevenue: z.coerce.number().min(0).optional().nullable(),
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(20_000).optional().nullable(),
  parentAccountId: z.string().uuid().optional().nullable(),
  primaryContactId: z.string().uuid().optional().nullable(),
});

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/**
 * Insert a new account. Owner defaults to the actor when not supplied.
 * Audit row written best-effort by the calling server action via
 * `writeAudit` so the function stays usable from import / batch flows.
 */
export async function createAccount(
  input: AccountCreateInput,
  actorId: string,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(crmAccounts)
    .values({
      name: input.name,
      industry: input.industry ?? null,
      website: input.website ? input.website : null,
      phone: input.phone ?? null,
      email: input.email ? input.email : null,
      accountNumber: input.accountNumber ?? null,
      numberOfEmployees: input.numberOfEmployees ?? null,
      annualRevenue:
        input.annualRevenue != null ? input.annualRevenue.toFixed(2) : null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
      parentAccountId: input.parentAccountId ?? null,
      primaryContactId: input.primaryContactId ?? null,
      ownerId: actorId,
      createdById: actorId,
    })
    .returning({ id: crmAccounts.id });

  await writeAudit({
    actorId,
    action: "account.create",
    targetType: "crm_accounts",
    targetId: inserted[0].id,
    after: { name: input.name },
  });

  return { id: inserted[0].id };
}

/**
 * pickable account list for the New Contact /
 * New Opportunity forms. Returns up to 500 accounts visible to the
 * caller, sorted alphabetically. The brief calls out autocomplete as
 * a future polish; today we render a plain `<select>` and 500 is
 * comfortable for that. Owner-scope mirrors the listing pages.
 */
export async function listAccountsForPicker(
  actorId: string,
  canViewAll: boolean,
): Promise<Array<{ id: string; name: string }>> {
  const wheres = [eq(crmAccounts.isDeleted, false)];
  if (!canViewAll) wheres.push(eq(crmAccounts.ownerId, actorId));
  const rows = await db
    .select({ id: crmAccounts.id, name: crmAccounts.name })
    .from(crmAccounts)
    .where(and(...wheres))
    .orderBy(asc(crmAccounts.name))
    .limit(500);
  return rows;
}

/**
 * soft delete (archive). Sets `is_deleted=true` and the
 * deletion-attribution columns on a batch of accounts.
 *
 * @actor account owner or admin (caller enforces)
 */
export async function archiveAccountsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(crmAccounts)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: reason ?? null,
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(crmAccounts.id, ids));
}

/**
 * restore archived accounts.
 *
 * @actor admin only (caller enforces)
 */
export async function restoreAccountsById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(crmAccounts)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(crmAccounts.id, ids));
}

/**
 * admin hard-delete. Cascades through opportunities and
 * contacts via FK ON DELETE SET NULL / CASCADE depending on the link.
 * Use only from admin flows.
 *
 * @actor admin only (caller enforces)
 */
export async function deleteAccountsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(crmAccounts).where(inArray(crmAccounts.id, ids));
}

/**
 * paginated account listing for /api/v1/accounts.
 *
 * Mirrors the inline query on `/(app)/accounts/page.tsx` but returns
 * the offset-pagination envelope the v1 API contract requires
 * (page / pageSize / total). UI keeps using cursor pagination — these
 * paths do not interfere.
 */
export async function listAccountsForApi(args: {
  q?: string;
  ownerId?: string;
  page: number;
  pageSize: number;
  ownerScope: { actorId: string; canViewAll: boolean };
}): Promise<{
  rows: Array<typeof crmAccounts.$inferSelect>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const wheres = [eq(crmAccounts.isDeleted, false)];
  if (args.q) wheres.push(ilike(crmAccounts.name, `%${args.q}%`));
  if (args.ownerId) wheres.push(eq(crmAccounts.ownerId, args.ownerId));
  if (!args.ownerScope.canViewAll) {
    wheres.push(eq(crmAccounts.ownerId, args.ownerScope.actorId));
  }
  const where = and(...wheres);
  const offset = (args.page - 1) * args.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(crmAccounts)
      .where(where)
      .orderBy(desc(crmAccounts.updatedAt), desc(crmAccounts.id))
      .limit(args.pageSize)
      .offset(offset),
    db.select({ n: count() }).from(crmAccounts).where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    page: args.page,
    pageSize: args.pageSize,
  };
}

/** Fetch single account by id; returns null when missing or soft-deleted. */
export async function getAccountForApi(
  id: string,
  ownerScope: { actorId: string; canViewAll: boolean },
): Promise<typeof crmAccounts.$inferSelect | null> {
  const wheres = [eq(crmAccounts.id, id), eq(crmAccounts.isDeleted, false)];
  if (!ownerScope.canViewAll) {
    wheres.push(eq(crmAccounts.ownerId, ownerScope.actorId));
  }
  const [row] = await db
    .select()
    .from(crmAccounts)
    .where(and(...wheres))
    .limit(1);
  return row ?? null;
}

/**
 * partial update with optional optimistic concurrency.
 *
 * When `expectedVersion` is provided, the UPDATE filters on it and
 * throws `ConflictError` (via expectAffected) when it doesn't match.
 * When omitted, last-write-wins semantics apply.
 */
/**
 * Walk the parent_account_id chain starting from `proposedParentId`
 * and throw `ConflictError` if `selfId` appears anywhere in the chain.
 * Blocks multi-hop cycles like A→B→A (single-hop A→A is already
 * blocked by the `crm_accounts_no_self_parent` CHECK constraint).
 *
 * Bounded at 64 hops as a safety net against runaway loops; in
 * practice the chain length is far smaller.
 */
export async function assertNoParentCycle(
  selfId: string,
  proposedParentId: string | null,
): Promise<void> {
  if (proposedParentId == null) return;
  if (proposedParentId === selfId) {
    // Defense-in-depth — the DB CHECK already catches this.
    throw new ConflictError("An account cannot be its own parent.");
  }
  let cursor: string | null = proposedParentId;
  for (let hop = 0; hop < 64 && cursor != null; hop++) {
    if (cursor === selfId) {
      throw new ConflictError(
        "Parent assignment would create a cycle in the account hierarchy.",
      );
    }
    const [row] = await db
      .select({ parent: crmAccounts.parentAccountId })
      .from(crmAccounts)
      .where(eq(crmAccounts.id, cursor))
      .limit(1);
    if (!row) return;
    cursor = row.parent;
  }
}

export async function updateAccountForApi(
  id: string,
  patch: Partial<{
    name: string;
    industry: string | null;
    website: string | null;
    phone: string | null;
    email: string | null;
    accountNumber: string | null;
    numberOfEmployees: number | null;
    annualRevenue: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    description: string | null;
    ownerId: string | null;
    parentAccountId: string | null;
    primaryContactId: string | null;
  }>,
  expectedVersion: number | undefined,
  actorId: string,
): Promise<{ id: string; version: number }> {
  const set: Record<string, unknown> = {
    ...patch,
    updatedById: actorId,
    updatedAt: sql`now()`,
    version: sql`${crmAccounts.version} + 1`,
  };
  const wheres = [eq(crmAccounts.id, id), eq(crmAccounts.isDeleted, false)];
  if (typeof expectedVersion === "number") {
    wheres.push(eq(crmAccounts.version, expectedVersion));
  }
  const rows = await db
    .update(crmAccounts)
    .set(set)
    .where(and(...wheres))
    .returning({ id: crmAccounts.id, version: crmAccounts.version });
  expectAffected(rows, { table: crmAccounts, id, entityLabel: "account" });
  return rows[0];
}

/**
 * Filter shape for the canonical cursor-paginated list. Sort is fixed
 * `(updated_at DESC, id DESC)` so the query stays on the partial index
 * `crm_accounts_updated_at_id_idx`.
 */
export interface AccountCursorFilters {
  q?: string;
  ownerId?: string;
  industry?: string;
}

export interface AccountCursorRow {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  annualRevenue: string | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Canonical cursor-paginated list. Sort is fixed
 * `(updated_at DESC, id DESC)`. Returns `{ data, nextCursor, total }`.
 *
 * Permission scoping mirrors `listAccountsForApi`: non-admin without
 * `canViewAllRecords` sees only their own.
 */
export async function listAccountsCursor(args: {
  actorId: string;
  isAdmin: boolean;
  canViewAll: boolean;
  filters: AccountCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: AccountCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { actorId, isAdmin, canViewAll, filters } = args;

  const wheres = [eq(crmAccounts.isDeleted, false)];
  if (filters.q) wheres.push(ilike(crmAccounts.name, `%${filters.q}%`));
  if (filters.ownerId) wheres.push(eq(crmAccounts.ownerId, filters.ownerId));
  if (filters.industry) wheres.push(eq(crmAccounts.industry, filters.industry));
  if (!isAdmin && !canViewAll) {
    wheres.push(eq(crmAccounts.ownerId, actorId));
  }
  const baseWhere = and(...wheres);

  // updated_at is NOT NULL on crm_accounts, so the cursor comparison
  // skips the NULL-block expansion required by leads.
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = parsedCursor && parsedCursor.ts
    ? sql`(
        ${crmAccounts.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
        OR (${crmAccounts.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${crmAccounts.id} < ${parsedCursor.id})
      )`
    : undefined;

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: crmAccounts.id,
        name: crmAccounts.name,
        industry: crmAccounts.industry,
        website: crmAccounts.website,
        phone: crmAccounts.phone,
        email: crmAccounts.email,
        city: crmAccounts.city,
        state: crmAccounts.state,
        ownerId: crmAccounts.ownerId,
        ownerDisplayName: users.displayName,
        annualRevenue: crmAccounts.annualRevenue,
        updatedAt: crmAccounts.updatedAt,
        createdAt: crmAccounts.createdAt,
      })
      .from(crmAccounts)
      .leftJoin(users, eq(crmAccounts.ownerId, users.id))
      .where(finalWhere)
      .orderBy(desc(crmAccounts.updatedAt), desc(crmAccounts.id))
      .limit(pageSize + 1),
    db.select({ n: count() }).from(crmAccounts).where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.updatedAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Archived (soft-deleted) accounts — cursor-paginated list for the admin
// archive page. Sort fixed `(deleted_at DESC, id DESC)`. Admin-only at the
// route layer.
// ---------------------------------------------------------------------------

export interface ArchivedAccountCursorRow {
  id: string;
  name: string;
  industry: string | null;
  deletedAt: Date | null;
  reason: string | null;
  deletedById: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
}

export async function listArchivedAccountsCursor(args: {
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ArchivedAccountCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const baseWhere = eq(crmAccounts.isDeleted, true);
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) {
      return sql`(${crmAccounts.deletedAt} IS NULL AND ${crmAccounts.id} < ${parsedCursor.id})`;
    }
    return sql`(
      ${crmAccounts.deletedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${crmAccounts.deletedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${crmAccounts.id} < ${parsedCursor.id})
      OR ${crmAccounts.deletedAt} IS NULL
    )`;
  })();
  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: crmAccounts.id,
        name: crmAccounts.name,
        industry: crmAccounts.industry,
        deletedAt: crmAccounts.deletedAt,
        reason: crmAccounts.deleteReason,
        deletedById: crmAccounts.deletedById,
        deletedByEmail: users.email,
        deletedByName: users.displayName,
      })
      .from(crmAccounts)
      .leftJoin(users, eq(users.id, crmAccounts.deletedById))
      .where(finalWhere)
      .orderBy(sql`${crmAccounts.deletedAt} DESC NULLS LAST`, desc(crmAccounts.id))
      .limit(pageSize + 1),
    db.select({ n: count() }).from(crmAccounts).where(baseWhere),
  ]);

  let data = rowsRaw;
  let nextCursor: string | null = null;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.deletedAt, last.id, "desc");
  }
  return { data, nextCursor, total: totalRow[0]?.n ?? 0 };
}
