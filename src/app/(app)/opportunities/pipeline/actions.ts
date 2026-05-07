"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { expectAffected } from "@/lib/db/concurrent-update";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { versionField } from "@/lib/validation/primitives";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const STAGES = z.enum([
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
]);

/**
 * Phase 8D Wave 4 (FIX-004) — OCC on opportunity-pipeline DnD. Compare-
 * and-set against `version` so two reps dragging the same opportunity
 * to different stages can't trample each other; the loser sees a
 * ConflictError and rolls back. closed_at handling is preserved inside
 * the patch (closed_won/closed_lost set now(), other stages clear it).
 */
export async function updateOpportunityStageAction(
  id: string,
  stage: z.infer<typeof STAGES>,
  expectedVersion: number,
): Promise<ActionResult<{ version: number }>> {
  return withErrorBoundary(
    {
      action: "opportunity.stage_change",
      entityType: "opportunity",
      entityId: id,
    },
    async (): Promise<{ version: number }> => {
      const session = await requireSession();
      const parsed = STAGES.parse(stage);
      const version = versionField.parse(expectedVersion);

      const before = await db
        .select({
          stage: opportunities.stage,
          ownerId: opportunities.ownerId,
        })
        .from(opportunities)
        .where(eq(opportunities.id, id))
        .limit(1);
      if (!before[0]) throw new NotFoundError("opportunity");
      if (!session.isAdmin && before[0].ownerId !== session.id) {
        throw new ForbiddenError("You don't own that opportunity.");
      }

      const closedAt =
        parsed === "closed_won" || parsed === "closed_lost"
          ? new Date()
          : null;

      const rows = await db
        .update(opportunities)
        .set({
          stage: parsed,
          closedAt,
          updatedAt: new Date(),
          version: version + 1,
        })
        .where(
          and(
            eq(opportunities.id, id),
            eq(opportunities.version, version),
            eq(opportunities.isDeleted, false),
          ),
        )
        .returning({
          id: opportunities.id,
          version: opportunities.version,
        });
      expectAffected(rows, {
        table: opportunities,
        id,
        entityLabel: "opportunity",
      });

      await writeAudit({
        actorId: session.id,
        action: "opportunity.stage_change",
        targetType: "opportunities",
        targetId: id,
        before: before[0],
        after: { stage: parsed },
      });

      revalidatePath("/opportunities/pipeline");
      revalidatePath(`/opportunities/${id}`);

      return { version: rows[0].version };
    },
  );
}
