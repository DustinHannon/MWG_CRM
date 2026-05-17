"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { recentViews } from "@/db/schema/recent-views";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import {
  emitActivity,
  emitActivities,
  type EmitActivityInput,
} from "@/lib/notifications";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveOpportunitiesById,
  bulkArchiveOpportunities,
  deleteOpportunitiesById,
  restoreOpportunitiesById,
  updateOpportunityForApi,
} from "@/lib/opportunities";
import {
  bulkRowVersionsSchema,
  isCascadeMarker,
} from "@/lib/cascade-archive";
import { canDeleteOpportunity, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import { gatherBlobsForActivityParent } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";

export async function softDeleteOpportunityAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "opportunity.archive", entityType: "opportunity", entityId: input.id },
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
        .select({ id: opportunities.id, ownerId: opportunities.ownerId, name: opportunities.name })
        .from(opportunities)
        .where(eq(opportunities.id, id))
        .limit(1);
      if (!row) throw new ForbiddenError("Opportunity not found.");
      if (!canDeleteOpportunity(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.opportunity.delete",
          targetType: "opportunity",
          targetId: id,
        });
        throw new ForbiddenError("You can't archive this opportunity.");
      }

      const cascade = await archiveOpportunitiesById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "opportunity.archive",
        targetType: "opportunity",
        targetId: id,
        before: { name: row.name, ownerId: row.ownerId },
        after: {
          reason: reason ?? null,
          cascadedTasks: cascade.cascadedTasks,
          cascadedActivities: cascade.cascadedActivities,
        },
      });

      await emitActivity({
        actorId: user.id,
        verb: "Archived",
        entityType: "opportunity",
        entityId: id,
        entityDisplayName: row.name,
        link: `/opportunities/${id}`,
      });

      revalidatePath("/opportunities");
      revalidatePath("/opportunities/pipeline");
      revalidatePath(`/opportunities/${id}`);
      return {
        undoToken: signUndoToken({ entity: "opportunity", id, deletedAt: new Date() }),
      };
    },
  );
}

export async function undoArchiveOpportunityAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "opportunity.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "opportunity") throw new ForbiddenError("Token mismatch.");
    const [row] = await db
      .select({
        id: opportunities.id,
        ownerId: opportunities.ownerId,
        name: opportunities.name,
      })
      .from(opportunities)
      .where(eq(opportunities.id, payload.id))
      .limit(1);
    // BUG-003: row may have been hard-deleted by an admin
    // between soft-delete and Undo. Surface a clear NotFound.
    if (!row) {
      throw new NotFoundError(
        "opportunity — it was permanently deleted before Undo could run",
      );
    }
    if (!canDeleteOpportunity(user, row)) {
      throw new ForbiddenError("You can't restore this opportunity.");
    }
    const undoCascade = await restoreOpportunitiesById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "opportunity.unarchive_undo",
      targetType: "opportunity",
      targetId: payload.id,
      after: {
        cascadedTasks: undoCascade.cascadedTasks,
        cascadedActivities: undoCascade.cascadedActivities,
      },
    });

    await emitActivity({
      actorId: user.id,
      verb: "Restored",
      entityType: "opportunity",
      entityId: payload.id,
      entityDisplayName: row.name,
      link: `/opportunities/${payload.id}`,
    });

    revalidatePath("/opportunities");
    revalidatePath("/opportunities/pipeline");
    revalidatePath("/opportunities/archived");
  });
}

export async function restoreOpportunityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "opportunity.restore" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const cascade = await restoreOpportunitiesById([id], user.id);
    const [restored] = await db
      .select({ name: opportunities.name })
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .limit(1);
    await writeAudit({
      actorId: user.id,
      action: "opportunity.restore",
      targetType: "opportunity",
      targetId: id,
      after: {
        cascadedTasks: cascade.cascadedTasks,
        cascadedActivities: cascade.cascadedActivities,
      },
    });

    await emitActivity({
      actorId: user.id,
      verb: "Restored",
      entityType: "opportunity",
      entityId: id,
      entityDisplayName: restored?.name ?? "",
      link: `/opportunities/${id}`,
    });

    revalidatePath("/opportunities/archived");
    revalidatePath("/opportunities");
    revalidatePath("/opportunities/pipeline");
  });
}

