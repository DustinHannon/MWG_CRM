import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedViews, userPreferences } from "@/db/schema/views";
import { expectAffected } from "@/lib/db/concurrent-update";
import {
  DEFAULT_TASK_COLUMNS,
  TASK_COLUMN_KEYS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";

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
  /**
   * Filter to tasks bearing ANY of the given tag names (OR semantics).
   * Names are case-insensitive; matched against the `tags` table via
   * the `task_tags` junction.
   */
  tags?: string[];
}

export const TASK_SORT_FIELDS = [
  "dueAt",
  "priority",
  "title",
  "assignee",
  "status",
  "createdAt",
] as const;

export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export interface TaskViewSort {
  field: TaskSortField;
  direction: "asc" | "desc";
}

export interface TaskViewDefinition {
  id: string;
  source: "builtin" | "saved";
  name: string;
  isPinned: boolean;
  filters: TaskViewFilters;
  sort: TaskViewSort;
  /**
   * Visible columns for this view. Built-in views use the
   * DEFAULT_TASK_COLUMNS list; saved views persist their own choice.
   * The empty array sentinel on read is mapped to DEFAULT_TASK_COLUMNS
   * so a saved view created before column-chooser support still
   * renders sensibly.
   */
  columns: TaskColumnKey[];
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
    columns: DEFAULT_TASK_COLUMNS,
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
    columns: DEFAULT_TASK_COLUMNS,
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
    columns: DEFAULT_TASK_COLUMNS,
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
    columns: DEFAULT_TASK_COLUMNS,
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
    columns: DEFAULT_TASK_COLUMNS,
  },
  {
    id: "builtin:my-completed-recent",
    source: "builtin",
    name: "Recently completed",
    isPinned: false,
    filters: { assignee: "me", status: ["completed"] },
    sort: { field: "dueAt", direction: "desc" },
    columns: DEFAULT_TASK_COLUMNS,
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
    columns: DEFAULT_TASK_COLUMNS,
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
  // 50-char cap aligned with the tagName primitive.
  tags: z.array(z.string().max(50)).optional(),
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

const taskColumnsSchema = z
  .array(
    z.enum(TASK_COLUMN_KEYS as [TaskColumnKey, ...TaskColumnKey[]]),
  )
  .max(TASK_COLUMN_KEYS.length);

export const taskViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  isPinned: z.boolean().default(false),
  filters: taskFiltersSchema.default({}),
  sort: taskSortSchema.default({ field: "dueAt", direction: "asc" }),
  columns: taskColumnsSchema.default(DEFAULT_TASK_COLUMNS),
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
      // Persist the user's column visibility choice when saving the
      // view. Default to DEFAULT_TASK_COLUMNS when not supplied; the
      // reader maps the empty-array legacy sentinel to defaults too.
      columns: (input.columns ?? DEFAULT_TASK_COLUMNS) as object,
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
  if (input.columns !== undefined) set.columns = input.columns as object;
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
  const columnsRaw = row.columns as unknown;
  let columns: TaskColumnKey[] = DEFAULT_TASK_COLUMNS;
  if (Array.isArray(columnsRaw) && columnsRaw.length > 0) {
    const known = new Set<string>(TASK_COLUMN_KEYS);
    const filtered = columnsRaw.filter(
      (k): k is TaskColumnKey => typeof k === "string" && known.has(k),
    );
    if (filtered.length > 0) columns = filtered;
  }
  return {
    id: `saved:${row.id}`,
    source: "saved",
    name: row.name,
    isPinned: row.isPinned,
    filters: filtersRaw ?? {},
    sort: sortRaw ?? { field: "dueAt", direction: "asc" },
    columns,
    version: row.version,
  };
}

// =============================================================================
// Adhoc column persistence (built-in views) — mirrors contact-views.ts.
// =============================================================================

/**
 * Read the current user's task preferences. Returns the per-user
 * adhoc column override for the /tasks list — used when a built-in
 * view is active and the user has toggled the Tags column on (or
 * any other non-default column). Saved views carry their own
 * column array on the saved_views row instead.
 */
export async function getTaskPreferences(userId: string): Promise<{
  adhocColumns: TaskColumnKey[] | null;
}> {
  const row = await db
    .select({ adhoc: userPreferences.adhocColumns })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row[0]) {
    return { adhocColumns: null };
  }
  const adhoc = readAdhocTask(row[0].adhoc);
  return { adhocColumns: adhoc };
}

function readAdhocTask(raw: unknown): TaskColumnKey[] | null {
  // Per the contact-views pattern: the legacy bare-array form is
  // leads-only. Tasks reads from the per-entity object form.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).task;
  if (!Array.isArray(v)) return null;
  const known = new Set<string>(TASK_COLUMN_KEYS);
  const out = v.filter(
    (k): k is TaskColumnKey => typeof k === "string" && known.has(k),
  );
  return out.length > 0 ? out : null;
}

/**
 * Persist the user's adhoc column choice for /tasks. Pass `null` to
 * clear the override and revert to the active view's columns. The
 * read-merge-write keeps other entities' adhoc choices intact.
 */
export async function setTaskAdhocColumns(
  userId: string,
  columns: TaskColumnKey[] | null,
): Promise<void> {
  const [existing] = await db
    .select({ adhoc: userPreferences.adhocColumns })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const base = coerceAdhocMap(existing?.adhoc);
  if (columns === null) {
    delete base.task;
  } else {
    base.task = columns;
  }
  await db
    .insert(userPreferences)
    .values({
      userId,
      adhocColumns: base as object,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        adhocColumns: base as object,
        updatedAt: sql`now()`,
      },
    });
}

function coerceAdhocMap(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { lead: raw };
  if (raw && typeof raw === "object")
    return { ...(raw as Record<string, unknown>) };
  return {};
}
