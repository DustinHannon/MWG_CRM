import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";

/**
 * Phase 9C — task cursor format: `<iso8601-due_at-or-"null">:<uuid>`.
 * The default sort is `(due_at ASC NULLS LAST, id DESC)`, so a NULL
 * due_at puts a row in the tail block — encoded with the literal
 * timestamp "null".
 */
export interface ParsedTaskCursor {
  due: Date | null;
  id: string;
}
export function parseTaskCursor(raw: string | undefined | null): ParsedTaskCursor | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const tsPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idPart)) {
    return null;
  }
  if (tsPart === "null" || tsPart === "") return { due: null, id: idPart };
  const d = new Date(tsPart);
  if (Number.isNaN(d.getTime())) return null;
  return { due: d, id: idPart };
}
export function encodeTaskCursor(due: Date | null, id: string): string {
  return `${due ? due.toISOString() : "null"}:${id}`;
}

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

/**
 * Phase 9C — page-size + cursor support added. Default page size is 50;
 * pass `pageSize: 0` (or omit the cursor entirely) for the legacy
 * unbounded fetch (only safe for callers that already constrain by
 * leadId / scope / etc.). Cursor format documented on `parseTaskCursor`.
 *
 * Returns `{ rows, nextCursor }` always so callers don't have to check
 * a flag. `nextCursor` is null when no further rows exist.
 */
export interface ListTasksResult {
  rows: TaskRow[];
  nextCursor: string | null;
}

export async function listTasksForUser(args: {
  userId: string;
  isAdmin: boolean;
  status?: ("open" | "in_progress" | "completed" | "cancelled")[];
  scope?: "me" | "all";
  cursor?: string | null;
  /** 0 disables pagination (legacy callers). Defaults to 50. */
  pageSize?: number;
}): Promise<ListTasksResult> {
  const wheres: SQL[] = [];
  // Phase 9C — exclude soft-deleted tasks from every listing.
  wheres.push(eq(tasks.isDeleted, false));
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

  const pageSize = args.pageSize ?? 50;
  // Phase 9C — cursor seeks via composite index
  // `tasks_assigned_due_at_id_idx (assigned_to_id, due_at NULLS LAST, id DESC)`.
  const cursor = pageSize > 0 ? parseTaskCursor(args.cursor) : null;
  if (cursor) {
    if (cursor.due === null) {
      // Past the due-at non-null block; only id-tiebreak remains.
      wheres.push(sql`(${tasks.dueAt} IS NULL AND ${tasks.id} < ${cursor.id})`);
    } else {
      wheres.push(
        sql`(
          ${tasks.dueAt} > ${cursor.due.toISOString()}::timestamptz
          OR (${tasks.dueAt} = ${cursor.due.toISOString()}::timestamptz AND ${tasks.id} < ${cursor.id})
          OR ${tasks.dueAt} IS NULL
        )`,
      );
    }
  }

  const where = wheres.length === 0 ? undefined : and(...wheres);
  const sliceLimit = pageSize > 0 ? pageSize + 1 : undefined;

  let q = db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(where)
    .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, desc(tasks.id))
    .$dynamic();
  if (sliceLimit) q = q.limit(sliceLimit);
  const rowsRaw = await q;

  if (pageSize <= 0 || rowsRaw.length <= pageSize) {
    return { rows: rowsRaw, nextCursor: null };
  }
  const rows = rowsRaw.slice(0, pageSize);
  const last = rows[rows.length - 1];
  return { rows, nextCursor: encodeTaskCursor(last.dueAt, last.id) };
}

export async function listTasksForLead(leadId: string): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(and(eq(tasks.leadId, leadId), eq(tasks.isDeleted, false)))
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
        eq(tasks.isDeleted, false),
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
    // Phase 12 — actor stamping for skip-self in Supabase Realtime.
    updatedById: actorId,
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

/**
 * Phase 10 — soft-delete (archive) tasks. Sets is_deleted=true and the
 * deletion-attribution columns. Reversible via restoreTasksById().
 *
 * @actor task creator, assignee, or admin (caller enforces)
 */
export async function archiveTasksById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(tasks)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: reason ?? null,
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(tasks.id, ids));
}

/** Phase 10 — restore archived tasks. */
export async function restoreTasksById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(tasks)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      deleteReason: null,
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(tasks.id, ids));
}

/** Phase 10 — admin hard-delete. Use only from admin flows. */
export async function deleteTasksById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(tasks).where(inArray(tasks.id, ids));
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