export async function hardDeleteOpportunityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "opportunity.hard_delete" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const [snapshot] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .limit(1);
    // Collect attachment blob pathnames BEFORE the DB delete; after
    // CASCADE the activities -> attachments join rows are gone and the
    // blobs are unrecoverable. Failure to gather is non-fatal.
    let blobPathnames: string[] = [];
    try {
      blobPathnames = await gatherBlobsForActivityParent("opportunity", [id]);
    } catch (err) {
      logger.error("blob_cleanup_gather_failure_hard_delete", {
        entity: "opportunity",
        entityId: id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    await deleteOpportunitiesById([id]);
    // recent_views has no polymorphic FK (free-text entity_type), so
    // hard-deleting the opportunity does NOT cascade its Cmd+K
    // recent-view rows — purge them explicitly. Best-effort: a failure
    // here must never roll back or block the hard delete. Mirrors the
    // blob-cleanup enqueue placement.
    try {
      await db
        .delete(recentViews)
        .where(
          and(
            eq(recentViews.entityType, "opportunity"),
            eq(recentViews.entityId, id),
          ),
        );
    } catch (err) {
      logger.error("recent_views.cleanup_failed", {
        entityType: "opportunity",
        ids: [id],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await writeAudit({
      actorId: user.id,
      action: "opportunity.hard_delete",
      targetType: "opportunity",
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
            origin: { entityType: "opportunity", entityId: id },
          },
          {
            actorId: user.id,
            idempotencyKey: `blob-cleanup:opportunity:${id}`,
            metadata: {
              originAction: "opportunity.hard_delete",
              entityId: id,
              blobCount: blobPathnames.length,
            },
          },
        );
      } catch (err) {
        logger.error("blob_cleanup_enqueue_failure_hard_delete", {
          entity: "opportunity",
          entityId: id,
          blobCount: blobPathnames.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    revalidatePath("/opportunities/archived");
  });
}

/**
 * dedicated edit form for opportunities. Thin
 * wrapper around `updateOpportunityForApi`; OCC via expectedVersion.
 */
const opportunityUpdateSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  stage: z
    .enum([
      "prospecting",
      "qualification",
      "proposal",
      "negotiation",
      "closed_won",
      "closed_lost",
    ])
    .optional(),
  amount: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) =>
      v === null || v === undefined || v === "" ? null : String(v),
    ),
  expectedCloseDate: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  description: z.string().trim().max(4000).optional().nullable(),
});

export async function updateOpportunityAction(
  fd: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "opportunity.update", entityType: "opportunity" },
    async () => {
      const user = await requireSession();
      const parsed = opportunityUpdateSchema.parse(
        Object.fromEntries(fd.entries()),
      );
      const [existing] = await db
        .select({
          id: opportunities.id,
          ownerId: opportunities.ownerId,
          name: opportunities.name,
          stage: opportunities.stage,
          amount: opportunities.amount,
          description: opportunities.description,
        })
        .from(opportunities)
        .where(eq(opportunities.id, parsed.id))
        .limit(1);
      if (!existing) throw new NotFoundError("opportunity");
      if (!user.isAdmin && existing.ownerId !== user.id) {
        throw new ForbiddenError(
          "You don't have permission to edit this opportunity.",
        );
      }

      await updateOpportunityForApi(
        parsed.id,
        {
          name: parsed.name,
          stage: parsed.stage,
          amount: parsed.amount,
          expectedCloseDate: parsed.expectedCloseDate,
          description: parsed.description ?? null,
        },
        parsed.version,
        user.id,
      );

      await writeAudit({
        actorId: user.id,
        action: "opportunity.update",
        targetType: "opportunity",
        targetId: parsed.id,
        before: existing as object,
        after: parsed as object,
      });

      await emitActivity({
        actorId: user.id,
        verb: "Updated",
        entityType: "opportunity",
        entityId: parsed.id,
        entityDisplayName: parsed.name ?? existing.name,
        link: `/opportunities/${parsed.id}`,
      });

      revalidatePath(`/opportunities/${parsed.id}`);
      revalidatePath("/opportunities");
    },
  );
}

