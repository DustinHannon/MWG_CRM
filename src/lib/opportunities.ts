import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import { expectAffected } from "@/lib/db/concurrent-update";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";

// Re-export for server-side callers that previously imported the
// constant from this module.
export { OPPORTUNITY_STAGES };

/**
 * direct Opportunity creation, separate from
 * the lead-conversion path (`src/lib/conversion.ts`). Conversion stays
 * the canonical entry point; this is the "I already have an account"
 * shortcut and powers the New Opportunity buttons on `/opportunities`
 * and on `/accounts/[id]`.
 *
 * Schema enforces account_id (the brief: "Required Account picker").
 * Stage defaults to prospecting. `closed_at` stays NULL on insert; the
 * existing stage-transition path (in opportunities edit / pipeline)
 * stamps it when the row first hits closed_won/closed_lost.
 */
export const opportunityCreateSchema = z.object({
  accountId: z.string().uuid("Account is required"),
  primaryContactId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1, "Required").max(200),
  stage: z.enum(OPPORTUNITY_STAGES).default("prospecting"),
  amount: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n.toFixed(2) : null;
    }),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  description: z.string().trim().max(20_000).optional().nullable(),
});

export type OpportunityCreateInput = z.infer<typeof opportunityCreateSchema>;

export async function createOpportunity(
  input: OpportunityCreateInput,
  actorId: string,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(opportunities)
    .values({
      accountId: input.accountId,
      primaryContactId: input.primaryContactId || null,
      name: input.name,
      stage: input.stage,
      amount: input.amount,
      expectedCloseDate: input.expectedCloseDate ?? null,
      description: input.description ?? null,
      ownerId: actorId,
      createdById: actorId,
      // closed_at is set by stage-transition wiring; leave NULL on
      // create even when stage=closed_won (treat that as the rare
      // import-from-spreadsheet case and require an edit to backfill).
    })
    .returning({ id: opportunities.id });

  await writeAudit({
    actorId,
    action: "opportunity.create",
    targetType: "opportunities",
    targetId: inserted[0].id,
    after: {
      name: input.name,
      accountId: input.accountId,
      stage: input.stage,
    },
  });

  return { id: inserted[0].id };
}

/**
 * contact picker support for the New Opportunity
 * form. Returns up to 200 contacts on a given account, sorted by name.
 * Empty list when no account selected.
 */
export async function listContactsForAccountPicker(
  accountId: string | null,
): Promise<Array<{ id: string; firstName: string; lastName: string | null }>> {
  if (!accountId) return [];
  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(
      and(eq(contacts.accountId, accountId), eq(contacts.isDeleted, false)),
    )
    .orderBy(asc(contacts.firstName), asc(contacts.lastName))
    .limit(200);
  return rows;
}

/** soft-delete opportunities. */
export async function archiveOpportunitiesById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(opportunities)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: reason ?? null,
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(opportunities.id, ids));
}

/** restore archived opportunities. */
export async function restoreOpportunitiesById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(opportunities)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(opportunities.id, ids));
}

/** admin hard-delete. */
export async function deleteOpportunitiesById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(opportunities).where(inArray(opportunities.id, ids));
}

/**
 * paginated opportunity listing for /api/v1/opportunities.
 */
export async function listOpportunitiesForApi(args: {
  q?: string;
  stage?: string;
  accountId?: string;
  ownerId?: string;
  page: number;
  pageSize: number;
  ownerScope: { actorId: string; canViewAll: boolean };
}): Promise<{
  rows: Array<typeof opportunities.$inferSelect>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const wheres = [eq(opportunities.isDeleted, false)];
  if (args.q) wheres.push(ilike(opportunities.name, `%${args.q}%`));
  if (args.stage) {
    wheres.push(
      sql`${opportunities.stage}::text = ${args.stage}`,
    );
  }
  if (args.accountId) wheres.push(eq(opportunities.accountId, args.accountId));
  if (args.ownerId) wheres.push(eq(opportunities.ownerId, args.ownerId));
  if (!args.ownerScope.canViewAll) {
    wheres.push(eq(opportunities.ownerId, args.ownerScope.actorId));
  }
  const where = and(...wheres);
  const offset = (args.page - 1) * args.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(opportunities)
      .where(where)
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
      .limit(args.pageSize)
      .offset(offset),
    db.select({ n: count() }).from(opportunities).where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    page: args.page,
    pageSize: args.pageSize,
  };
}

