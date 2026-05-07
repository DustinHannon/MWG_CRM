"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  conversionSchema,
  convertLeadWithAudit,
  type ConversionInput,
} from "@/lib/conversion";
import {
  ForbiddenError,
  requireLeadEditAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";

export async function convertLeadAction(
  raw: ConversionInput,
): Promise<{ ok: false; error: string }> {
  const session = await requireSession();
  const parsed = conversionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  try {
    await requireLeadEditAccess(session, parsed.data.leadId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  try {
    const result = await convertLeadWithAudit(
      parsed.data,
      session.id,
      session.id,
    );

    revalidatePath(`/leads/${parsed.data.leadId}`);
    revalidatePath("/leads");
    revalidatePath("/accounts");

    if (result.opportunityId) {
      redirect(`/opportunities/${result.opportunityId}`);
    }
    redirect(`/accounts/${result.accountId}`);
  } catch (err) {
    // redirect() throws — let it propagate.
    if (err && typeof err === "object" && "digest" in err) throw err;
    logger.error("lead.convert_failed", {
      leadId: parsed.data.leadId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Conversion failed." };
  }
}
