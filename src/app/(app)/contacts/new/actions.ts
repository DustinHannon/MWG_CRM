"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { contactCreateSchema, createContact } from "@/lib/contacts";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { parseFormOrThrow } from "@/lib/forms/form-data";

export async function createContactAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "contact.create" }, async () => {
    const user = await requireSession();

    const data = parseFormOrThrow(contactCreateSchema, formData);

    const { id } = await createContact(data, user.id);

    revalidatePath("/contacts");
    if (data.accountId) {
      revalidatePath(`/accounts/${data.accountId}`);
    }
    redirect(`/contacts/${id}`);
  });
}
