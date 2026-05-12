"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  callSchema,
  createCall,
  createNote,
  createTask,
  noteSchema,
  restoreActivity,
  softDeleteActivity,
  taskSchema,
} from "@/lib/activities";
import { writeAudit } from "@/lib/audit";
import {
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { ForbiddenError } from "@/lib/errors";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { eq } from "drizzle-orm";
import { canDeleteActivity } from "@/lib/access/can-delete";

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

/**
 * soft-delete an activity. Author OR admin only. Permission
 * is enforced both client-gated (UI hides the trigger) and server-gated
 * (this action re-fetches the activity and verifies userId match or
 * admin). Returns an undo token for the toast.
 */
export async function softDeleteActivityAction(input: {
  activityId: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "activity.archive", entityType: "activity", entityId: input.activityId },
    async (): Promise<{ undoToken: string }> => {
      const user = await requireSession();
      const activityId = z.string().uuid().parse(input.activityId);

      // Re-fetch — never trust the client claim.
      const [row] = await db
        .select({
          id: activities.id,
          userId: activities.userId,
          leadId: activities.leadId,
          subject: activities.subject,
          kind: activities.kind,
        })
        .from(activities)
        .where(eq(activities.id, activityId))
        .limit(1);
      if (!row) throw new ForbiddenError("Activity not found.");
      if (!canDeleteActivity(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.activity.delete",
          targetType: "activity",
          targetId: activityId,
        });
        throw new ForbiddenError("You can't archive this activity.");
      }

      const { parentKind, parentId } = await softDeleteActivity(
        activityId,
        user.id,
        user.isAdmin,
      );
      await writeAudit({
        actorId: user.id,
        action: "activity.archive",
        targetType: "activity",
        targetId: activityId,
        before: { userId: row.userId, kind: row.kind, subject: row.subject, leadId: row.leadId },
      });

      if (parentKind && parentId) {
        revalidatePath(`/${parentKind}s/${parentId}`);
      }
      return {
        undoToken: signUndoToken({
          entity: "activity",
          id: activityId,
          deletedAt: new Date(),
        }),
      };
    },
  );
}

export async function undoArchiveActivityAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "activity") throw new ForbiddenError("Token mismatch.");
    const { parentKind, parentId } = await restoreActivity(
      payload.id,
      user.id,
      user.isAdmin,
    );
    await writeAudit({
      actorId: user.id,
      action: "activity.unarchive_undo",
      targetType: "activity",
      targetId: payload.id,
    });
    if (parentKind && parentId) {
      revalidatePath(`/${parentKind}s/${parentId}`);
    }
  });
}

/**
 * backwards-compat for the legacy form-action call site
 * still rendered in the activity-feed pre-Phase-10. Redirects to the
 * canonical soft-delete path.
 */
export async function deleteActivityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.archive" }, async () => {
    const user = await requireSession();
    const activityId = z.string().uuid().parse(formData.get("activityId"));
    const leadId = z.string().uuid().parse(formData.get("leadId"));
    await requireLeadAccess(user, leadId);

    const [row] = await db
      .select({ id: activities.id, userId: activities.userId })
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);
    if (!row) throw new ForbiddenError("Activity not found.");
    if (!canDeleteActivity(user, row)) {
      throw new ForbiddenError("You can't archive this activity.");
    }
    await softDeleteActivity(activityId, user.id, user.isAdmin);
    await writeAudit({
      actorId: user.id,
      action: "activity.archive",
      targetType: "activity",
      targetId: activityId,
    });
    revalidatePath(`/leads/${leadId}`);
  });
}

