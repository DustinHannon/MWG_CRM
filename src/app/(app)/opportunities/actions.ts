"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveOpportunitiesById,
  deleteOpportunitiesById,
  restoreOpportunitiesById,
  updateOpportunityForApi,
} from "@/lib/opportunities";
import { canDeleteOpportunity, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

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
    await deleteOpportunitiesById([id]);
    await writeAudit({
      actorId: user.id,
      action: "opportunity.hard_delete",
      targetType: "opportunity",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
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
