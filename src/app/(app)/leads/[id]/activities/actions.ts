"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  callSchema,
  createCall,
  createNote,
  noteSchema,
  restoreActivity,
  softDeleteActivity,
  taskSchema,
} from "@/lib/activities";
import { createTask, taskCreateSchema } from "@/lib/tasks";
import { createNotification } from "@/lib/notifications";
import { userPreferences } from "@/db/schema/views";
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
import { parseFormOrThrow } from "@/lib/forms/form-data";

/**
 * A `YYYY-MM-DD` date-only value parsed by `new Date()` is treated as
 * UTC midnight, which renders as the previous calendar day in negative
 * offsets. Anchor it to local midnight (mirrors entity-tasks-quick-add)
 * so a task due "May 21" is stored as May 21 local, not May 20.
 */
function parseOccurredAt(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value,
  );
  // occurredAt is only z.string() (no format check); an unparseable
  // value must become null, not an Invalid Date that the timestamp
  // column rejects with an opaque 500.
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function addNoteAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.note_create" }, async () => {
    const user = await requireSession();
    const parsed = parseFormOrThrow(noteSchema, formData, {
      emptyMode: "exact",
    });
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
      after: { body: parsed.body.slice(0, 500) },
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

export async function addCallAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.call_create" }, async () => {
    const user = await requireSession();
    const parsed = parseFormOrThrow(callSchema, formData, {
      emptyMode: "exact",
    });
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createCall({
      leadId: parsed.leadId,
      userId: user.id,
      subject: parsed.subject ?? null,
      body: parsed.body ?? null,
      outcome: parsed.outcome ?? null,
      durationMinutes: parsed.durationMinutes ?? null,
      occurredAt: parseOccurredAt(parsed.occurredAt),
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.call_create",
      targetType: "activity",
      targetId: id,
      after: {
        subject: parsed.subject ?? null,
        outcome: parsed.outcome ?? null,
        durationMinutes: parsed.durationMinutes ?? null,
      },
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

/**
 * Add-task tab on the lead detail actions panel. This creates a REAL
 * `tasks` row via the canonical task path (`@/lib/tasks.createTask`) —
 * NOT an `activities kind:"task"` row. The activities-row variant had
 * no due_at/status/assignee, so it never reached /tasks, the dashboard
 * "My open tasks", the saved-search digest, or the tasks-due-today
 * cron — the reminder silently never fired. Subject→title, Details→
 * description, Due date→dueAt; the task is self-assigned to the actor
 * (the lead actions panel has no assignee picker). `createTask`
 * already writes the `task.create` audit (`targetType:"tasks"`) and
 * emits the timeline activity, so this action only adds the
 * assignee-notification (no-op while self-assigned, kept for parity
 * with `createTaskAction`) + revalidation. The form still parses via
 * `taskSchema` so its ValidationError carries the raw `values` the
 * React-19 reset-restore in TaskForm depends on.
 */
export async function addTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.create" }, async () => {
    const user = await requireSession();
    const form = parseFormOrThrow(taskSchema, formData, {
      emptyMode: "exact",
    });
    await requireLeadAccess(user, form.leadId);

    const input = taskCreateSchema.parse({
      title: form.subject,
      description: form.body ?? null,
      dueAt: parseOccurredAt(form.occurredAt),
      assignedToId: user.id,
      leadId: form.leadId,
    });
    await createTask(input, user.id);

    // Parity with createTaskAction: notify the assignee when it is not
    // the actor. Self-assigned here (no picker on the panel), so this
    // is a no-op today; kept so a future assignee field stays correct.
    if (input.assignedToId && input.assignedToId !== user.id) {
      const prefs = await db
        .select({ notify: userPreferences.notifyTasksAssigned })
        .from(userPreferences)
        .where(eq(userPreferences.userId, input.assignedToId))
        .limit(1);
      if (prefs[0]?.notify !== false) {
        await createNotification({
          userId: input.assignedToId,
          kind: "task_assigned",
          title: `New task: ${input.title}`,
          link: `/leads/${form.leadId}`,
        });
      }
    }

    revalidatePath(`/leads/${form.leadId}`);
    revalidatePath("/tasks");
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

