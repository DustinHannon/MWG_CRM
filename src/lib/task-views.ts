import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedViews } from "@/db/schema/views";
import { expectAffected } from "@/lib/db/concurrent-update";

/**
 * Tasks saved-view layer. Parallel to `src/lib/views.ts`
 * (leads) but scoped to `saved_views.entity_type = 'task'`. The same
 * `saved_views` table backs both; the entity_type column is the
 * partition.
 *
 * Filter dimensions for tasks:
 * assignee: 'me' | <userId> | 'any'
 * status: ('open'|'in_progress'|'completed'|'cancelled')[]
 * priority: ('low'|'normal'|'high'|'urgent')[]
 * relation: 'all' | 'standalone' | 'linked'
 * relatedEntity: 'lead' | 'account' | 'contact' | 'opportunity' (when relation='linked')
 * dueRange: 'overdue' | 'today' | 'this_week' | 'later' | 'none' | 'all'
 *
 * Sort dimension: { field: 'dueAt' | 'priority' | 'title' | 'assignee' | 'status' | 'createdAt', direction: 'asc' | 'desc' }
 */

export interface TaskViewFilters {
  assignee?: "me" | "any" | string;
  status?: ("open" | "in_progress" | "completed" | "cancelled")[];
  priority?: ("low" | "normal" | "high" | "urgent")[];
  relation?: "all" | "standalone" | "linked";
  relatedEntity?: "lead" | "account" | "contact" | "opportunity";
  dueRange?: "overdue" | "today" | "this_week" | "later" | "none" | "all";
  q?: string;
}

export interface TaskViewSort {
  field:
    | "dueAt"
    | "priority"
    | "title"
    | "assignee"
    | "status"
    | "createdAt";
  direction: "asc" | "desc";
}

export interface TaskViewDefinition {
  id: string;
  source: "builtin" | "saved";
  name: string;
  isPinned: boolean;
  filters: TaskViewFilters;
  sort: TaskViewSort;
  version?: number;
}

// =============================================================================
// Built-in task views — read-only; surfaced in the view picker on /tasks.
// =============================================================================

export const BUILTIN_TASK_VIEWS: TaskViewDefinition[] = [
  {
    id: "builtin:my-open",
    source: "builtin",
    name: "My open tasks",
    isPinned: true,
    filters: {
      assignee: "me",
      status: ["open", "in_progress"],
      relation: "all",
      dueRange: "all",
    },
    sort: { field: "dueAt", direction: "asc" },
  },
  {
    id: "builtin:my-due-today",
    source: "builtin",
    name: "Due today",
    isPinned: false,
    filters: {
      assignee: "me",
      status: ["open", "in_progress"],
      dueRange: "today",
    },
    sort: { field: "priority", direction: "desc" },
  },
  {
    id: "builtin:my-overdue",
    source: "builtin",
    name: "Overdue",
    isPinned: false,
    filters: {
      assignee: "me",
      status: ["open", "in_progress"],
      dueRange: "overdue",
    },
    sort: { field: "dueAt", direction: "asc" },
  },
  {
    id: "builtin:my-high-priority",
    source: "builtin",
    name: "High priority",
    isPinned: false,
    filters: {
      assignee: "me",
      status: ["open", "in_progress"],
      priority: ["high", "urgent"],
    },
    sort: { field: "dueAt", direction: "asc" },
  },
  {
    id: "builtin:my-standalone",
    source: "builtin",
    name: "Standalone (no entity)",
    isPinned: false,
    filters: {
      assignee: "me",
      status: ["open", "in_progress"],
      relation: "standalone",
    },
    sort: { field: "dueAt", direction: "asc" },
  },
  {
    id: "builtin:my-completed-recent",
    source: "builtin",
    name: "Recently completed",
    isPinned: false,
    filters: { assignee: "me", status: ["completed"] },
    sort: { field: "dueAt", direction: "desc" },
  },
  // Team view — gated server-side by canViewOthersTasks; if the
  // current user doesn't have the perm, the page filters this entry
  // out of the picker.
  {
    id: "builtin:team-open",
    source: "builtin",
    name: "Team open tasks",
    isPinned: false,
    filters: {
      assignee: "any",
      status: ["open", "in_progress"],
    },
    sort: { field: "dueAt", direction: "asc" },
  },
];

