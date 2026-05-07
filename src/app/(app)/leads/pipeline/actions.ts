"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";
import {
  requireLeadEditAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const PIPELINE_STATUSES = z.enum([
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "lost",
]);

export async function updateLeadStatusAction(
  leadId: string,
  newStatus: z.infer<typeof PIPELINE_STATUSES>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "lead.status_change", entityType: "lead", entityId: leadId },
    async () => {
      const session = await requireSession();
      const parsed = PIPELINE_STATUSES.parse(newStatus);

      await requireLeadEditAccess(session, leadId);
      const before = await db
        .select({ status: leads.status })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      await db
        .update(leads)
        .set({ status: parsed, updatedById: session.id })
        .where(eq(leads.id, leadId));

      await writeAudit({
        actorId: session.id,
        action: "lead.status_change",
        targetType: "leads",
        targetId: leadId,
        before: before[0] ?? null,
        after: { status: parsed },
      });

      revalidatePath("/leads/pipeline");
      revalidatePath("/leads");
      revalidatePath(`/leads/${leadId}`);
    },
  );
}
