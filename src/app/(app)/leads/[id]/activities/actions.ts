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
import {
  getPermissions,
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

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
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.note_create" }, async () => {
    const user = await requireSession();
    const parsed = noteSchema.parse(fdToObj(formData));
    // Lead access gate — actor must own the lead OR have canViewAllRecords.
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createNote({
      leadId: parsed.leadId,
      userId: user.id,
      body: parsed.body,
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.note_create",
      targetType: "activity",
      targetId: id,
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

export async function addCallAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.call_create" }, async () => {
    const user = await requireSession();
    const parsed = callSchema.parse(fdToObj(formData));
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createCall({
      leadId: parsed.leadId,
      userId: user.id,
      subject: parsed.subject ?? null,
      body: parsed.body ?? null,
      outcome: parsed.outcome ?? null,
      durationMinutes: parsed.durationMinutes ?? null,
      occurredAt: parsed.occurredAt ? new Date(parsed.occurredAt) : null,
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.call_create",
      targetType: "activity",
      targetId: id,
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

export async function addTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.task_create" }, async () => {
    const user = await requireSession();
    const parsed = taskSchema.parse(fdToObj(formData));
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createTask({
      leadId: parsed.leadId,
      userId: user.id,
      subject: parsed.subject,
      body: parsed.body ?? null,
      occurredAt: parsed.occurredAt ? new Date(parsed.occurredAt) : null,
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.task_create",
      targetType: "activity",
      targetId: id,
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

export async function deleteActivityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.delete" }, async () => {
    const user = await requireSession();
    const activityId = z.string().uuid().parse(formData.get("activityId"));
    const leadId = z.string().uuid().parse(formData.get("leadId"));
    // Lead access gate first — without this, an attacker who knows an
    // activity id can delete from leads they don't own.
    await requireLeadAccess(user, leadId);
    await deleteActivity(activityId, user.id, user.isAdmin);
    await writeAudit({
      actorId: user.id,
      action: "activity.delete",
      targetType: "activity",
      targetId: activityId,
    });
    revalidatePath(`/leads/${leadId}`);
  });
}

// Future Phase 7 placeholder for permission-gated email send.
export async function _placeholderEmailAction() {
  await getPermissions("");
}
