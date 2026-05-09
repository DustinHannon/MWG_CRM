import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";
import { urlField } from "@/lib/validation/primitives";

/**
 * Phase 9C (workflow) — direct Account creation from `/accounts/new`,
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
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(20_000).optional().nullable(),
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
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
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
 * Phase 9C (workflow) — pickable account list for the New Contact /
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
 * Phase 10 — soft delete (archive). Sets `is_deleted=true` and the
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(crmAccounts.id, ids));
}

/**
 * Phase 10 — restore archived accounts.
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(crmAccounts.id, ids));
}

/**
 * Phase 10 — admin hard-delete. Cascades through opportunities and
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
 * Phase 13 — paginated account listing for /api/v1/accounts.
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
 * Phase 13 — partial update with optional optimistic concurrency.
 *
 * When `expectedVersion` is provided, the UPDATE filters on it and
 * throws `ConflictError` (via expectAffected) when it doesn't match.
 * When omitted, last-write-wins semantics apply.
 */
export async function updateAccountForApi(
  id: string,
  patch: Partial<{
    name: string;
    industry: string | null;
    website: string | null;
    phone: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    description: string | null;
    ownerId: string | null;
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
