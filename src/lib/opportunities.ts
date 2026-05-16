import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { cascadeMarker, cascadeMarkerSql } from "@/lib/cascade-archive";
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

/** Cascade soft-delete / restore counts for an opportunity. */
export interface OpportunityCascadeResult {
  cascadedTasks: number;
  cascadedActivities: number;
}

/**
 * Cascade-archive opportunities and their dependent tasks/activities in
 * one transaction (STANDARDS 19.1.1). Cascaded children carry the
 * opportunity-scoped sentinel `__cascade__:opportunity:<id>` so restore
 * is selective (account-driven cascades use the account sentinel, so an
 * opportunity archived inside an account closure restores with that
 * account, not on its own).
 *
 * @actor opportunity owner or admin (caller enforces)
 */
export async function archiveOpportunitiesById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<OpportunityCascadeResult> {
  if (ids.length === 0) return { cascadedTasks: 0, cascadedActivities: 0 };
  return db.transaction(async (tx) => {
    await tx
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
    const cascadedTasks = await tx
      .update(tasks)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("opportunity", tasks.opportunityId),
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(tasks.opportunityId, ids),
          eq(tasks.isDeleted, false),
        ),
      )
      .returning({ id: tasks.id });
    const cascadedActivities = await tx
      .update(activities)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("opportunity", activities.opportunityId),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(activities.opportunityId, ids),
          eq(activities.isDeleted, false),
        ),
      )
      .returning({ id: activities.id });
    return {
      cascadedTasks: cascadedTasks.length,
      cascadedActivities: cascadedActivities.length,
    };
  });
}

/** Per-row optimistic-concurrency input for bulk opportunity archive. */
export interface OpportunityArchiveRow {
  id: string;
  version: number;
}

/**
 * Bulk archive opportunities with per-row optimistic concurrency. A
 * row is archived only when its on-disk `version` still matches the
 * version the client loaded; rows another writer moved are returned in
 * `conflicts` untouched (no silent lost update — closes the asymmetry
 * where single-row opportunity edits enforced OCC but bulk archive did
 * not). The whole batch (opportunity flips + child tasks/activities
 * cascade) runs in one transaction (STANDARDS 19.1.1).
 *
 * Mirrors `bulkArchiveAccounts`: the caller filters to permitted rows
 * first, then this enforces OCC and cascades the opportunity-scoped
 * sentinel so restore stays selective.
 *
 * @actor opportunity owner or admin (caller enforces per-record
 * permission)
 */
export async function bulkArchiveOpportunities(
  rows: OpportunityArchiveRow[],
  actorId: string,
  reason?: string,
): Promise<
  { updated: string[]; conflicts: string[] } & OpportunityCascadeResult
> {
  if (rows.length === 0) {
    return {
      updated: [],
      conflicts: [],
      cascadedTasks: 0,
      cascadedActivities: 0,
    };
  }
  return db.transaction(async (tx) => {
    const updated: string[] = [];
    const conflicts: string[] = [];
    for (const row of rows) {
      const claimed = await tx
        .update(opportunities)
        .set({
          isDeleted: true,
          deletedAt: sql`now()`,
          deletedById: actorId,
          deleteReason: reason ?? null,
          updatedById: actorId,
          updatedAt: sql`now()`,
          version: sql`${opportunities.version} + 1`,
        })
        .where(
          and(
            eq(opportunities.id, row.id),
            eq(opportunities.version, row.version),
            eq(opportunities.isDeleted, false),
          ),
        )
        .returning({ id: opportunities.id });
      if (claimed.length === 1) {
        updated.push(row.id);
        continue;
      }
      // 0 rows: distinguish a stale version (conflict) from an
      // already-archived no-op (idempotent skip). Probe the live row
      // in-transaction — consistent with the bulk task OCC fns
      // (STANDARDS 1.8 sibling parity).
      const [live] = await tx
        .select({ version: opportunities.version })
        .from(opportunities)
        .where(eq(opportunities.id, row.id))
        .limit(1);
      if (live && live.version !== row.version) conflicts.push(row.id);
      // else: already archived at the same version — idempotent no-op.
    }
    if (updated.length === 0) {
      return { updated, conflicts, cascadedTasks: 0, cascadedActivities: 0 };
    }
    const cascadedTasks = await tx
      .update(tasks)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("opportunity", tasks.opportunityId),
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(tasks.opportunityId, updated),
          eq(tasks.isDeleted, false),
        ),
      )
      .returning({ id: tasks.id });
    const cascadedActivities = await tx
      .update(activities)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql(
          "opportunity",
          activities.opportunityId,
        ),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(activities.opportunityId, updated),
          eq(activities.isDeleted, false),
        ),
      )
      .returning({ id: activities.id });
    return {
      updated,
      conflicts,
      cascadedTasks: cascadedTasks.length,
      cascadedActivities: cascadedActivities.length,
    };
  });
}

