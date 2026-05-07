"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  conversionSchema,
  convertLeadWithAudit,
  type ConversionInput,
} from "@/lib/conversion";
import {
  requireLeadEditAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export async function convertLeadAction(
  raw: ConversionInput,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "lead.convert" }, async () => {
    const session = await requireSession();
    const parsed = conversionSchema.parse(raw);

    await requireLeadEditAccess(session, parsed.leadId);

    const result = await convertLeadWithAudit(parsed, session.id, session.id);

    revalidatePath(`/leads/${parsed.leadId}`);
    revalidatePath("/leads");
    revalidatePath("/accounts");

    if (result.opportunityId) {
      redirect(`/opportunities/${result.opportunityId}`);
    }
    redirect(`/accounts/${result.accountId}`);
  });
}
