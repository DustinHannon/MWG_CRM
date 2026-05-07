"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";
import {
  ForbiddenError,
  requireLeadEditAccess,
  requireSession,
} from "@/lib/auth-helpers";

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const parsed = PIPELINE_STATUSES.safeParse(newStatus);
  if (!parsed.success) {
    return { ok: false, error: "Invalid status." };
  }

  try {
    await requireLeadEditAccess(session, leadId);
    const before = await db
      .select({ status: leads.status })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    await db
      .update(leads)
      .set({ status: parsed.data, updatedById: session.id })
      .where(eq(leads.id, leadId));

    await writeAudit({
      actorId: session.id,
      action: "lead.status_change",
      targetType: "leads",
      targetId: leadId,
      before: before[0] ?? null,
      after: { status: parsed.data },
    });

    revalidatePath("/leads/pipeline");
    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, error: err.message };
    }
    console.error("[pipeline] updateLeadStatusAction failed", err);
    return { ok: false, error: "Could not update status." };
  }
}
