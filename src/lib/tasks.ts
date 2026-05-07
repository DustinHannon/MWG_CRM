import "server-only";
import { and, asc, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueAt: z.coerce.date().optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
});

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueAt: z.coerce.date().optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

export interface TaskRow {
  id: string;
  // Phase 6B — version exposed on every list/detail row so the client
  // has the right value to send back on toggle/edit.
  version: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: Date | null;
  completedAt: Date | null;
  assignedToId: string | null;
  assignedToName: string | null;
  createdById: string | null;
  leadId: string | null;
  leadName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const baseSelect = {
  id: tasks.id,
  version: tasks.version,
  title: tasks.title,
  description: tasks.description,
  status: sql<string>`${tasks.status}::text`,
  priority: sql<string>`${tasks.priority}::text`,
  dueAt: tasks.dueAt,
  completedAt: tasks.completedAt,
  assignedToId: tasks.assignedToId,
  assignedToName: users.displayName,
  createdById: tasks.createdById,
  leadId: tasks.leadId,
  leadName:
    sql<string | null>`CASE WHEN ${leads.id} IS NULL THEN NULL ELSE concat_ws(' ', ${leads.firstName}, ${leads.lastName}) END`,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

export async function listTasksForUser(args: {
  userId: string;
  isAdmin: boolean;
  status?: ("open" | "in_progress" | "completed" | "cancelled")[];
  scope?: "me" | "all";
}): Promise<TaskRow[]> {
  const wheres: SQL[] = [];
  if (args.scope !== "all") {
    wheres.push(eq(tasks.assignedToId, args.userId));
  } else if (!args.isAdmin) {
    // Non-admins see tasks assigned to them OR created by them OR
    // attached to a lead they own. Cap with the assigned filter for now.
    wheres.push(
      or(
        eq(tasks.assignedToId, args.userId),
        eq(tasks.createdById, args.userId),
      )!,
    );
  }
  if (args.status && args.status.length > 0) {
    wheres.push(
      or(
        ...args.status.map((s) => eq(tasks.status, s)),
      )!,
    );
  }

  const where = wheres.length === 0 ? undefined : and(...wheres);

  const rows = await db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(where)
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));

  return rows;
}

export async function listTasksForLead(leadId: string): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(eq(tasks.leadId, leadId))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

export async function listOpenTasksForUser(
  userId: string,
  limit = 5,
): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(
      and(
        eq(tasks.assignedToId, userId),
        or(eq(tasks.status, "open"), eq(tasks.status, "in_progress"))!,
      ),
    )
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt))
    .limit(limit);
}

export async function createTask(
  input: TaskCreateInput,
  actorId: string,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(tasks)
    .values({
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      assignedToId: input.assignedToId ?? actorId,
      createdById: actorId,
      leadId: input.leadId ?? null,
    })
    .returning({ id: tasks.id, assignedToId: tasks.assignedToId, title: tasks.title });
  const row = inserted[0];

  await writeAudit({
    actorId,
    action: "task.create",
    targetType: "tasks",
    targetId: row.id,
    after: input as Record<string, unknown>,
  });

  return { id: row.id };
}

export async function updateTask(
  id: string,
  expectedVersion: number,
  patch: TaskUpdateInput,
  actorId: string,
): Promise<{ id: string; version: number }> {
  const set: Record<string, unknown> = {
    ...patch,
    updatedAt: sql`now()`,
    version: sql`${tasks.version} + 1`,
  };
  if (patch.status === "completed") {
    set.completedAt = sql`now()`;
  } else if (patch.status === "open" || patch.status === "in_progress") {
    set.completedAt = null;
  }
  const rows = await db
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion)))
    .returning({ id: tasks.id, version: tasks.version });
  expectAffected(rows, { table: tasks, id, entityLabel: "task" });
  await writeAudit({
    actorId,
    action: "task.update",
    targetType: "tasks",
    targetId: id,
    after: patch as Record<string, unknown>,
  });
  return rows[0];
}

export async function deleteTask(id: string, actorId: string): Promise<void> {
  await db.delete(tasks).where(eq(tasks.id, id));
  await writeAudit({
    actorId,
    action: "task.delete",
    targetType: "tasks",
    targetId: id,
  });
}

/**
 * Tasks where due_at::date == today, status open/in_progress, for users
 * who haven't disabled the notify_tasks_due preference.
 *
 * Used by /api/cron/tasks-due-today.
 */
export async function listTasksDueTodayForCron(): Promise<
  Array<{
    id: string;
    title: string;
    assignedToId: string;
    leadId: string | null;
  }>
> {
  const rows = await db.execute<{
    id: string;
    title: string;
    assigned_to_id: string;
    lead_id: string | null;
  }>(sql`
    SELECT t.id, t.title, t.assigned_to_id, t.lead_id
    FROM tasks t
    INNER JOIN user_preferences p ON p.user_id = t.assigned_to_id
    WHERE t.status IN ('open', 'in_progress')
      AND t.assigned_to_id IS NOT NULL
      AND t.due_at IS NOT NULL
      AND t.due_at::date = (now() AT TIME ZONE 'America/Chicago')::date
      AND p.notify_tasks_due = true
  `);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    assignedToId: r.assigned_to_id,
    leadId: r.lead_id,
  }));
}

// Suppress unused import warning when isNull isn't needed.
void isNull;
