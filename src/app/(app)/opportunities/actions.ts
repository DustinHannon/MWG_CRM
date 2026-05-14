"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveOpportunitiesById,
  deleteOpportunitiesById,
  restoreOpportunitiesById,
  updateOpportunityForApi,
} from "@/lib/opportunities";
import { canDeleteOpportunity, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import {
  deleteBlobsByPathnames,
  gatherBlobsForActivityParent,
} from "@/lib/blob-cleanup";
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

      await archiveOpportunitiesById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "opportunity.archive",
        targetType: "opportunity",
        targetId: id,
        before: { name: row.name, ownerId: row.ownerId },
        after: { reason: reason ?? null },
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
      .select({ id: opportunities.id, ownerId: opportunities.ownerId })
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
    await restoreOpportunitiesById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "opportunity.unarchive_undo",
      targetType: "opportunity",
      targetId: payload.id,
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
    await restoreOpportunitiesById([id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "opportunity.restore",
      targetType: "opportunity",
      targetId: id,
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
    await writeAudit({
      actorId: user.id,
      action: "opportunity.hard_delete",
      targetType: "opportunity",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
    // Fire-and-forget blob cleanup. Use the pre-gathered paths; the
    // attachments rows are gone by now (CASCADE), so re-gathering would
    // return empty and blobs would leak.
    if (blobPathnames.length > 0) {
      void deleteBlobsByPathnames(blobPathnames).catch((err) => {
        logger.error("blob_cleanup_failure_hard_delete", {
          entity: "opportunity",
          entityId: id,
          blobCount: blobPathnames.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
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

      revalidatePath(`/opportunities/${parsed.id}`);
      revalidatePath("/opportunities");
    },
  );
}

/**
 * bulk soft-delete from the /opportunities list page toolbar.
 *
 * The caller passes the selected row ids; this action filters down to
 * those the actor is allowed to archive (own + admin) and applies the
 * archive in a single batch. Each archived id emits a per-row audit
 * event for forensic clarity. Forbidden ids surface in `denied` so
 * the UI can show a partial-success toast.
 */
const bulkArchiveOpportunitiesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().max(500).optional(),
});

export async function bulkArchiveOpportunitiesAction(
  payload: z.infer<typeof bulkArchiveOpportunitiesSchema>,
): Promise<
  ActionResult<{
    archived: number;
    denied: number;
  }>
> {
  return withErrorBoundary(
    { action: "opportunity.bulk_archive" },
    async () => {
      const user = await requireSession();
      const parsed = bulkArchiveOpportunitiesSchema.parse(payload);
      if (parsed.ids.length === 0) {
        throw new ValidationError("No opportunities selected.");
      }
      const rows = await db
        .select({
          id: opportunities.id,
          name: opportunities.name,
          ownerId: opportunities.ownerId,
        })
        .from(opportunities)
        .where(inArray(opportunities.id, parsed.ids));
      const allowed: typeof rows = [];
      const denied: string[] = [];
      for (const row of rows) {
        if (canDeleteOpportunity(user, row)) allowed.push(row);
        else denied.push(row.id);
      }
      if (allowed.length === 0) {
        throw new ForbiddenError(
          "You can't archive any of these opportunities.",
        );
      }
      const reason = parsed.reason?.trim() || undefined;
      await archiveOpportunitiesById(
        allowed.map((r) => r.id),
        user.id,
        reason,
      );
      // Per-record audit rows via single-INSERT batch helper (see
      // src/lib/audit.ts writeAuditBatch). Same emitted event name
      // (opportunity.archive) per row.
      await writeAuditBatch({
        actorId: user.id,
        events: allowed.map((row) => ({
          action: "opportunity.archive",
          targetType: "opportunity",
          targetId: row.id,
          before: { name: row.name, ownerId: row.ownerId },
          after: { reason: reason ?? null, bulk: true },
        })),
      });
      revalidatePath("/opportunities");
      revalidatePath("/opportunities/pipeline");
      return { archived: allowed.length, denied: denied.length };
    },
  );
}
