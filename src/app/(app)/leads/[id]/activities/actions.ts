"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  callSchema,
  createCall,
  createNote,
  createTask,
  deleteActivity,
  noteSchema,
  taskSchema,
} from "@/lib/activities";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export interface ActivityActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

function fdToObj(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (v === "") continue;
    obj[k] = v;
  }
  return obj;
}

export async function addNoteAction(
  formData: FormData,
): Promise<ActivityActionResult> {
  const user = await requireSession();
  const parsed = noteSchema.safeParse(fdToObj(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id } = await createNote({
    leadId: parsed.data.leadId,
    userId: user.id,
    body: parsed.data.body,
  });
  await writeAudit({
    actorId: user.id,
    action: "activity.note_create",
    targetType: "activity",
    targetId: id,
  });
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true };
}

export async function addCallAction(
  formData: FormData,
): Promise<ActivityActionResult> {
  const user = await requireSession();
  const parsed = callSchema.safeParse(fdToObj(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id } = await createCall({
    leadId: parsed.data.leadId,
    userId: user.id,
    subject: parsed.data.subject ?? null,
    body: parsed.data.body ?? null,
    outcome: parsed.data.outcome ?? null,
    durationMinutes: parsed.data.durationMinutes ?? null,
    occurredAt: parsed.data.occurredAt
      ? new Date(parsed.data.occurredAt)
      : null,
  });
  await writeAudit({
    actorId: user.id,
    action: "activity.call_create",
    targetType: "activity",
    targetId: id,
  });
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true };
}

export async function addTaskAction(
  formData: FormData,
): Promise<ActivityActionResult> {
  const user = await requireSession();
  const parsed = taskSchema.safeParse(fdToObj(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id } = await createTask({
    leadId: parsed.data.leadId,
    userId: user.id,
    subject: parsed.data.subject,
    body: parsed.data.body ?? null,
    occurredAt: parsed.data.occurredAt
      ? new Date(parsed.data.occurredAt)
      : null,
  });
  await writeAudit({
    actorId: user.id,
    action: "activity.task_create",
    targetType: "activity",
    targetId: id,
  });
  revalidatePath(`/leads/${parsed.data.leadId}`);
  return { ok: true };
}

export async function deleteActivityAction(formData: FormData) {
  const user = await requireSession();
  const activityId = z.string().uuid().parse(formData.get("activityId"));
  const leadId = z.string().uuid().parse(formData.get("leadId"));
  await deleteActivity(activityId, user.id, user.isAdmin);
  await writeAudit({
    actorId: user.id,
    action: "activity.delete",
    targetType: "activity",
    targetId: activityId,
  });
  revalidatePath(`/leads/${leadId}`);
}

// Future Phase 7 placeholder for permission-gated email send.
export async function _placeholderEmailAction() {
  await getPermissions("");
}
