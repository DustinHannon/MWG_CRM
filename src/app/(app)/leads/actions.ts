"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import {
  createLead,
  deleteLeadsById,
  leadCreateSchema,
  updateLead,
} from "@/lib/leads";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k === "id") continue;
    if (v === "") continue;
    if (k === "doNotContact" || k === "doNotEmail" || k === "doNotCall") {
      obj[k] = v === "on" || v === "true";
      continue;
    }
    obj[k] = v;
  }
  return obj;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  id?: string;
}

export async function createLeadAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canCreateLeads) {
    return { ok: false, error: "You don't have permission to create leads." };
  }

  const parsed = leadCreateSchema.safeParse(formToObject(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const { id } = await createLead(user, parsed.data);
  await writeAudit({
    actorId: user.id,
    action: "lead.create",
    targetType: "lead",
    targetId: id,
    after: { firstName: parsed.data.firstName, lastName: parsed.data.lastName },
  });

  revalidatePath("/leads");
  redirect(`/leads/${id}`);
}

export async function updateLeadAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canEditLeads) {
    return { ok: false, error: "You don't have permission to edit leads." };
  }

  const id = z.string().uuid().parse(formData.get("id"));
  const parsed = leadCreateSchema.partial().safeParse(formToObject(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const before = await db
    .select({
      firstName: leads.firstName,
      lastName: leads.lastName,
      status: leads.status,
    })
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);

  await updateLead(user, id, parsed.data);

  await writeAudit({
    actorId: user.id,
    action: "lead.update",
    targetType: "lead",
    targetId: id,
    before: before[0] ?? null,
    after: parsed.data,
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}`);
}

export async function deleteLeadAction(formData: FormData) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canDeleteLeads) {
    throw new Error("You don't have permission to delete leads.");
  }
  const id = z.string().uuid().parse(formData.get("id"));
  await deleteLeadsById([id]);
  await writeAudit({
    actorId: user.id,
    action: "lead.delete",
    targetType: "lead",
    targetId: id,
  });
  revalidatePath("/leads");
  redirect("/leads");
}
