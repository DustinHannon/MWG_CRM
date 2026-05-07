"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const STAGES = z.enum([
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
]);

export async function updateOpportunityStageAction(
  id: string,
  stage: z.infer<typeof STAGES>,
): Promise<ActionResult> {
  return withErrorBoundary(
    {
      action: "opportunity.stage_change",
      entityType: "opportunity",
      entityId: id,
    },
    async () => {
      const session = await requireSession();
      const parsed = STAGES.parse(stage);

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

      await db
        .update(opportunities)
        .set({
          stage: parsed,
          closedAt:
            parsed === "closed_won" || parsed === "closed_lost"
              ? new Date()
              : null,
        })
        .where(eq(opportunities.id, id));

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
    },
  );
}
