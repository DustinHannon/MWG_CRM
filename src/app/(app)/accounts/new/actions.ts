"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { ValidationError } from "@/lib/errors";
import { accountCreateSchema, createAccount } from "@/lib/accounts";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && v.trim() === "") continue;
    obj[k] = v;
  }
  return obj;
}

export async function createAccountAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "account.create" }, async () => {
    const user = await requireSession();

    const parsed = accountCreateSchema.safeParse(formToObject(formData));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }

    const { id } = await createAccount(parsed.data, user.id);

    revalidatePath("/accounts");
    redirect(`/accounts/${id}`);
  });
}
