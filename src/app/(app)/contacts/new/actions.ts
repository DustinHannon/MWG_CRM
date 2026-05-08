"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { ValidationError } from "@/lib/errors";
import { contactCreateSchema, createContact } from "@/lib/contacts";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && v.trim() === "") continue;
    obj[k] = v;
  }
  return obj;
}

export async function createContactAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "contact.create" }, async () => {
    const user = await requireSession();

    const parsed = contactCreateSchema.safeParse(formToObject(formData));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }

    const { id } = await createContact(parsed.data, user.id);

    revalidatePath("/contacts");
    if (parsed.data.accountId) {
      revalidatePath(`/accounts/${parsed.data.accountId}`);
    }
    redirect(`/contacts/${id}`);
  });
}
