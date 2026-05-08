"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth-helpers";
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
import { createNotification } from "@/lib/notifications";
import { db } from "@/db";
import { tasks } from "@/db/schema/tasks";
import { userPreferences } from "@/db/schema/views";
import { eq } from "drizzle-orm";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { ForbiddenError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { canDeleteTask, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

/**
 * Phase 3D server actions for tasks. Validate, audit, optionally notify
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
      if (parsed.leadId) {
        revalidatePath(`/leads/${parsed.leadId}`);
      }
      return { id: result.id };
    },
  );
}

const updateActionSchema = taskUpdateSchema.extend({
  id: z.string().uuid(),
  // Phase 6B — required so concurrentUpdate can reject stale writes.
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
 * Phase 10 — REPLACED. The pre-Phase-10 deleteTaskAction did a HARD
 * delete with NO permission check (any signed-in user could drop any
 * task). This now does a soft-delete gated by creator/assignee/admin
 * per the Phase 10 matrix and returns an undo token.
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
    revalidatePath("/tasks");
    revalidatePath("/tasks/archived");
  });
}

export async function restoreTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.restore" }, async () => {
    const session = await requireSession();
    if (!canHardDelete(session)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    await restoreTasksById([id], session.id);
    await writeAudit({
      actorId: session.id,
      action: "task.restore",
      targetType: "task",
      targetId: id,
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
      revalidatePath("/tasks");
      return { version: result.version };
    },
  );
}
