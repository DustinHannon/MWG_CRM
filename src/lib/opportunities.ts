import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, opportunities } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";

// Re-export for server-side callers that previously imported the
// constant from this module.
export { OPPORTUNITY_STAGES };

/**
 * Phase 9C (workflow) — direct Opportunity creation, separate from
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
 * Phase 9C (workflow) — contact picker support for the New Opportunity
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

/** Phase 10 — soft-delete opportunities. */
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(opportunities.id, ids));
}

/** Phase 10 — restore archived opportunities. */
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(opportunities.id, ids));
}

/** Phase 10 — admin hard-delete. */
export async function deleteOpportunitiesById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(opportunities).where(inArray(opportunities.id, ids));
}

/**
 * Phase 13 — paginated opportunity listing for /api/v1/opportunities.
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
