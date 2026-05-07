"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const parsed = STAGES.safeParse(stage);
  if (!parsed.success) return { ok: false, error: "Invalid stage." };

  try {
    const before = await db
      .select({ stage: opportunities.stage, ownerId: opportunities.ownerId })
      .from(opportunities)
      .where(eq(opportunities.id, id))
      .limit(1);
    if (!before[0]) return { ok: false, error: "Opportunity not found." };
    if (!session.isAdmin && before[0].ownerId !== session.id) {
      return { ok: false, error: "You don't own that opportunity." };
    }

    await db
      .update(opportunities)
      .set({
        stage: parsed.data,
        closedAt:
          parsed.data === "closed_won" || parsed.data === "closed_lost"
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
      after: { stage: parsed.data },
    });

    revalidatePath("/opportunities/pipeline");
    revalidatePath(`/opportunities/${id}`);
    return { ok: true };
  } catch (err) {
    console.error("[opportunities] stage change failed", err);
    return { ok: false, error: "Could not update stage." };
  }
}
