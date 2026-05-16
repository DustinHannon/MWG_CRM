"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { recentViews } from "@/db/schema/recent-views";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveAccountsById,
  bulkArchiveAccounts,
  deleteAccountsById,
  restoreAccountsById,
  updateAccountForApi,
} from "@/lib/accounts";
import {
  bulkRowVersionsSchema,
  isCascadeMarker,
} from "@/lib/cascade-archive";
import { canDeleteAccount, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import { gatherBlobsForActivityParent } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";

/**
 * soft-delete an account. Owner OR admin.
 */
export async function softDeleteAccountAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "account.archive", entityType: "account", entityId: input.id },
    async () => {
      const user = await requireSession();
      const id = z.string().uuid().parse(input.id);
      const reason = input.reason?.trim() || undefined;
      if (reason && isCascadeMarker(reason)) {
        throw new ValidationError(
          "That delete reason is reserved by the system. Enter a different reason.",
        );
      }

      const [row] = await db
        .select({ id: crmAccounts.id, ownerId: crmAccounts.ownerId, name: crmAccounts.name })
        .from(crmAccounts)
        .where(eq(crmAccounts.id, id))
        .limit(1);
      if (!row) throw new ForbiddenError("Account not found.");
      if (!canDeleteAccount(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.account.delete",
          targetType: "account",
          targetId: id,
        });
        throw new ForbiddenError("You can't archive this account.");
      }

      const cascade = await archiveAccountsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "account.archive",
        targetType: "account",
        targetId: id,
        before: { name: row.name, ownerId: row.ownerId },
        after: {
          reason: reason ?? null,
          cascadedContacts: cascade.cascadedContacts,
          cascadedOpportunities: cascade.cascadedOpportunities,
          cascadedTasks: cascade.cascadedTasks,
          cascadedActivities: cascade.cascadedActivities,
        },
      });

      revalidatePath("/accounts");
      revalidatePath(`/accounts/${id}`);
      return {
        undoToken: signUndoToken({ entity: "account", id, deletedAt: new Date() }),
      };
    },
  );
}

export async function undoArchiveAccountAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "account") throw new ForbiddenError("Token mismatch.");
    const [row] = await db
      .select({ id: crmAccounts.id, ownerId: crmAccounts.ownerId })
      .from(crmAccounts)
      .where(eq(crmAccounts.id, payload.id))
      .limit(1);
    // BUG-003: row may have been hard-deleted by an admin
    // between the soft-delete and the user clicking Undo. Surface a
    // clear NotFound rather than a misleading Forbidden so the toast
    // can show "This record was permanently deleted" without the user
    // thinking they hit a permission wall.
    if (!row) {
      throw new NotFoundError(
        "account — it was permanently deleted before Undo could run",
      );
    }
    if (!canDeleteAccount(user, row)) throw new ForbiddenError("You can't restore this account.");
    const undoCascade = await restoreAccountsById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "account.unarchive_undo",
      targetType: "account",
      targetId: payload.id,
      after: {
        cascadedContacts: undoCascade.cascadedContacts,
        cascadedOpportunities: undoCascade.cascadedOpportunities,
        cascadedTasks: undoCascade.cascadedTasks,
        cascadedActivities: undoCascade.cascadedActivities,
      },
    });
    revalidatePath("/accounts");
    revalidatePath("/accounts/archived");
  });
}

/**
 * admin restore from archive view.
 */
export async function restoreAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.restore" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const cascade = await restoreAccountsById([id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "account.restore",
      targetType: "account",
      targetId: id,
      after: {
        cascadedContacts: cascade.cascadedContacts,
        cascadedOpportunities: cascade.cascadedOpportunities,
        cascadedTasks: cascade.cascadedTasks,
        cascadedActivities: cascade.cascadedActivities,
      },
    });
    revalidatePath("/accounts/archived");
    revalidatePath("/accounts");
  });
}

/**
 * admin hard delete from archive view.
 */
