"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth-helpers";
import {
  createTask,
  deleteTask,
  taskCreateSchema,
  taskUpdateSchema,
  updateTask,
  type TaskCreateInput,
  type TaskUpdateInput,
} from "@/lib/tasks";
import { createNotification } from "@/lib/notifications";
import { logger } from "@/lib/logger";
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";
import { eq } from "drizzle-orm";

/**
 * Phase 3D server actions for tasks. Validate, audit, optionally notify
 * the assignee.
 */

export async function createTaskAction(
  raw: TaskCreateInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = await requireSession();
  const parsed = taskCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  try {
    const result = await createTask(parsed.data, session.id);

    // Notify the assignee if it's not the current user (and they want to know).
    if (
      parsed.data.assignedToId &&
      parsed.data.assignedToId !== session.id
    ) {
      const prefs = await db
        .select({ notify: userPreferences.notifyTasksAssigned })
        .from(userPreferences)
        .where(eq(userPreferences.userId, parsed.data.assignedToId))
        .limit(1);
      if (prefs[0]?.notify !== false) {
        await createNotification({
          userId: parsed.data.assignedToId,
          kind: "task_assigned",
          title: `New task: ${parsed.data.title}`,
          link: parsed.data.leadId
            ? `/leads/${parsed.data.leadId}`
            : `/tasks`,
        });
      }
    }

    revalidatePath("/tasks");
    if (parsed.data.leadId) {
      revalidatePath(`/leads/${parsed.data.leadId}`);
    }
    return { ok: true, id: result.id };
  } catch (err) {
    logger.error("task.create_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not create task." };
  }
}

const updateActionSchema = taskUpdateSchema.extend({
  id: z.string().uuid(),
});

export async function updateTaskAction(
  raw: z.infer<typeof updateActionSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const parsed = updateActionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  try {
    const { id, ...patch } = parsed.data;
    await updateTask(id, patch as TaskUpdateInput, session.id);
    revalidatePath("/tasks");
    return { ok: true };
  } catch (err) {
    logger.error("task.update_failed", {
      taskId: parsed.data.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not update task." };
  }
}

export async function deleteTaskAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  try {
    await deleteTask(id, session.id);
    revalidatePath("/tasks");
    return { ok: true };
  } catch (err) {
    logger.error("task.delete_failed", {
      taskId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not delete task." };
  }
}

export async function toggleTaskCompleteAction(
  id: string,
  completed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  try {
    await updateTask(
      id,
      { status: completed ? "completed" : "open" },
      session.id,
    );
    revalidatePath("/tasks");
    return { ok: true };
  } catch (err) {
    logger.error("task.toggle_complete_failed", {
      taskId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not update task." };
  }
}