export async function getOpportunityForApi(
  id: string,
  ownerScope: { actorId: string; canViewAll: boolean },
): Promise<typeof opportunities.$inferSelect | null> {
  const wheres = [eq(opportunities.id, id), eq(opportunities.isDeleted, false)];
  if (!ownerScope.canViewAll) {
    wheres.push(eq(opportunities.ownerId, ownerScope.actorId));
  }
  const [row] = await db
    .select()
    .from(opportunities)
    .where(and(...wheres))
    .limit(1);
  return row ?? null;
}

export async function updateOpportunityForApi(
  id: string,
  patch: Partial<{
    accountId: string;
    primaryContactId: string | null;
    name: string;
    stage: (typeof OPPORTUNITY_STAGES)[number];
    amount: string | null;
    expectedCloseDate: string | null;
    description: string | null;
  }>,
  expectedVersion: number | undefined,
  actorId: string,
): Promise<{ id: string; version: number }> {
  const set: Record<string, unknown> = {
    ...patch,
    updatedById: actorId,
    updatedAt: sql`now()`,
    version: sql`${opportunities.version} + 1`,
  };
  const wheres = [eq(opportunities.id, id), eq(opportunities.isDeleted, false)];
  if (typeof expectedVersion === "number") {
    wheres.push(eq(opportunities.version, expectedVersion));
  }
  const rows = await db
    .update(opportunities)
    .set(set)
    .where(and(...wheres))
    .returning({
      id: opportunities.id,
      version: opportunities.version,
    });
  expectAffected(rows, {
    table: opportunities,
    id,
    entityLabel: "opportunity",
  });
  return rows[0];
}

/**
 * Filter shape for the canonical cursor-paginated opportunity list.
 * Sort is fixed `(updated_at DESC, id DESC)` so the query stays on the
 * partial index `opportunities_updated_at_id_idx`.
 */
export interface OpportunityCursorFilters {
  q?: string;
  stage?: (typeof OPPORTUNITY_STAGES)[number];
  accountId?: string;
  ownerId?: string;
}

export interface OpportunityCursorRow {
  id: string;
  name: string;
  stage: (typeof OPPORTUNITY_STAGES)[number];
  amount: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  accountId: string | null;
  accountName: string | null;
  primaryContactId: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  closedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Canonical cursor-paginated opportunity list. Sort fixed
 * `(updated_at DESC, id DESC)`. Returns `{ data, nextCursor, total }`.
 *
 * Permission scoping mirrors `listOpportunitiesForApi`: non-admin
 * without `canViewAllRecords` sees only their own.
 */
export async function listOpportunitiesCursor(args: {
  actorId: string;
  isAdmin: boolean;
  canViewAll: boolean;
  filters: OpportunityCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: OpportunityCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { actorId, isAdmin, canViewAll, filters } = args;

  const wheres = [eq(opportunities.isDeleted, false)];
  if (filters.q) wheres.push(ilike(opportunities.name, `%${filters.q}%`));
  if (filters.stage) wheres.push(eq(opportunities.stage, filters.stage));
  if (filters.accountId) {
    wheres.push(eq(opportunities.accountId, filters.accountId));
  }
  if (filters.ownerId) wheres.push(eq(opportunities.ownerId, filters.ownerId));
  if (!isAdmin && !canViewAll) {
    wheres.push(eq(opportunities.ownerId, actorId));
  }
  const baseWhere = and(...wheres);

  // updated_at is NOT NULL on opportunities.
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = parsedCursor && parsedCursor.ts
    ? sql`(
        ${opportunities.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
        OR (${opportunities.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${opportunities.id} < ${parsedCursor.id})
      )`
    : undefined;

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        stage: opportunities.stage,
        amount: opportunities.amount,
        probability: opportunities.probability,
        expectedCloseDate: opportunities.expectedCloseDate,
        accountId: opportunities.accountId,
        accountName: crmAccounts.name,
        primaryContactId: opportunities.primaryContactId,
        ownerId: opportunities.ownerId,
        ownerDisplayName: users.displayName,
        closedAt: opportunities.closedAt,
        updatedAt: opportunities.updatedAt,
        createdAt: opportunities.createdAt,
      })
      .from(opportunities)
      .leftJoin(crmAccounts, eq(opportunities.accountId, crmAccounts.id))
      .leftJoin(users, eq(opportunities.ownerId, users.id))
      .where(finalWhere)
      .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
      .limit(pageSize + 1),
    db.select({ n: count() }).from(opportunities).where(baseWhere),
  ]);

  // Drop the unused contacts symbol reference to keep tree-shaking
  // honest. (Kept for parity with other lib files that join through
  // contacts; opportunities lists currently don't display contact
  // names so we don't join here.)
  void contacts;

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
