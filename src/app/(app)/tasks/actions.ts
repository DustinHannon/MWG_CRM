"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  archiveTasksById,
  createTask,
  deleteTasksById,
  restoreTasksById,
  taskCreateSchema,
  taskUpdateSchema,
  updateTask,
  type TaskCreateInput,
  type TaskUpdateInput,
} from "@/lib/tasks";
import {
  createNotification,
  emitActivity,
  emitArchiveNotification,
} from "@/lib/notifications";
import { db } from "@/db";
import { tasks } from "@/db/schema/tasks";
import { userPreferences } from "@/db/schema/views";
import { eq } from "drizzle-orm";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { canDeleteTask, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

/**
 * server actions for tasks. Validate, audit, optionally notify
 * the assignee.
 */

export interface TaskIdData {
  id: string;
}
export interface TaskVersionData {
  version: number;
}

export async function createTaskAction(
  raw: TaskCreateInput,
): Promise<ActionResult<TaskIdData>> {
  return withErrorBoundary(
    { action: "task.create" },
    async (): Promise<TaskIdData> => {
      const session = await requireSession();
      const parsed = taskCreateSchema.parse(raw);

      const result = await createTask(parsed, session.id);

      // Notify the assignee if it's not the current user (and they want to know).
      if (parsed.assignedToId && parsed.assignedToId !== session.id) {
        const prefs = await db
          .select({ notify: userPreferences.notifyTasksAssigned })
          .from(userPreferences)
          .where(eq(userPreferences.userId, parsed.assignedToId))
          .limit(1);
        if (prefs[0]?.notify !== false) {
          await createNotification({
            userId: parsed.assignedToId,
            kind: "task_assigned",
            title: `New task: ${parsed.title}`,
            link: parsed.leadId ? `/leads/${parsed.leadId}` : `/tasks`,
          });
        }
      }

      revalidatePath("/tasks");
      // revalidate the linked entity's detail page
      // so the Tasks section there picks up the new row immediately.
      if (parsed.leadId) revalidatePath(`/leads/${parsed.leadId}`);
      if (parsed.accountId) revalidatePath(`/accounts/${parsed.accountId}`);
      if (parsed.contactId) revalidatePath(`/contacts/${parsed.contactId}`);
      if (parsed.opportunityId)
        revalidatePath(`/opportunities/${parsed.opportunityId}`);
      return { id: result.id };
    },
  );
}

const updateActionSchema = taskUpdateSchema.extend({
  id: z.string().uuid(),
  // required so concurrentUpdate can reject stale writes.
  version: z.coerce.number().int().positive(),
});

export async function updateTaskAction(
  raw: z.infer<typeof updateActionSchema>,
): Promise<ActionResult<TaskVersionData>> {
  return withErrorBoundary(
    { action: "task.update" },
    async (): Promise<TaskVersionData> => {
      const session = await requireSession();
      const parsed = updateActionSchema.parse(raw);

      const { id, version, ...patch } = parsed;

      // Defence-in-depth access gate. Admin or canEditOthersTasks
      // can touch any task; otherwise the actor must be the
      // creator or assignee. This matches the canDeleteTask gate.
      const [row] = await db
        .select({
          createdById: tasks.createdById,
          assignedToId: tasks.assignedToId,
        })
        .from(tasks)
        .where(eq(tasks.id, id))
        .limit(1);
      if (!row) {
        throw new ForbiddenError("Task not found.");
      }
      const perms = await getPermissions(session.id);
      const isOwnerOrAssignee =
        row.createdById === session.id || row.assignedToId === session.id;
      const canEditOthers = session.isAdmin || perms.canEditOthersTasks;
      if (!canEditOthers && !isOwnerOrAssignee) {
        await writeAudit({
          actorId: session.id,
          action: "access.denied.task.update",
          targetType: "task",
          targetId: id,
        });
        throw new ForbiddenError("You can't edit this task.");
      }

      const result = await updateTask(
        id,
        version,
        patch as TaskUpdateInput,
        session.id,
      );
      revalidatePath("/tasks");
      return { version: result.version };
    },
  );
}

/**
 * REPLACED. The pre-Phase-10 deleteTaskAction did a HARD
 * delete with NO permission check (any signed-in user could drop any
 * task). This now does a soft-delete gated by creator/assignee/admin
 * per the matrix and returns an undo token.
 */
export async function deleteTaskAction(
  id: string,
): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "task.archive", entityType: "task", entityId: id },
    async (): Promise<{ undoToken: string }> => {
      const session = await requireSession();
      const taskId = z.string().uuid().parse(id);

      const [row] = await db
        .select({
          id: tasks.id,
          createdById: tasks.createdById,
          assignedToId: tasks.assignedToId,
          title: tasks.title,
          leadId: tasks.leadId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      if (!row) throw new ForbiddenError("Task not found.");
      if (!canDeleteTask(session, row)) {
        await writeAudit({
          actorId: session.id,
          action: "access.denied.task.delete",
          targetType: "task",
          targetId: taskId,
        });
        throw new ForbiddenError("You can't archive this task.");
      }

      await archiveTasksById([taskId], session.id);
      await writeAudit({
        actorId: session.id,
        action: "task.archive",
        targetType: "task",
        targetId: taskId,
        before: { title: row.title, createdById: row.createdById, assignedToId: row.assignedToId },
      });

      await emitActivity({
        actorId: session.id,
        verb: "Archived",
        entityType: "task",
        entityId: taskId,
        entityDisplayName: row.title,
        link: row.leadId ? `/leads/${row.leadId}` : "/tasks",
      });

      // Persistent stakeholder-side prompt so a non-admin creator or
      // assignee can self-restore for the full 30-day window after
      // the 30s undo toast expires. Emit to BOTH stakeholders (the
      // canDeleteTask predicate grants restore to either), de-duped:
      // skip when the recipient IS the actor, and skip creator when
      // creator === assignee.
      const taskLink = row.leadId ? `/leads/${row.leadId}` : "/tasks";
      const stakeholders = new Set<string>();
      if (row.createdById) stakeholders.add(row.createdById);
      if (row.assignedToId) stakeholders.add(row.assignedToId);
      for (const ownerId of stakeholders) {
        await emitArchiveNotification({
          entityType: "task",
          entityId: taskId,
          entityDisplayName: row.title,
          ownerId,
          actorId: session.id,
          link: taskLink,
        });
      }

      revalidatePath("/tasks");
      return {
        undoToken: signUndoToken({
          entity: "task",
          id: taskId,
          deletedAt: new Date(),
        }),
      };
    },
  );
}