/**
 * bulk soft-delete from the /opportunities list page toolbar.
 *
 * The caller passes the selected rows as `{ id, version }` pairs. The
 * action filters down to rows the actor may archive (own + admin) —
 * forbidden ids surface in `denied` for a partial-success toast — then
 * applies an OCC bulk archive: a row whose `version` was moved by
 * another writer is skipped and reported in `conflicts` (no silent
 * lost update — single-row opportunity edits enforce OCC, so bulk must
 * too). Each archived id emits a per-row `opportunity.archive` audit
 * event after the transaction for forensic clarity. The shared
 * row-version schema lives in `@/lib/cascade-archive` (same contract
 * as bulk account archive / task complete/reassign/delete). An
 * optional free-text reason is recorded on the archived row(s); it
 * must not collide with the reserved `__cascade__:` sentinel
 * namespace.
 */
const bulkArchiveOpportunitiesSchema = bulkRowVersionsSchema.extend({
  reason: z.string().max(500).optional(),
});

export async function bulkArchiveOpportunitiesAction(
  payload: z.infer<typeof bulkArchiveOpportunitiesSchema>,
): Promise<
  ActionResult<{
    archived: number;
    denied: number;
    conflicts: string[];
  }>
> {
  return withErrorBoundary(
    { action: "opportunity.bulk_archive" },
    async () => {
      const user = await requireSession();
      const parsed = bulkArchiveOpportunitiesSchema.parse(payload);
      if (parsed.items.length === 0) {
        throw new ValidationError("No opportunities selected.");
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
          id: opportunities.id,
          name: opportunities.name,
          ownerId: opportunities.ownerId,
        })
        .from(opportunities)
        .where(
          inArray(
            opportunities.id,
            parsed.items.map((i) => i.id),
          ),
        );
      const rowById = new Map(rows.map((r) => [r.id, r]));
      const allowedItems: { id: string; version: number }[] = [];
      const denied: string[] = [];
      for (const item of parsed.items) {
        const row = rowById.get(item.id);
        if (row && canDeleteOpportunity(user, row)) {
          allowedItems.push({ id: item.id, version: item.version });
        } else {
          denied.push(item.id);
        }
      }
      if (allowedItems.length === 0) {
        throw new ForbiddenError(
          "You can't archive any of these opportunities.",
        );
      }
      // OCC bulk archive + child tasks/activities cascade, one
      // transaction (STANDARDS 19.1.1). Returns the ids actually
      // mutated plus the ids skipped because their version moved.
      const result = await bulkArchiveOpportunities(
        allowedItems,
        user.id,
        reason,
      );
      // Per-record audit rows via single-INSERT batch helper, emitted
      // AFTER the transaction (STANDARDS 19.1.2) and only for the ids
      // actually archived. Same emitted event name
      // (opportunity.archive) per row. The cascaded child counts are
      // recorded on the parent event's `after` (parent-event-only —
      // no per-child audit, the count is the forensic record of how
      // many children cascaded).
      if (result.updated.length > 0) {
        await writeAuditBatch({
          actorId: user.id,
          events: result.updated.map((id) => {
            const row = rowById.get(id);
            return {
              action: "opportunity.archive",
              targetType: "opportunity",
              targetId: id,
              before: row
                ? { name: row.name, ownerId: row.ownerId }
                : undefined,
              after: {
                reason: reason ?? null,
                bulk: true,
                // Batch-scoped totals (this bulk op cascaded N
                // children across all archived opportunities), not
                // per-record — the per-record key would falsely imply
                // each opportunity owned the whole count.
                // Parent-event-only (no per-child audit); the totals
                // are the forensic record of the cascade's reach
                // (M-1).
                batchCascadedTasks: result.cascadedTasks,
                batchCascadedActivities: result.cascadedActivities,
              },
            };
          }),
        });
      }
      if (result.updated.length > 0) {
        await emitActivities(
          result.updated.map((id): EmitActivityInput => {
            const row = rowById.get(id);
            return {
              actorId: user.id,
              verb: "Archived",
              entityType: "opportunity",
              entityId: id,
              entityDisplayName: row?.name ?? "",
              link: `/opportunities/${id}`,
            };
          }),
        );
      }
      revalidatePath("/opportunities");
      revalidatePath("/opportunities/pipeline");
      return {
        archived: result.updated.length,
        denied: denied.length,
        conflicts: result.conflicts,
      };
    },
  );
}