/**
 * Restore archived opportunities and exactly the tasks/activities THIS
 * opportunity's archive cascaded (opportunity-scoped sentinel match).
 * One transaction.
 *
 * @actor admin only (caller enforces)
 */
export async function restoreOpportunitiesById(
  ids: string[],
  actorId: string,
): Promise<OpportunityCascadeResult> {
  if (ids.length === 0) return { cascadedTasks: 0, cascadedActivities: 0 };
  return db.transaction(async (tx) => {
    await tx
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
    let cascadedTasks = 0;
    let cascadedActivities = 0;
    for (const id of ids) {
      const marker = cascadeMarker("opportunity", id);
      const t = await tx
        .update(tasks)
        .set({
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
          deleteReason: null,
          updatedById: actorId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(tasks.opportunityId, id),
            eq(tasks.isDeleted, true),
            eq(tasks.deleteReason, marker),
          ),
        )
        .returning({ id: tasks.id });
      const a = await tx
        .update(activities)
        .set({
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
          deleteReason: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(activities.opportunityId, id),
            eq(activities.isDeleted, true),
            eq(activities.deleteReason, marker),
          ),
        )
        .returning({ id: activities.id });
      cascadedTasks += t.length;
      cascadedActivities += a.length;
    }
    return { cascadedTasks, cascadedActivities };
  });
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


// ---------------------------------------------------------------------------
// Archived (soft-deleted) opportunities — cursor-paginated list for admin
// archive page. Sort fixed `(deleted_at DESC, id DESC)`.
// ---------------------------------------------------------------------------

export interface ArchivedOpportunityCursorRow {
  id: string;
  name: string;
  stage: (typeof OPPORTUNITY_STAGES)[number];
  deletedAt: Date | null;
  reason: string | null;
  deletedById: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
}

export async function listArchivedOpportunitiesCursor(args: {
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ArchivedOpportunityCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const baseWhere = eq(opportunities.isDeleted, true);
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) {
      return sql`(${opportunities.deletedAt} IS NULL AND ${opportunities.id} < ${parsedCursor.id})`;
    }
    return sql`(
      ${opportunities.deletedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${opportunities.deletedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${opportunities.id} < ${parsedCursor.id})
      OR ${opportunities.deletedAt} IS NULL
    )`;
  })();
  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: opportunities.id,
        name: opportunities.name,
        stage: opportunities.stage,
        deletedAt: opportunities.deletedAt,
        reason: opportunities.deleteReason,
        deletedById: opportunities.deletedById,
        deletedByEmail: users.email,
        deletedByName: users.displayName,
      })
      .from(opportunities)
      .leftJoin(users, eq(users.id, opportunities.deletedById))
      .where(finalWhere)
      .orderBy(
        sql`${opportunities.deletedAt} DESC NULLS LAST`,
        desc(opportunities.id),
      )
      .limit(pageSize + 1),
    db.select({ n: count() }).from(opportunities).where(baseWhere),
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
