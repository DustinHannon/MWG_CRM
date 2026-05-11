"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  createSavedTaskView,
  deleteSavedTaskView,
  getSavedTaskView,
  taskViewSchema,
  updateSavedTaskView,
  type TaskViewInput,
} from "@/lib/task-views";
import { writeAudit } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  bulkCompleteTasks,
  bulkDeleteTasks,
  bulkReassignTasks,
} from "@/lib/tasks";
import { getPermissions } from "@/lib/auth-helpers";

/**
 * Phase 25 §7.3 — Tasks page server actions.
 *
 * Two surfaces wired here:
 *   1. Saved view CRUD (create / update / delete) — entity_type='task'
 *      scoped via `src/lib/task-views.ts`.
 *   2. Bulk actions (complete / reassign / delete) on selected rows —
 *      thin wrappers around the `bulk*Tasks` helpers in
 *      `src/lib/tasks.ts`. Each gates on the appropriate permission
 *      from the `permissions` table.
 *
 * Audit events stay canonical: `task.completed`, `task.reassigned`,
 * `task.deleted` (no fork by source surface).
 */

// =============================================================================
// Saved view CRUD
// =============================================================================

export async function createTaskViewAction(
  raw: TaskViewInput,
): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary({ action: "task_view.create" }, async () => {
    const session = await requireSession();
    const parsed = taskViewSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid task view input.");
    }
    const result = await createSavedTaskView(session.id, parsed.data);
    await writeAudit({
      actorId: session.id,
      action: "task_view.create",
      targetType: "saved_views",
      targetId: result.id,
      after: { name: parsed.data.name, filters: parsed.data.filters },
    });
    revalidatePath("/tasks");
    return result;
  });
}

const updateActionSchema = taskViewSchema.partial().extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
});

export async function updateTaskViewAction(
  raw: z.infer<typeof updateActionSchema>,
): Promise<ActionResult<{ version: number }>> {
  return withErrorBoundary({ action: "task_view.update" }, async () => {
    const session = await requireSession();
    const parsed = updateActionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid task view update.");
    }
    const { id, version, ...patch } = parsed.data;
    const existing = await getSavedTaskView(session.id, id);
    if (!existing) throw new NotFoundError("task view");
    if (existing.version !== version) {
      throw new ConflictError(
        "This view was modified by someone else. Refresh and try again.",
      );
    }
    const result = await updateSavedTaskView(session.id, id, version, patch);
    await writeAudit({
      actorId: session.id,
      action: "task_view.update",
      targetType: "saved_views",
      targetId: id,
      after: patch as Record<string, unknown>,
    });
    revalidatePath("/tasks");
    return { version: result.version };
  });
}

export async function deleteTaskViewAction(
  id: string,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task_view.delete" }, async () => {
    const session = await requireSession();
    if (!z.string().uuid().safeParse(id).success) {
      throw new ValidationError("Invalid task view id.");
    }
    await deleteSavedTaskView(session.id, id);
    await writeAudit({
      actorId: session.id,
      action: "task_view.delete",
      targetType: "saved_views",
      targetId: id,
    });
    revalidatePath("/tasks");
  });
}

// =============================================================================
// Bulk actions on selected rows
// =============================================================================

const bulkIdsSchema = z
  .object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export async function bulkCompleteTasksAction(
  raw: z.infer<typeof bulkIdsSchema>,
): Promise<ActionResult<{ updated: number }>> {
  return withErrorBoundary({ action: "task.completed" }, async () => {
    const session = await requireSession();
    const parsed = bulkIdsSchema.parse(raw);
    // Every user can complete tasks assigned to them. Cross-user
    // complete-others is gated by canEditOthersTasks; the lib-level
    // helper doesn't enforce — we enforce here by walking the ids OR
    // delegating fully to admins. Simplest correct: admins / users
    // with canEditOthersTasks complete any; otherwise the helper's
    // UPDATE WHERE inArray(...) plus a defensive assignedToId match.
    const perms = await getPermissions(session.id);
    if (session.isAdmin || perms.canEditOthersTasks) {
      const result = await bulkCompleteTasks(parsed.ids, session.id);
      revalidatePath("/tasks");
      return result;
    }
    // Non-privileged user: silently scope the update to tasks they
    // own — anything else fails the WHERE clause. The lib helper
    // doesn't expose an owner gate, so we use a narrower path: query
    // ids first, filter to owned, then call.
    // For now this branch returns a ForbiddenError if any id isn't
    // theirs (safer than silent partial-success).
    const { db } = await import("@/db");
    const { tasks: tasksTable } = await import("@/db/schema/tasks");
    const { eq, inArray, and } = await import("drizzle-orm");
    const own = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          inArray(tasksTable.id, parsed.ids),
          eq(tasksTable.assignedToId, session.id),
        ),
      );
    if (own.length !== parsed.ids.length) {
      throw new ForbiddenError(
        "Some of the selected tasks are assigned to someone else.",
      );
    }
    const result = await bulkCompleteTasks(parsed.ids, session.id);
    revalidatePath("/tasks");
    return result;
  });
}

const bulkReassignSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  newAssigneeId: z.string().uuid(),
});

export async function bulkReassignTasksAction(
  raw: z.infer<typeof bulkReassignSchema>,
): Promise<ActionResult<{ updated: number }>> {
  return withErrorBoundary({ action: "task.reassigned" }, async () => {
    const session = await requireSession();
    const parsed = bulkReassignSchema.parse(raw);
    const perms = await getPermissions(session.id);
    if (!session.isAdmin && !perms.canReassignTasks) {
      throw new ForbiddenError("You don't have permission to reassign tasks.");
    }
    const result = await bulkReassignTasks(
      parsed.ids,
      parsed.newAssigneeId,
      session.id,
    );
    revalidatePath("/tasks");
    return result;
  });
}

export async function bulkDeleteTasksAction(
  raw: z.infer<typeof bulkIdsSchema>,
): Promise<ActionResult<{ updated: number }>> {
  return withErrorBoundary({ action: "task.deleted" }, async () => {
    const session = await requireSession();
    const parsed = bulkIdsSchema.parse(raw);
    const perms = await getPermissions(session.id);
    if (!session.isAdmin && !perms.canDeleteOthersTasks) {
      // Non-privileged users can still bulk-delete tasks they own.
      const { db } = await import("@/db");
      const { tasks: tasksTable } = await import("@/db/schema/tasks");
      const { eq, inArray, and } = await import("drizzle-orm");
      const own = await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(
          and(
            inArray(tasksTable.id, parsed.ids),
            eq(tasksTable.assignedToId, session.id),
          ),
        );
      if (own.length !== parsed.ids.length) {
        throw new ForbiddenError(
          "Some of the selected tasks are assigned to someone else.",
        );
      }
    }
    const result = await bulkDeleteTasks(parsed.ids, session.id);
    revalidatePath("/tasks");
    return result;
  });
}
