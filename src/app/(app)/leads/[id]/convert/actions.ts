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
  requireOwnedEntityAccess,
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

    // When converting into an existing account, the caller-supplied account id
    // must pass owner/visibility access (admin OR owner OR canViewAllRecords) and
    // not be archived — re-fetched inside, so a crafted id can't link a lead's
    // contact/opportunity/activities into an account the user can't see (IDOR).
    if (parsed.existingAccountId) {
      await requireOwnedEntityAccess(session, "account", parsed.existingAccountId);
    }

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
