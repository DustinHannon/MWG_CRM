import "server-only";
import { and, asc, desc, eq, inArray, isNull, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { crmAccounts, contacts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";

/**
 * task cursor format: `<iso8601-due_at-or-"null">:<uuid>`.
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

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    dueAt: z.coerce.date().optional().nullable(),
    assignedToId: z.string().uuid().optional().nullable(),
    // exactly one of these four can be set (or all
    // null = standalone). Backed by CHECK constraint
    // `tasks_at_most_one_parent`. The Zod refine below catches the
    // ≥2 case at the action layer so the user sees a clean
    // ValidationError instead of a raw PG 23514.
    leadId: z.string().uuid().optional().nullable(),
    accountId: z.string().uuid().optional().nullable(),
    contactId: z.string().uuid().optional().nullable(),
    opportunityId: z.string().uuid().optional().nullable(),
  })
  .refine(
    (v) => {
      const count =
        Number(!!v.leadId) +
        Number(!!v.accountId) +
        Number(!!v.contactId) +
        Number(!!v.opportunityId);
      return count <= 1;
    },
    { message: "A task can be linked to at most one entity." },
  );

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
  // version exposed on every list/detail row so the client
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
  // exactly one of these is non-null when the task is
  // linked to a parent entity (CHECK constraint `tasks_at_most_one_parent`
  // enforces ≤1). All four null = standalone task.
  leadId: string | null;
  leadName: string | null;
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  tags: Array<{ id: string; name: string; color: string | null }> | null;
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
  // pull display names for every related-entity slot
  // so the /tasks Related-to column + lead-detail tab + dashboard
  // widget all share the same shape.
  leadId: tasks.leadId,
  leadName:
    sql<string | null>`CASE WHEN ${leads.id} IS NULL THEN NULL ELSE concat_ws(' ', ${leads.firstName}, ${leads.lastName}) END`,
  accountId: tasks.accountId,
  accountName: crmAccounts.name,
  contactId: tasks.contactId,
  contactName:
    sql<string | null>`CASE WHEN ${contacts.id} IS NULL THEN NULL ELSE concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) END`,
  opportunityId: tasks.opportunityId,
  opportunityName: opportunities.name,
  // hydrate full tag objects from the relational task_tags join so
  // the list cell can render TagChip components.
  tags: sql<
    Array<{ id: string; name: string; color: string | null }> | null
  >`(
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'name', t.name,
          'color', t.color
        )
        ORDER BY t.name
      ),
      '[]'::jsonb
    )
    FROM task_tags tt
    JOIN tags t ON t.id = tt.tag_id
    WHERE tt.task_id = ${tasks.id}
  )`,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

/**
 * page-size + cursor support added. Default page size is 50;
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
  /** filter by related-entity link state. */
  relation?: "all" | "standalone" | "linked";
  /** expansion — additional filter dimensions. */
  priority?: ("low" | "normal" | "high" | "urgent")[];
  relatedEntity?: "lead" | "account" | "contact" | "opportunity";
  dueRange?: "overdue" | "today" | "this_week" | "later" | "none" | "all";
  q?: string;
  /** explicit assignee filter for the new /tasks
   * redesign. `me` (default) preserves existing behavior; a specific
   * user id scopes to that user; `any` shows everyone (requires
   * canViewOthersTasks). When unset, falls back to scope semantics. */
  assignee?: "me" | "any" | string;
  /** When false, skip the (due_at NULLS LAST, id DESC) cursor index
   * and use the requested sort. Cursor pagination is then disabled. */
  sort?: {
    field:
      | "dueAt"
      | "priority"
      | "title"
      | "assignee"
      | "status"
      | "createdAt";
    direction: "asc" | "desc";
  };
  cursor?: string | null;
  /** 0 disables pagination (legacy callers). Defaults to 50. */
  pageSize?: number;
  /**
   * Filter to tasks bearing ANY of the given tag names (OR
   * semantics, case-insensitive). Matched via the task_tags
   * junction to tags.name.
   */
  tags?: string[];
}): Promise<ListTasksResult> {
  const wheres: SQL[] = [];
  // exclude soft-deleted tasks from every listing.
  wheres.push(eq(tasks.isDeleted, false));

  // assignee filter takes precedence over the legacy
  // `scope` arg. When neither is set, default to "me" for the original
  // /tasks personal-queue behavior. The "any" sentinel disables the
  // assigned-to filter entirely (caller is responsible for gating via
  // canViewOthersTasks).
  const assignee = args.assignee ?? (args.scope === "all" ? "any" : "me");
  if (assignee === "me") {
    wheres.push(eq(tasks.assignedToId, args.userId));
  } else if (assignee !== "any") {
    wheres.push(eq(tasks.assignedToId, assignee));
  } else if (!args.isAdmin) {
    // assignee === "any" but not admin — fall back to the existing
    // creator-OR-assignee visibility window.
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
  // priority filter.
  if (args.priority && args.priority.length > 0) {
    wheres.push(
      or(...args.priority.map((p) => eq(tasks.priority, p)))!,
    );
  }
  // relation filter. CHECK `tasks_at_most_one_parent`
  // ensures at most one FK is set, so "linked" means any of the four
  // is non-null and "standalone" means all four are null.
  if (args.relation === "standalone") {
    wheres.push(
      and(
        isNull(tasks.leadId),
        isNull(tasks.accountId),
        isNull(tasks.contactId),
        isNull(tasks.opportunityId),
      )!,
    );
  } else if (args.relation === "linked") {
    wheres.push(
      or(
        isNotNull(tasks.leadId),
        isNotNull(tasks.accountId),
        isNotNull(tasks.contactId),
        isNotNull(tasks.opportunityId),
      )!,
    );
  }
  // relatedEntity filter (only meaningful when
  // relation='linked' or unset). Forces the chosen FK column to be
  // non-null.
  if (args.relatedEntity) {
    if (args.relatedEntity === "lead") wheres.push(isNotNull(tasks.leadId));
    else if (args.relatedEntity === "account")
      wheres.push(isNotNull(tasks.accountId));
    else if (args.relatedEntity === "contact")
      wheres.push(isNotNull(tasks.contactId));
    else if (args.relatedEntity === "opportunity")
      wheres.push(isNotNull(tasks.opportunityId));
  }
  // due-date-range filter. Bucketed off the same
  // boundaries the page UI used for grouping, so saved views show
  // the same set the user picks via the chip row.
  if (args.dueRange && args.dueRange !== "all") {
    const now = sql`now()`;
    const endOfToday = sql`date_trunc('day', now()) + interval '1 day' - interval '1 second'`;
    const endOfWeek = sql`date_trunc('day', now()) + interval '7 days'`;
    if (args.dueRange === "overdue") {
      wheres.push(sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < ${now}`);
    } else if (args.dueRange === "today") {
      wheres.push(
        sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} >= date_trunc('day', now()) AND ${tasks.dueAt} <= ${endOfToday}`,
      );
    } else if (args.dueRange === "this_week") {
      wheres.push(
        sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} > ${endOfToday} AND ${tasks.dueAt} <= ${endOfWeek}`,
      );
    } else if (args.dueRange === "later") {
      wheres.push(sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} > ${endOfWeek}`);
    } else if (args.dueRange === "none") {
      wheres.push(isNull(tasks.dueAt));
    }
  }
  // title search. ILIKE is fine here (tasks table is
  // small; no trigram index needed at current scale).
  if (args.q && args.q.trim()) {
    const pattern = `%${args.q.trim()}%`;
    wheres.push(sql`${tasks.title} ILIKE ${pattern}`);
  }
  // tag-name filter via the task_tags junction. OR semantics,
  // case-insensitive.
  if (args.tags && args.tags.length > 0) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM task_tags tt
        JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id = ${tasks.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(${args.tags}::text[]) AS x
        )
      )`,
    );
  }

  const pageSize = args.pageSize ?? 50;
  // cursor seeks via composite index
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
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
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
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(and(eq(tasks.leadId, leadId), eq(tasks.isDeleted, false)))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

// sibling helpers for the other three entity-detail
// Tasks tabs. Same shape as listTasksForLead; backed by the same
// table + JOINs (no parallel storage).

export async function listTasksForAccount(accountId: string): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(and(eq(tasks.accountId, accountId), eq(tasks.isDeleted, false)))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

export async function listTasksForContact(contactId: string): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(and(eq(tasks.contactId, contactId), eq(tasks.isDeleted, false)))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

export async function listTasksForOpportunity(
  opportunityId: string,
): Promise<TaskRow[]> {
  return db
    .select(baseSelect)
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .where(
      and(eq(tasks.opportunityId, opportunityId), eq(tasks.isDeleted, false)),
    )
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

// bulk-action helpers for the new /tasks toolbar.
// Each helper writes a single audit row per affected task using the
// canonical event names so audit volume scales linearly. Caller
// must have already access-checked (canEditOthersTasks /
// canDeleteOthersTasks / canReassignTasks).

export async function bulkCompleteTasks(
  ids: string[],
  actorId: string,
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const completedAt = new Date();
  const updated = await db
    .update(tasks)
    .set({
      status: "completed",
      completedAt,
      updatedById: actorId,
      updatedAt: completedAt,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(inArray(tasks.id, ids), eq(tasks.isDeleted, false)))
    .returning({ id: tasks.id });
  for (const t of updated) {
    await writeAudit({
      actorId,
      action: "task.completed",
      targetType: "tasks",
      targetId: t.id,
      after: { completedAt: completedAt.toISOString() },
    });
  }
  return { updated: updated.length };
}

export async function bulkReassignTasks(
  ids: string[],
  newAssigneeId: string,
  actorId: string,
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const updated = await db
    .update(tasks)
    .set({
      assignedToId: newAssigneeId,
      updatedById: actorId,
      updatedAt: new Date(),
      version: sql`${tasks.version} + 1`,
    })
    .where(and(inArray(tasks.id, ids), eq(tasks.isDeleted, false)))
    .returning({ id: tasks.id });
  for (const t of updated) {
    await writeAudit({
      actorId,
      action: "task.reassigned",
      targetType: "tasks",
      targetId: t.id,
      after: { newAssigneeId },
    });
  }
  return { updated: updated.length };
}

export async function bulkDeleteTasks(
  ids: string[],
  actorId: string,
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const deletedAt = new Date();
  const updated = await db
    .update(tasks)
    .set({
      isDeleted: true,
      deletedAt,
      deletedById: actorId,
      updatedAt: deletedAt,
      updatedById: actorId,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(inArray(tasks.id, ids), eq(tasks.isDeleted, false)))
    .returning({ id: tasks.id });
  for (const t of updated) {
    await writeAudit({
      actorId,
      action: "task.deleted",
      targetType: "tasks",
      targetId: t.id,
    });
  }
  return { updated: updated.length };
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
    .leftJoin(crmAccounts, eq(crmAccounts.id, tasks.accountId))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
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
      // at most one parent FK populated; the Zod
      // refine + DB CHECK constraint both enforce this.
      leadId: input.leadId ?? null,
      accountId: input.accountId ?? null,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
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
    // actor stamping for skip-self in Supabase Realtime.
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
 * soft-delete (archive) tasks. Sets is_deleted=true and the
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
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(tasks.id, ids));
}

/** restore archived tasks. */
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
      // actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(tasks.id, ids));
}

/** admin hard-delete. Use only from admin flows. */
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

/**
 * paginated task listing for /api/v1/tasks. Returns the
 * offset-pagination envelope the v1 API contract requires.
 */
export async function listTasksForApi(args: {
  status?: "open" | "in_progress" | "completed" | "cancelled";
  assignedToId?: string;
  leadId?: string;
  page: number;
  pageSize: number;
  ownerScope: { actorId: string; canViewAll: boolean };
}): Promise<{
  rows: TaskRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const wheres: SQL[] = [eq(tasks.isDeleted, false)];
  if (args.status) wheres.push(eq(tasks.status, args.status));
  if (args.assignedToId) wheres.push(eq(tasks.assignedToId, args.assignedToId));
  if (args.leadId) wheres.push(eq(tasks.leadId, args.leadId));
  if (!args.ownerScope.canViewAll) {
    wheres.push(
      or(
        eq(tasks.assignedToId, args.ownerScope.actorId),
        eq(tasks.createdById, args.ownerScope.actorId),
      )!,
    );
  }
  const where = and(...wheres);
  const offset = (args.page - 1) * args.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select(baseSelect)
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assignedToId))
      .leftJoin(leads, eq(leads.id, tasks.leadId))
      .where(where)
      .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, desc(tasks.id))
      .limit(args.pageSize)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    page: args.page,
    pageSize: args.pageSize,
  };
}

/**
 * fetch a single task and its row context (assignee, parent).
 * Returns null when the row doesn't exist or is soft-deleted.
 */
export async function getTaskForApi(
  id: string,
  ownerScope: { actorId: string; canViewAll: boolean },
): Promise<
  | (typeof tasks.$inferSelect & {
      assignedToName: string | null;
    })
  | null
> {
  const [row] = await db
    .select({
      id: tasks.id,
      version: tasks.version,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueAt: tasks.dueAt,
      completedAt: tasks.completedAt,
      assignedToId: tasks.assignedToId,
      assignedToName: users.displayName,
      createdById: tasks.createdById,
      updatedById: tasks.updatedById,
      leadId: tasks.leadId,
      accountId: tasks.accountId,
      contactId: tasks.contactId,
      opportunityId: tasks.opportunityId,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      isDeleted: tasks.isDeleted,
      deletedAt: tasks.deletedAt,
      deletedById: tasks.deletedById,
      deleteReason: tasks.deleteReason,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .where(and(eq(tasks.id, id), eq(tasks.isDeleted, false)))
    .limit(1);
  if (!row) return null;
  if (
    !ownerScope.canViewAll &&
    row.assignedToId !== ownerScope.actorId &&
    row.createdById !== ownerScope.actorId
  ) {
    return null;
  }
  return row as unknown as typeof tasks.$inferSelect & {
    assignedToName: string | null;
  };
}