export async function hardDeleteAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.hard_delete" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const [snapshot] = await db
      .select()
      .from(crmAccounts)
      .where(eq(crmAccounts.id, id))
      .limit(1);
    // Collect attachment blob pathnames BEFORE the DB delete; after
    // CASCADE the activities -> attachments join rows are gone and the
    // blobs are unrecoverable. Failure to gather is non-fatal.
    let blobPathnames: string[] = [];
    try {
      blobPathnames = await gatherBlobsForActivityParent("account", [id]);
    } catch (err) {
      logger.error("blob_cleanup_gather_failure_hard_delete", {
        entity: "account",
        entityId: id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    await deleteAccountsById([id]);
    // recent_views has no polymorphic FK (free-text entity_type), so
    // hard-deleting the account does NOT cascade its Cmd+K recent-view
    // rows — purge them explicitly. Best-effort: a failure here must
    // never roll back or block the hard delete. Mirrors the
    // blob-cleanup enqueue placement.
    try {
      await db
        .delete(recentViews)
        .where(
          and(
            eq(recentViews.entityType, "account"),
            eq(recentViews.entityId, id),
          ),
        );
    } catch (err) {
      logger.error("recent_views.cleanup_failed", {
        entityType: "account",
        ids: [id],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await writeAudit({
      actorId: user.id,
      action: "account.hard_delete",
      targetType: "account",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
    // Durable async cleanup via the job queue (F-Ω-8). See the lead
    // hard-delete action for the rationale — STANDARDS §19.11.3.
    if (blobPathnames.length > 0) {
      try {
        await enqueueJob(
          "blob-cleanup",
          {
            pathnames: blobPathnames,
            origin: { entityType: "account", entityId: id },
          },
          {
            actorId: user.id,
            idempotencyKey: `blob-cleanup:account:${id}`,
            metadata: {
              originAction: "account.hard_delete",
              entityId: id,
              blobCount: blobPathnames.length,
            },
          },
        );
      } catch (err) {
        logger.error("blob_cleanup_enqueue_failure_hard_delete", {
          entity: "account",
          entityId: id,
          blobCount: blobPathnames.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    revalidatePath("/accounts/archived");
  });
}

/**
 * dedicated edit form for accounts. Thin wrapper
 * around `updateAccountForApi`; OCC enforced via expectedVersion in
 * the form (hidden field).
 */
const accountUpdateSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(120).optional().nullable(),
  website: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  accountNumber: z.string().trim().max(100).optional().nullable(),
  numberOfEmployees: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }),
  annualRevenue: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v): string | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
    }),
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(80).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  parentAccountId: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  primaryContactId: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export async function updateAccountAction(
  fd: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "account.update", entityType: "account" },
    async () => {
      const user = await requireSession();
      const parsed = accountUpdateSchema.parse(
        Object.fromEntries(fd.entries()),
      );
      // Access gate + full-row snapshot for audit. Selecting `*`
      // captures every column (including the new D365-parity fields)
      // so the audit_log `before` payload is complete.
      const [existing] = await db
        .select()
        .from(crmAccounts)
        .where(eq(crmAccounts.id, parsed.id))
        .limit(1);
      if (!existing) throw new NotFoundError("account");
      if (!user.isAdmin && existing.ownerId !== user.id) {
        throw new ForbiddenError(
          "You don't have permission to edit this account.",
        );
      }

      // Cycle prevention for parent_account_id. DB CHECK already
      // blocks A→A self-parenting; this guards the multi-hop case.
      if (parsed.parentAccountId) {
        const { assertNoParentCycle } = await import("@/lib/accounts");
        await assertNoParentCycle(parsed.id, parsed.parentAccountId);
      }

      await updateAccountForApi(
        parsed.id,
        {
          name: parsed.name,
          industry: parsed.industry ?? null,
          website: parsed.website ?? null,
          phone: parsed.phone ?? null,
          email: parsed.email,
          accountNumber: parsed.accountNumber ?? null,
          numberOfEmployees: parsed.numberOfEmployees,
          annualRevenue: parsed.annualRevenue,
          street1: parsed.street1 ?? null,
          street2: parsed.street2 ?? null,
          city: parsed.city ?? null,
          state: parsed.state ?? null,
          postalCode: parsed.postalCode ?? null,
          country: parsed.country ?? null,
          description: parsed.description ?? null,
          parentAccountId: parsed.parentAccountId,
          primaryContactId: parsed.primaryContactId,
        },
        parsed.version,
        user.id,
      );

      await writeAudit({
        actorId: user.id,
        action: "account.update",
        targetType: "account",
        targetId: parsed.id,
        before: existing as object,
        after: parsed as object,
      });

      revalidatePath(`/accounts/${parsed.id}`);
      revalidatePath("/accounts");
    },
  );
}

/**
 * bulk soft-delete from the /accounts list page toolbar.
 *
 * The caller passes the selected rows as `{ id, version }` pairs. The
 * action filters down to rows the actor may archive (own + admin) —
 * forbidden ids surface in `denied` for a partial-success toast — then
 * applies an OCC bulk archive: a row whose `version` was moved by
 * another writer is skipped and reported in `conflicts` (no silent
 * lost update). Each archived id emits a per-row `account.archive`
 * audit event after the transaction for forensic clarity. The shared
 * row-version schema lives in `@/lib/cascade-archive` (same contract
 * as bulk task complete/reassign/delete). An optional free-text reason
 * is recorded on the archived row(s); it must not collide with the
 * reserved `__cascade__:` sentinel namespace.
 */
const bulkArchiveSchema = bulkRowVersionsSchema.extend({
  reason: z.string().max(500).optional(),
});

export async function bulkArchiveAccountsAction(
  payload: z.infer<typeof bulkArchiveSchema>,
): Promise<
  ActionResult<{
    archived: number;
    denied: number;
    conflicts: string[];
  }>
> {
  return withErrorBoundary({ action: "account.bulk_archive" }, async () => {
    const user = await requireSession();
    const parsed = bulkArchiveSchema.parse(payload);
    if (parsed.items.length === 0) {
      throw new ValidationError("No accounts selected.");
    }
    const reason = parsed.reason?.trim() || undefined;
    if (reason && isCascadeMarker(reason)) {
      throw new ValidationError(
        "That delete reason is reserved by the system. Enter a different reason.",
      );
    }
    // Per-record permission gate FIRST: only rows the actor may
    // archive (own + admin) reach the OCC mutation. Forbidden rows
    // surface in `denied` for a partial-success toast.
    const rows = await db
      .select({
        id: crmAccounts.id,
        name: crmAccounts.name,
        ownerId: crmAccounts.ownerId,
      })
      .from(crmAccounts)
      .where(inArray(
        crmAccounts.id,
        parsed.items.map((i) => i.id),
      ));
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const allowedItems: { id: string; version: number }[] = [];
    const denied: string[] = [];
    for (const item of parsed.items) {
      const row = rowById.get(item.id);
      if (row && canDeleteAccount(user, row)) {
        allowedItems.push({ id: item.id, version: item.version });
      } else {
        denied.push(item.id);
      }
    }
    if (allowedItems.length === 0) {
      throw new ForbiddenError("You can't archive any of these accounts.");
    }
    // OCC bulk archive + full account closure cascade, one
    // transaction (STANDARDS 19.1.1). Returns the ids actually
    // mutated plus the ids skipped because their version moved.
    const result = await bulkArchiveAccounts(
      allowedItems,
      user.id,
      reason,
    );
    // Per-record audit rows via single-INSERT batch helper, emitted
    // AFTER the transaction (STANDARDS 19.1.2) and only for the ids
    // actually archived. Same emitted event name (account.archive)
    // per row — bulk batching is a perf-only change; downstream
    // forensic queries are unaffected.
    if (result.updated.length > 0) {
      await writeAuditBatch({
        actorId: user.id,
        events: result.updated.map((id) => {
          const row = rowById.get(id);
          return {
            action: "account.archive",
            targetType: "account",
            targetId: id,
            before: row
              ? { name: row.name, ownerId: row.ownerId }
              : undefined,
            after: {
              reason: reason ?? null,
              bulk: true,
              batchCascadedContacts: result.cascadedContacts,
              batchCascadedOpportunities: result.cascadedOpportunities,
              batchCascadedTasks: result.cascadedTasks,
              batchCascadedActivities: result.cascadedActivities,
            },
          };
        }),
      });
    }
    revalidatePath("/accounts");
    return {
      archived: result.updated.length,
      denied: denied.length,
      conflicts: result.conflicts,
    };
  });
}
