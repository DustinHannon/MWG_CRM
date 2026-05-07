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
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";
import { eq } from "drizzle-orm";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

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

export async function deleteTaskAction(
  id: string,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "task.delete", entityType: "task", entityId: id },
    async () => {
      const session = await requireSession();
      await deleteTask(id, session.id);
      revalidatePath("/tasks");
    },
  );
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