export async function undoArchiveTaskAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.unarchive_undo" }, async () => {
    const session = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "task") throw new ForbiddenError("Token mismatch.");
    const [row] = await db
      .select({
        id: tasks.id,
        createdById: tasks.createdById,
        assignedToId: tasks.assignedToId,
        title: tasks.title,
        leadId: tasks.leadId,
      })
      .from(tasks)
      .where(eq(tasks.id, payload.id))
      .limit(1);
    if (!row) throw new ForbiddenError("Task not found.");
    if (!canDeleteTask(session, row)) {
      throw new ForbiddenError("You can't restore this task.");
    }
    await restoreTasksById([payload.id], session.id);
    await writeAudit({
      actorId: session.id,
      action: "task.unarchive_undo",
      targetType: "task",
      targetId: payload.id,
    });

    await emitActivity({
      actorId: session.id,
      verb: "Restored",
      entityType: "task",
      entityId: payload.id,
      entityDisplayName: row.title,
      link: row.leadId ? `/leads/${row.leadId}` : "/tasks",
    });

    revalidatePath("/tasks");
    revalidatePath("/tasks/archived");
  });
}

/**
 * Restore an archived task. Creator-or-assignee-or-admin (parity with
 * archive — canDeleteTask). Hard delete is still admin-only.
 * Re-fetches the archived row to verify ownership — never trusts the
 * client's claim.
 *
 * @actor creator, assignee, or admin
 */
export async function restoreTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.restore" }, async () => {
    const session = await requireSession();
    const id = z.string().uuid().parse(formData.get("id"));

    // Re-fetch the archived row (no isDeleted filter — we are
    // explicitly restoring a soft-deleted row). canDeleteTask is the
    // same predicate the archive path uses (creator OR assignee OR
    // admin). Reads the soft-delete attribution columns too so the
    // audit can record the pre-restore archived state (L-9 forensic
    // before+after).
    const [archivedRow] = await db
      .select({
        id: tasks.id,
        createdById: tasks.createdById,
        assignedToId: tasks.assignedToId,
        isDeleted: tasks.isDeleted,
        deletedAt: tasks.deletedAt,
        deletedById: tasks.deletedById,
        deleteReason: tasks.deleteReason,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (!archivedRow) throw new NotFoundError("Task not found.");
    if (!canDeleteTask(session, archivedRow)) {
      await writeAudit({
        actorId: session.id,
        action: "access.denied.task.restore",
        targetType: "task",
        targetId: id,
      });
      throw new ForbiddenError("You can't restore this task.");
    }

    const cascade = await restoreTasksById([id], session.id);
    const [restored] = await db
      .select({ title: tasks.title, leadId: tasks.leadId })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    await writeAudit({
      actorId: session.id,
      action: "task.restore",
      targetType: "task",
      targetId: id,
      before: {
        isDeleted: archivedRow.isDeleted,
        deletedAt: archivedRow.deletedAt,
        deletedById: archivedRow.deletedById,
        deleteReason: archivedRow.deleteReason,
      },
      after: {
        // Tasks have no children; cascade shape returned with zeros
        // to keep forensic parity with sibling restore audits.
        cascadedTasks: cascade.cascadedTasks,
        cascadedActivities: cascade.cascadedActivities,
      },
    });

    await emitActivity({
      actorId: session.id,
      verb: "Restored",
      entityType: "task",
      entityId: id,
      entityDisplayName: restored?.title ?? "",
      link: restored?.leadId ? `/leads/${restored.leadId}` : "/tasks",
    });

    revalidatePath("/tasks/archived");
    revalidatePath("/tasks");
  });
}

export async function hardDeleteTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.hard_delete" }, async () => {
    const session = await requireSession();
    if (!canHardDelete(session)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const [snapshot] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    await deleteTasksById([id]);
    await writeAudit({
      actorId: session.id,
      action: "task.hard_delete",
      targetType: "task",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
    revalidatePath("/tasks/archived");
  });
}

export async function toggleTaskCompleteAction(
  id: string,
  expectedVersion: number,
  completed: boolean,
): Promise<ActionResult<TaskVersionData>> {
  return withErrorBoundary(
    { action: "task.toggle_complete", entityType: "task", entityId: id },
    async (): Promise<TaskVersionData> => {
      const session = await requireSession();
      const result = await updateTask(
        id,
        expectedVersion,
        { status: completed ? "completed" : "open" },
        session.id,
      );
      // Belt-and-suspenders: updateTask should now always throw on
      // empty-rows (post-await-expectAffected fix); if it ever returns
      // undefined despite that, surface a ConflictError instead of
      // crashing on `result.version`. The lib's contract is "real row
      // or thrown" — this guard keeps the action's contract intact.
      if (!result) {
        throw new ConflictError(
          "Task changed elsewhere — refresh.",
          { id },
        );
      }
      revalidatePath("/tasks");
      return { version: result.version };
    },
  );
}
