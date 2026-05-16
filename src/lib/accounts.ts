import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import {
  cascadeMarker,
  cascadeMarkerSql,
  cascadeMarkerSqlFromExpr,
} from "@/lib/cascade-archive";
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

/** Per-row optimistic-concurrency input for bulk account archive. */
export interface AccountArchiveRow {
  id: string;
  version: number;
}

/**
 * Cascade soft-delete / restore counts. An account's closure spans its
 * own child contacts & opportunities plus the tasks/activities of the
 * account AND of those child contacts/opportunities.
 */
export interface AccountCascadeResult {
  cascadedContacts: number;
  cascadedOpportunities: number;
  cascadedTasks: number;
  cascadedActivities: number;
}

/**
 * Cascade-archive accounts and their full dependent closure.
 *
 * Keeps the `string[]` signature for non-OCC callers (single-record
 * soft-delete action, public `/api/v1` delete, restore-undo). Bulk OCC
 * callers use `bulkArchiveAccounts`.
 *
 * Closure (one transaction — STANDARDS 19.1.1): the account row, then
 * its child `contacts` and `opportunities` (these are child *entities*
 * of the account in CRM terms — an archived account's contacts/opps
 * must not stay active), then every task/activity linked to the
 * account OR to one of those just-archived child contacts/opps. Every
 * cascaded row carries the SAME account-scoped sentinel
 * `__cascade__:account:<accountId>` so `restore` reactivates the whole
 * closure together and leaves independently-archived rows alone.
 *
 * NOTE: soft-delete cascades to contacts (different from the *hard*-
 * delete FK where `contacts.account_id` is ON DELETE SET NULL and
 * contacts survive — that asymmetry is intentional: hard-delete is
 * irreversible so it preserves contacts, soft-delete is reversible so
 * it can safely take them down and bring them back).
 *
 * @actor account owner or admin (caller enforces)
 */
export async function archiveAccountsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<AccountCascadeResult> {
  if (ids.length === 0) {
    return {
      cascadedContacts: 0,
      cascadedOpportunities: 0,
      cascadedTasks: 0,
      cascadedActivities: 0,
    };
  }
  return db.transaction(async (tx) => {
    await tx
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
    return cascadeArchiveAccountClosure(tx, ids, actorId);
  });
}

/**
 * Bulk archive accounts with per-row optimistic concurrency. A row is
 * archived only when its on-disk `version` still matches; moved rows
 * are returned in `conflicts` untouched (closes the silent-lost-update
 * gap — single-row account edits enforce OCC, bulk archive did not).
 * Whole batch (account flips + full closure) in one transaction.
 *
 * @actor account owner or admin (caller enforces per-record permission)
 */
export async function bulkArchiveAccounts(
  rows: AccountArchiveRow[],
  actorId: string,
  reason?: string,
): Promise<
  { updated: string[]; conflicts: string[] } & AccountCascadeResult
> {
  if (rows.length === 0) {
    return {
      updated: [],
      conflicts: [],
      cascadedContacts: 0,
      cascadedOpportunities: 0,
      cascadedTasks: 0,
      cascadedActivities: 0,
    };
  }
  return db.transaction(async (tx) => {
    const updated: string[] = [];
    const conflicts: string[] = [];
    for (const row of rows) {
      const claimed = await tx
        .update(crmAccounts)
        .set({
          isDeleted: true,
          deletedAt: sql`now()`,
          deletedById: actorId,
          deleteReason: reason ?? null,
          updatedById: actorId,
          updatedAt: sql`now()`,
          version: sql`${crmAccounts.version} + 1`,
        })
        .where(
          and(
            eq(crmAccounts.id, row.id),
            eq(crmAccounts.version, row.version),
            eq(crmAccounts.isDeleted, false),
          ),
        )
        .returning({ id: crmAccounts.id });
      if (claimed.length === 1) {
        updated.push(row.id);
        continue;
      }
      // 0 rows: distinguish a stale version (conflict) from an
      // already-archived no-op (idempotent skip). Probe the live row
      // in-transaction — consistent with the bulk task OCC fns
      // (STANDARDS 1.8 sibling parity).
      const [live] = await tx
        .select({ version: crmAccounts.version })
        .from(crmAccounts)
        .where(eq(crmAccounts.id, row.id))
        .limit(1);
      if (live && live.version !== row.version) conflicts.push(row.id);
      // else: already archived at the same version — idempotent no-op.
    }
    const cascade =
      updated.length > 0
        ? await cascadeArchiveAccountClosure(tx, updated, actorId)
        : {
            cascadedContacts: 0,
            cascadedOpportunities: 0,
            cascadedTasks: 0,
            cascadedActivities: 0,
          };
    return { updated, conflicts, ...cascade };
  });
}

/**
 * Archive the active closure of the given accounts inside the caller's
 * transaction. Order matters: archive child contacts/opportunities
 * first (capturing their ids) so the subsequent task/activity sweep can
 * key off both the account ids AND those child ids in one pass each.
 * Every cascaded row gets the account-scoped sentinel.
 */
