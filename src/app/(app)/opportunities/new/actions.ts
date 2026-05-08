"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { ValidationError } from "@/lib/errors";
import {
  createOpportunity,
  opportunityCreateSchema,
} from "@/lib/opportunities";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && v.trim() === "") continue;
    obj[k] = v;
  }
  return obj;
}

export async function createOpportunityAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "opportunity.create" }, async () => {
    const user = await requireSession();

    const parsed = opportunityCreateSchema.safeParse(formToObject(formData));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }

    const { id } = await createOpportunity(parsed.data, user.id);

    revalidatePath("/opportunities");
    revalidatePath(`/accounts/${parsed.data.accountId}`);
    redirect(`/opportunities/${id}`);
  });
}
