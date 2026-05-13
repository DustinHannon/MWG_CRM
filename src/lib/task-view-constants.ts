// Plain constants for the Tasks saved-view system. Safe to import
// from client components — no DB imports. Mirrors `contact-view-constants.ts`
// but with task-specific columns.

export const AVAILABLE_TASK_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "related", label: "Related to" },
  { key: "dueAt", label: "Due" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "status", label: "Status" },
  { key: "tags", label: "Tags" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" },
] as const;

export type TaskColumnKey = (typeof AVAILABLE_TASK_COLUMNS)[number]["key"];

export const TASK_COLUMN_KEYS: TaskColumnKey[] =
  AVAILABLE_TASK_COLUMNS.map((c) => c.key);

export const DEFAULT_TASK_COLUMNS: TaskColumnKey[] = [
  "title",
  "related",
  "dueAt",
  "priority",
  "assignee",
  "status",
];

/**
 * Sortable subset of task columns. Used by the header link logic to
 * decide whether a column header is a clickable sort link or a plain
 * label. Mirrors the legacy hard-coded list in task-table-client.
 */
export const TASK_SORTABLE_COLUMNS: ReadonlySet<TaskColumnKey> = new Set([
  "title",
  "dueAt",
  "priority",
  "assignee",
  "status",
  "createdAt",
  "updatedAt",
]);