export function findBuiltinTaskView(id: string): TaskViewDefinition | null {
  return BUILTIN_TASK_VIEWS.find((v) => v.id === id) ?? null;
}

// =============================================================================
// Saved-view CRUD — same shape as leads CRUD but scoped to entity_type='task'.
// =============================================================================

const taskFiltersSchema = z.object({
  assignee: z.string().optional(),
  status: z
    .array(z.enum(["open", "in_progress", "completed", "cancelled"]))
    .optional(),
  priority: z.array(z.enum(["low", "normal", "high", "urgent"])).optional(),
  relation: z.enum(["all", "standalone", "linked"]).optional(),
  relatedEntity: z
    .enum(["lead", "account", "contact", "opportunity"])
    .optional(),
  dueRange: z
    .enum(["overdue", "today", "this_week", "later", "none", "all"])
    .optional(),
  q: z.string().max(200).optional(),
});

const taskSortSchema = z.object({
  field: z.enum([
    "dueAt",
    "priority",
    "title",
    "assignee",
    "status",
    "createdAt",
  ]),
  direction: z.enum(["asc", "desc"]),
});

export const taskViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  isPinned: z.boolean().default(false),
  filters: taskFiltersSchema.default({}),
  sort: taskSortSchema.default({ field: "dueAt", direction: "asc" }),
});

export type TaskViewInput = z.infer<typeof taskViewSchema>;

export async function listSavedTaskViewsForUser(
  userId: string,
): Promise<TaskViewDefinition[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "task"),
      ),
    )
    .orderBy(desc(savedViews.isPinned), asc(savedViews.name));
  return rows.map(taskRowToDefinition);
}

export async function getSavedTaskView(
  userId: string,
  id: string,
): Promise<TaskViewDefinition | null> {
  const row = await db
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "task"),
      ),
    )
    .limit(1);
  return row[0] ? taskRowToDefinition(row[0]) : null;
}

export async function createSavedTaskView(
  userId: string,
  input: TaskViewInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(savedViews)
    .values({
      userId,
      entityType: "task",
      name: input.name,
      isPinned: input.isPinned,
      // `scope` stays at its default — the assignee filter in filters
      // is the per-task equivalent of leads' owner-scope.
      filters: input.filters as object,
      // `columns` is unused for tasks (table columns are fixed in
      // this iteration); persist an empty array.
      columns: [],
      sort: input.sort as object,
    })
    .returning({ id: savedViews.id });
  return { id: inserted[0]!.id };
}

export async function updateSavedTaskView(
  userId: string,
  id: string,
  expectedVersion: number,
  input: Partial<TaskViewInput>,
): Promise<{ id: string; version: number }> {
  // Build the SET object only with provided fields so a "rename only"
  // call doesn't clobber filters.
  const set: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.isPinned !== undefined) set.isPinned = input.isPinned;
  if (input.filters !== undefined) set.filters = input.filters;
  if (input.sort !== undefined) set.sort = input.sort;
  set.version = expectedVersion + 1;
  const rows = await db
    .update(savedViews)
    .set(set)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "task"),
        eq(savedViews.version, expectedVersion),
      ),
    )
    .returning({ id: savedViews.id, version: savedViews.version });
  expectAffected(rows, { table: savedViews, id, entityLabel: "task view" });
  return rows[0]!;
}

export async function deleteSavedTaskView(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(savedViews)
    .where(
      and(
        eq(savedViews.id, id),
        eq(savedViews.userId, userId),
        eq(savedViews.entityType, "task"),
      ),
    );
}

function taskRowToDefinition(
  row: typeof savedViews.$inferSelect,
): TaskViewDefinition {
  // Filters / sort are jsonb; cast trustingly because writes funnel
  // through the Zod-validated CRUD above. Caller code defensively
  // handles undefined / missing fields anyway.
  const filtersRaw = row.filters as TaskViewFilters | null;
  const sortRaw = row.sort as TaskViewSort | null;
  return {
    id: `saved:${row.id}`,
    source: "saved",
    name: row.name,
    isPinned: row.isPinned,
    filters: filtersRaw ?? {},
    sort: sortRaw ?? { field: "dueAt", direction: "asc" },
    version: row.version,
  };
}
