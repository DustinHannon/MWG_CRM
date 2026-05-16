import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  marketingListMembers,
  marketingLists,
} from "@/db/schema/marketing-lists";
import { writeAudit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { compileFilterDsl } from "./compile-filter";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";

const MAX_LIST_SIZE = 50_000;

export interface RefreshResult {
  listId: string;
  added: number;
  removed: number;
  total: number;
}

/**
 * Recompute membership for a marketing list. Runs the list's
 * compiled filter against `leads` (with do_not_email and is_deleted gates),
 * diffs against the existing snapshot in `marketing_list_members`, and
 * applies INSERT/DELETE so unchanged rows aren't churned.
 *
 * Bounded at 50_000 leads per refresh to protect the cron from runaway
 * payloads.
 */
export async function refreshList(
  listId: string,
  actorId: string | null,
): Promise<RefreshResult> {
  // Captured inside the transaction, used for the post-commit audit.
  // The read → diff → INSERT/DELETE → member_count write must be atomic
  // AND serialized against a concurrent refresh of the same list
  // (manual action vs. the daily cron, or two manual refreshes): the
  // `marketing_list_members` PK + onConflictDoNothing already prevents
  // duplicate member rows, but `member_count` was last-writer-wins and
  // could transiently drift. A txn-scoped `SELECT … FOR UPDATE` on the
  // parent list row makes a second refresh of the SAME list block until
  // the first commits, so the count is exact. Transaction-scoped lock —
  // Supavisor-safe per STANDARDS §9.2 (no advisory locks).
  let addedCount = 0;
  let removedCount = 0;
  let totalCount = 0;

  await db.transaction(async (tx) => {
    // Serialize concurrent refreshes of THIS list. Must precede the
    // members read so the diff/write is consistent.
    await tx.execute(
      sql`SELECT id FROM ${marketingLists} WHERE id = ${listId} FOR UPDATE`,
    );

    const [list] = await tx
      .select({
        id: marketingLists.id,
        filterDsl: marketingLists.filterDsl,
        isDeleted: marketingLists.isDeleted,
      })
      .from(marketingLists)
      .where(eq(marketingLists.id, listId))
      .limit(1);
    if (!list) throw new ValidationError("List not found.");
    if (list.isDeleted) throw new ValidationError("List is archived.");

    const where = and(
      compileFilterDsl(list.filterDsl as unknown),
      eq(leads.isDeleted, false),
      eq(leads.doNotEmail, false),
    );

    const matched = await tx
      .select({
        id: leads.id,
        email: leads.email,
      })
      .from(leads)
      .where(where)
      .limit(MAX_LIST_SIZE);

    const matchedWithEmail = matched.filter(
      (m): m is { id: string; email: string } => Boolean(m.email),
    );

    const matchedIds = new Set(matchedWithEmail.map((m) => m.id));

    const existing = await tx
      .select({ leadId: marketingListMembers.leadId })
      .from(marketingListMembers)
      .where(eq(marketingListMembers.listId, listId));
    const existingIds = new Set(existing.map((e) => e.leadId));

    const toAdd = matchedWithEmail.filter((m) => !existingIds.has(m.id));
    const toRemove = existing
      .filter((e) => !matchedIds.has(e.leadId))
      .map((e) => e.leadId);

    if (toAdd.length > 0) {
      // Chunk inserts to keep statement sizes bounded.
      for (let i = 0; i < toAdd.length; i += 1000) {
        const slice = toAdd.slice(i, i + 1000);
        await tx
          .insert(marketingListMembers)
          .values(
            slice.map((m) => ({
              listId,
              leadId: m.id,
              email: m.email,
            })),
          )
          // Defense-in-depth — the FOR UPDATE lock already serializes
          // same-list refreshes; this stays harmless against any retry.
          .onConflictDoNothing();
      }
    }

    if (toRemove.length > 0) {
      for (let i = 0; i < toRemove.length; i += 1000) {
        const slice = toRemove.slice(i, i + 1000);
        await tx
          .delete(marketingListMembers)
          .where(
            and(
              eq(marketingListMembers.listId, listId),
              inArray(marketingListMembers.leadId, slice),
            ),
          );
      }
    }

    await tx
      .update(marketingLists)
      .set({
        memberCount: matchedWithEmail.length,
        lastRefreshedAt: sql`now()`,
      })
      .where(eq(marketingLists.id, listId));

    addedCount = toAdd.length;
    removedCount = toRemove.length;
    totalCount = matchedWithEmail.length;
  });

  // Audit AFTER the transaction commits — §19.1.2: data write + audit
  // emission must NOT share a transaction (audit is best-effort; an
  // audit failure must never roll back the refresh).
  if (actorId) {
    await writeAudit({
      actorId,
      action: MARKETING_AUDIT_EVENTS.LIST_REFRESH,
      targetType: "marketing_list",
      targetId: listId,
      after: {
        added: addedCount,
        removed: removedCount,
        total: totalCount,
      },
    });
  }

  return {
    listId,
    added: addedCount,
    removed: removedCount,
    total: totalCount,
  };
}

/**
 * Preview a DSL without persisting. Returns count + a sample of up to
 * `sampleLimit` matching leads. Used by the new-list page's right-rail
 * live preview.
 */
export async function previewFilterDsl(
  dslInput: unknown,
  sampleLimit = 10,
): Promise<{
  count: number;
  sample: { id: string; email: string | null; firstName: string; lastName: string | null }[];
}> {
  const where = and(
    compileFilterDsl(dslInput),
    eq(leads.isDeleted, false),
    eq(leads.doNotEmail, false),
  );
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(where);
  const sample = await db
    .select({
      id: leads.id,
      email: leads.email,
      firstName: leads.firstName,
      lastName: leads.lastName,
    })
    .from(leads)
    .where(where)
    .limit(sampleLimit);
  return { count: n ?? 0, sample };
}
