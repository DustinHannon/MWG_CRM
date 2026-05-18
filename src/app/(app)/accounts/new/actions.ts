"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { accountCreateSchema, createAccount } from "@/lib/accounts";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { parseFormOrThrow } from "@/lib/forms/form-data";

export async function createAccountAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "account.create" }, async () => {
    const user = await requireSession();

    const data = parseFormOrThrow(accountCreateSchema, formData);

    const { id } = await createAccount(data, user.id);

    revalidatePath("/accounts");
    redirect(`/accounts/${id}`);
  });
}
