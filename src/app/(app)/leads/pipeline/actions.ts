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
import { updateLead } from "@/lib/leads";
import { versionField } from "@/lib/validation/primitives";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const PIPELINE_STATUSES = z.enum([
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "lost",
]);

/**
 * Phase 8D Wave 4 (FIX-003) — kanban DnD now goes through the
 * version-checked `updateLead` helper. Stale boards refuse to commit
 * with a ConflictError so two users can't trample each other's drag
 * results. The new version is returned so the client can rebind the
 * card without a full refetch.
 */
export async function updateLeadStatusAction(
  leadId: string,
  newStatus: z.infer<typeof PIPELINE_STATUSES>,
  expectedVersion: number,
): Promise<ActionResult<{ version: number }>> {
  return withErrorBoundary(
    { action: "lead.status_change", entityType: "lead", entityId: leadId },
    async (): Promise<{ version: number }> => {
      const session = await requireSession();
      const parsed = PIPELINE_STATUSES.parse(newStatus);
      const version = versionField.parse(expectedVersion);

      await requireLeadEditAccess(session, leadId);
      const before = await db
        .select({ status: leads.status })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);

      const updated = await updateLead(session, leadId, version, {
        status: parsed,
      });

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

      return { version: updated.version };
    },
  );
}
