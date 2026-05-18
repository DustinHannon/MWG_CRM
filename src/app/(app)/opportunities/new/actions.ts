"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import {
  createOpportunity,
  opportunityCreateSchema,
} from "@/lib/opportunities";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { parseFormOrThrow } from "@/lib/forms/form-data";

export async function createOpportunityAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "opportunity.create" }, async () => {
    const user = await requireSession();

    const data = parseFormOrThrow(opportunityCreateSchema, formData);

    const { id } = await createOpportunity(data, user.id);

    revalidatePath("/opportunities");
    revalidatePath(`/accounts/${data.accountId}`);
    redirect(`/opportunities/${id}`);
  });
}