async function cascadeArchiveAccountClosure(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  accountIds: string[],
  actorId: string,
): Promise<AccountCascadeResult> {
  // Child contacts of the archived accounts.
  const archivedContacts = await tx
    .update(contacts)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: cascadeMarkerSql("account", contacts.accountId),
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        inArray(contacts.accountId, accountIds),
        eq(contacts.isDeleted, false),
      ),
    )
    .returning({ id: contacts.id });
  const contactIds = archivedContacts.map((c) => c.id);

  // Child opportunities of the archived accounts.
  const archivedOpps = await tx
    .update(opportunities)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: cascadeMarkerSql("account", opportunities.accountId),
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        inArray(opportunities.accountId, accountIds),
        eq(opportunities.isDeleted, false),
      ),
    )
    .returning({ id: opportunities.id });
  const opportunityIds = archivedOpps.map((o) => o.id);

  // Account-scoped sentinel value for the grandchild tasks/activities
  // (they may be linked via account_id, contact_id, or opportunity_id —
  // all collapse to the one account-level marker so restore reverses
  // the whole closure atomically). The marker must reference the
  // account id, not the immediate parent, so a single sentinel string
  // governs the entire closure.
  const taskPredicates = [inArray(tasks.accountId, accountIds)];
  const actPredicates = [inArray(activities.accountId, accountIds)];
  if (contactIds.length > 0) {
    taskPredicates.push(inArray(tasks.contactId, contactIds));
    actPredicates.push(inArray(activities.contactId, contactIds));
  }
  if (opportunityIds.length > 0) {
    taskPredicates.push(inArray(tasks.opportunityId, opportunityIds));
    actPredicates.push(inArray(activities.opportunityId, opportunityIds));
  }

  // Each grandchild task/activity may be linked via account_id,
  // contact_id, or opportunity_id. COALESCE resolves the owning account
  // per row (direct account_id, else via its contact's / opportunity's
  // account_id — those parent rows still exist; they were soft-deleted
  // earlier in this same tx, not removed) so every cascaded row's
  // sentinel points at one account and the closure restores together.
  //
  // Bounded limitation (M-4, accepted by design): COALESCE precedence
  // pins each row to exactly ONE account. A task multi-linked across
  // two accounts archived in the same batch (e.g. account_id=A1 while
  // its contact belongs to A2) is stamped with A1 only; restoring A1
  // brings it back even if A2 stays archived. This is intentional —
  // one account-scoped sentinel per row is what lets the whole closure
  // restore atomically; account_id precedence is the row's primary
  // account. The inverse (a NULL marker) cannot occur: a row enters
  // this sweep only via account_id ∈ accountIds OR via a
  // contact_id/opportunity_id whose parent was selected by
  // account_id ∈ accountIds (non-null), so COALESCE always resolves.
  const acctMarker = cascadeMarkerSqlFromExpr(
    "account",
    sql`COALESCE(
      ${tasks.accountId}::text,
      (SELECT account_id::text FROM contacts WHERE contacts.id = ${tasks.contactId}),
      (SELECT account_id::text FROM opportunities WHERE opportunities.id = ${tasks.opportunityId})
    )`,
  );
  const cascadedTasks = await tx
    .update(tasks)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: acctMarker,
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        taskPredicates.length === 1
          ? taskPredicates[0]
          : or(...taskPredicates)!,
        eq(tasks.isDeleted, false),
      ),
    )
    .returning({ id: tasks.id });

  const actAcctMarker = cascadeMarkerSqlFromExpr(
    "account",
    sql`COALESCE(
      ${activities.accountId}::text,
      (SELECT account_id::text FROM contacts WHERE contacts.id = ${activities.contactId}),
      (SELECT account_id::text FROM opportunities WHERE opportunities.id = ${activities.opportunityId})
    )`,
  );
  const cascadedActivities = await tx
    .update(activities)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: actAcctMarker,
      // activities.user_id (authorship) intentionally untouched.
      updatedAt: sql`now()`,
    })
    .where(
      and(
        actPredicates.length === 1
          ? actPredicates[0]
          : or(...actPredicates)!,
        eq(activities.isDeleted, false),
      ),
    )
    .returning({ id: activities.id });

  return {
    cascadedContacts: archivedContacts.length,
    cascadedOpportunities: archivedOpps.length,
    cascadedTasks: cascadedTasks.length,
    cascadedActivities: cascadedActivities.length,
  };
}

/**
 * Restore archived accounts and exactly the closure THIS account's
 * archive cascaded (matched by the account-scoped sentinel — rows a
 * user archived independently keep their own reason and stay archived).
 * One transaction.
 *
 * @actor admin only (caller enforces)
 */
export async function restoreAccountsById(
  ids: string[],
  actorId: string,
): Promise<AccountCascadeResult> {
  if (ids.length === 0) {
    return {
      cascadedContacts: 0,
      cascadedOpportunities: 0,
      cascadedTasks: 0,
      cascadedActivities: 0,
    };
  }
  return db.transaction(async (tx) => {
    await tx
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
    let cascadedContacts = 0;
    let cascadedOpportunities = 0;
    let cascadedTasks = 0;
    let cascadedActivities = 0;
    for (const id of ids) {
      const marker = cascadeMarker("account", id);
      const c = await tx
        .update(contacts)
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
            eq(contacts.accountId, id),
            eq(contacts.isDeleted, true),
            eq(contacts.deleteReason, marker),
          ),
        )
        .returning({ id: contacts.id });
      const o = await tx
        .update(opportunities)
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
            eq(opportunities.accountId, id),
            eq(opportunities.isDeleted, true),
            eq(opportunities.deleteReason, marker),
          ),
        )
        .returning({ id: opportunities.id });
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
          and(eq(tasks.isDeleted, true), eq(tasks.deleteReason, marker)),
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
            eq(activities.isDeleted, true),
            eq(activities.deleteReason, marker),
          ),
        )
        .returning({ id: activities.id });
      cascadedContacts += c.length;
      cascadedOpportunities += o.length;
      cascadedTasks += t.length;
      cascadedActivities += a.length;
    }
    return {
      cascadedContacts,
      cascadedOpportunities,
      cascadedTasks,
      cascadedActivities,
    };
  });
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
