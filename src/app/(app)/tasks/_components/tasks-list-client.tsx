"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import {
  BulkActionToolbar,
  BulkSelectionBanner,
  BulkSelectionProvider,
  useBulkSelection,
} from "@/components/bulk-selection";
import { BulkTagButton } from "@/components/tags/bulk-tag-button";
import { TagsCell } from "@/components/tags/tags-cell";
import { TagChip } from "@/components/tags/tag-chip";
import { UserChip } from "@/components/user-display/user-chip";
import { PriorityPill } from "@/components/ui/priority-pill";
import { StatusPill } from "@/components/ui/status-pill";
import { formatUserTime, type TimePrefs } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import type { TaskRow } from "@/lib/tasks";
import {
  AVAILABLE_TASK_COLUMNS,
  TASK_SORTABLE_COLUMNS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";
import type {
  TaskViewDefinition,
  TaskViewFilters,
  TaskViewSort,
} from "@/lib/task-views";
import { toggleTaskCompleteAction } from "../actions";
import {
  bulkCompleteTasksAction,
  bulkDeleteTasksAction,
  bulkReassignTasksAction,
} from "../view-actions";
import { TaskColumnsMenu } from "./task-columns-menu";
import { TaskEditDialog } from "./task-edit-dialog";
import { TaskViewSelector } from "./task-view-selector";

interface AvailableTag {
  id: string;
  name: string;
  color: string | null;
}

interface AssignableUser {
  id: string;
  displayName: string;
  email: string;
}

interface ActorLite {
  id: string;
  isAdmin: boolean;
}

export interface TasksListClientProps {
  user: ActorLite;
  timePrefs: TimePrefs;
  activeViewParam: string;
  activeViewName: string;
  activeView: TaskViewDefinition;
  activeColumns: TaskColumnKey[];
  baseColumns: TaskColumnKey[];
  builtinViews: TaskViewDefinition[];
  savedViews: TaskViewDefinition[];
  allTags: AvailableTag[];
  assignableUsers: AssignableUser[];
  canViewOthers: boolean;
  canReassign: boolean;
  canEditOthersTasks: boolean;
  canApplyTags: boolean;
  canManageTagDefinitions: boolean;
}

/**
 * Client filter shape held in React state. URL no longer round-trips
 * any of these — they live in client state and feed into the
 * StandardListPage query key. `sort` / `dir` / `cols` / `view` stay
 * URL-driven (the existing sortable headers + columns menu + view
 * selector navigate via URL).
 */
interface TaskFilters {
  q: string;
  assignee: string; // "" | "me" | "any" | userId
  status: string; // comma-separated
  priority: string; // comma-separated
  relation: string; // "" | "all" | "standalone" | "linked"
  related: string; // "" | "lead" | "account" | "contact" | "opportunity"
  due: string; // "" | "all" | "overdue" | "today" | "this_week" | "later" | "none"
  tag: string; // comma-separated tag names
}

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

const RELATION_OPTIONS = [
  { value: "all", label: "All" },
  { value: "standalone", label: "Standalone" },
  { value: "linked", label: "Linked to entity" },
] as const;

const RELATED_ENTITY_OPTIONS = [
  { value: "lead", label: "Lead" },
  { value: "account", label: "Account" },
  { value: "contact", label: "Contact" },
  { value: "opportunity", label: "Opportunity" },
] as const;

const DUE_OPTIONS = [
  { value: "all", label: "Any" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "later", label: "Later" },
  { value: "none", label: "No date" },
] as const;

/**
 * Build the initial client filter state from the active view + any
 * overlay URL params. The /tasks server shell pre-resolves the view
 * but not the URL overlays — the client owns those after mount.
 *
 * The previous /tasks page URL-form-submit pattern is deprecated;
 * existing URLs with these params are honored on first mount so
 * deep-linked filter URLs continue to work, but subsequent edits
 * round-trip through client state only.
 */
function deriveInitialFilters(
  activeView: TaskViewDefinition,
  sp: URLSearchParams,
): TaskFilters {
  const vf = activeView.filters;
  const csv = (s: string | null, fallback: string[] | undefined) =>
    s ? s : fallback?.join(",") ?? "";
  return {
    q: sp.get("q") ?? vf.q ?? "",
    assignee: sp.get("assignee") ?? vf.assignee ?? "",
    status: csv(sp.get("status"), vf.status),
    priority: csv(sp.get("priority"), vf.priority),
    relation: sp.get("relation") ?? vf.relation ?? "",
    related: sp.get("related") ?? vf.relatedEntity ?? "",
    due: sp.get("due") ?? vf.dueRange ?? "",
    tag: sp.get("tag") ?? vf.tags?.join(",") ?? "",
  };
}

/**
 * Tasks list — infinite-scroll client.
 *
 * Owns:
 *   - 8-dimension filter state (q, assignee, status, priority,
 *     relation, related, due, tag).
 *   - TanStack Query cache (via StandardListPage's infinite scroll).
 *   - Bulk selection state for bulk-tag via BulkSelectionProvider.
 *   - Per-row checkbox selection for the legacy bulk-action toolbar
 *     (Complete / Delete / Reassign) via internal `useState<Set>`.
 *     Distinct from BulkSelectionProvider — the legacy toolbar acts
 *     on explicit ids only and doesn't need the 4-state scope model
 *     because Complete / Delete / Reassign all require explicit
 *     enumeration server-side (no `bulkScope` path wired today).
 *
 * Saved-view + columns + view selection remain server- or URL-state
 * driven. The server-rendered shell passes `activeView`,
 * `activeColumns`, etc. as props; whenever the view changes via URL
 * (the TaskViewSelector pushes `/tasks?view=...`), Next.js re-renders
 * the server shell with new props. The outer `key={activeViewParam}`
 * on the parent forces a remount so filter state resets.
 *
 * Sort stays URL-driven (the existing sortable column headers emit
 * URL changes). The query key includes the URL's sort/dir so the
 * list resets when sort changes.
 */
export function TasksListClient(props: TasksListClientProps) {
  return (
    <BulkSelectionProvider>
      <TasksListInner {...props} />
    </BulkSelectionProvider>
  );
}

function TasksListInner({
  user,
  timePrefs,
  activeViewParam,
  activeViewName,
  activeView,
  activeColumns,
  baseColumns,
  builtinViews,
  savedViews,
  allTags,
  assignableUsers,
  canViewOthers,
  canReassign,
  canEditOthersTasks,
  canApplyTags,
  canManageTagDefinitions,
}: TasksListClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Sort + dir come from URL — read once on mount. URL changes via
  // the sortable header `Link` components trigger a router refresh
  // which feeds back through the server page, so we read from the
  // hook each render.
  const sortField = searchParams.get("sort");
  const sortDir = searchParams.get("dir");
  const sort: TaskViewSort = useMemo(() => {
    if (sortField && (sortDir === "asc" || sortDir === "desc")) {
      return {
        field: sortField as TaskViewSort["field"],
        direction: sortDir,
      };
    }
    return activeView.sort;
  }, [sortField, sortDir, activeView.sort]);

  const [filters, setFilters] = useState<TaskFilters>(() =>
    deriveInitialFilters(activeView, searchParams),
  );
  const [draft, setDraft] = useState<TaskFilters>(filters);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const { dispatch } = useBulkSelection();

  // Per-row selection set for the legacy bulk-action toolbar
  // (Complete / Delete / Reassign). Kept distinct from
  // BulkSelectionProvider because those bulk actions do not accept
  // a filtered scope — they require explicit ids.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>("");
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);

  const memoizedFilters = useMemo<TaskFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: TaskFilters,
      signal?: AbortSignal,
    ): Promise<StandardListPagePage<TaskRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("view", activeViewParam);
      params.set("cols", activeColumns.join(","));
      if (f.q) params.set("q", f.q);
      if (f.assignee) params.set("assignee", f.assignee);
      if (f.status) params.set("status", f.status);
      if (f.priority) params.set("priority", f.priority);
      if (f.relation) params.set("relation", f.relation);
      if (f.related) params.set("related", f.related);
      if (f.due) params.set("due", f.due);
      if (f.tag) params.set("tag", f.tag);
      // Sort/dir from URL — folded into the request so the API can
      // pick the right path (default => cursor; custom => offset-
      // style first page only, no cursor).
      if (sortField) params.set("sort", sortField);
      if (sortDir) params.set("dir", sortDir);
      const res = await fetch(`/api/tasks/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) {
        throw new Error(`Could not load tasks (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<TaskRow>;
    },
    [activeViewParam, activeColumns, sortField, sortDir],
  );

  // Wrapped fetchPage that tracks loaded IDs + syncs bulk-tag
  // selection counters so the toolbar shows accurate counts. Forwards
  // the AbortSignal so a stale in-flight request cancelled by
  // TanStack Query (filter / view / sort change) does NOT write into
  // setLoadedIds.
  const fetchPageInstrumented = useCallback(
    async (cursor: string | null, f: TaskFilters, signal?: AbortSignal) => {
      const page = await fetchPage(cursor, f, signal);
      if (cursor === null) {
        const ids = page.data.map((row) => row.id);
        setLoadedIds(ids);
        dispatch({
          type: "sync_load_state",
          loadedCount: ids.length,
          total: page.total,
        });
      } else {
        setLoadedIds((prev) => {
          const next = [...prev, ...page.data.map((row) => row.id)];
          dispatch({
            type: "sync_load_state",
            loadedCount: next.length,
            total: page.total,
          });
          return next;
        });
      }
      return page;
    },
    [fetchPage, dispatch],
  );

  function toggleRowSelection(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleComplete(task: TaskRow) {
    const next = task.status !== "completed";
    startTransition(async () => {
      const res = await toggleTaskCompleteAction(task.id, task.version, next);
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      } else {
        router.refresh();
      }
    });
  }

  function bulkComplete() {
    if (selected.size === 0) return;
    startTransition(async () => {
      const res = await bulkCompleteTasksAction({ ids: Array.from(selected) });
      if (res.ok) {
        toast.success(`Marked ${res.data.updated} task(s) complete`);
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function bulkDelete() {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Delete ${selected.size} task(s)? This soft-deletes them; the retention cron purges after 730 days.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await bulkDeleteTasksAction({ ids: Array.from(selected) });
      if (res.ok) {
        toast.success(`Deleted ${res.data.updated} task(s)`);
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function openReassign() {
    setReassignTo("");
    setReassignOpen(true);
  }

  function confirmReassign() {
    if (!reassignTo) {
      toast.error("Pick an assignee first.");
      return;
    }
    if (selected.size === 0) return;
    startTransition(async () => {
      const res = await bulkReassignTasksAction({
        ids: Array.from(selected),
        newAssigneeId: reassignTo,
      });
      if (res.ok) {
        toast.success(`Reassigned ${res.data.updated} task(s)`);
        setReassignOpen(false);
        setReassignTo("");
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  const applyDraft = () => {
    setFilters(draft);
    clearSelection();
    // BulkSelectionProvider's contract: clear the multi-scope selection
    // on filter change. `clearSelection()` above handles the per-row
    // legacy toolbar's Set; this clears the provider's scope so an
    // `all_loaded` / `all_matching` selection doesn't leak across
    // filter changes.
    dispatch({ type: "clear" });
  };
  const clearFilters = () => {
    const empty: TaskFilters = {
      q: "",
      assignee: "",
      status: "",
      priority: "",
      relation: "",
      related: "",
      due: "",
      tag: "",
    };
    setDraft(empty);
    setFilters(empty);
    clearSelection();
    dispatch({ type: "clear" });
  };

  const filtersAreModified = Boolean(
    filters.q ||
      filters.assignee ||
      filters.status ||
      filters.priority ||
      filters.relation ||
      filters.related ||
      filters.due ||
      filters.tag,
  );

  // MODIFIED badge detection — client-derived from columns + filters
  // + sort URL state.
  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);
  const sortModified = Boolean(sortField) || Boolean(sortDir);
  const viewModified = columnsModified || filtersAreModified || sortModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (filters.q) modifiedFields.push("search");
  if (
    filters.assignee ||
    filters.status ||
    filters.priority ||
    filters.relation ||
    filters.related ||
    filters.due ||
    filters.tag
  ) {
    modifiedFields.push("filters");
  }
  if (sortModified) modifiedFields.push("sort");

  // The "current filters" shape passed to TaskViewSelector for
  // Save-as-new. Translate the comma-separated CSV back to arrays
  // so the saved view matches the lib helper's shape.
  const currentFiltersForSave: TaskViewFilters = useMemo(
    () => ({
      ...(filters.assignee
        ? { assignee: filters.assignee as TaskViewFilters["assignee"] }
        : {}),
      ...(filters.status
        ? {
            status: filters.status
              .split(",")
              .filter(Boolean) as TaskViewFilters["status"],
          }
        : {}),
      ...(filters.priority
        ? {
            priority: filters.priority
              .split(",")
              .filter(Boolean) as TaskViewFilters["priority"],
          }
        : {}),
      ...(filters.relation
        ? { relation: filters.relation as TaskViewFilters["relation"] }
        : {}),
      ...(filters.related
        ? {
            relatedEntity: filters.related as TaskViewFilters["relatedEntity"],
          }
        : {}),
      ...(filters.due
        ? { dueRange: filters.due as TaskViewFilters["dueRange"] }
        : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.tag
        ? { tags: filters.tag.split(",").filter(Boolean) }
        : {}),
    }),
    [filters],
  );

  const renderRow = useCallback(
    (task: TaskRow) => (
      <TaskDesktopRow
        task={task}
        columns={activeColumns}
        prefs={timePrefs}
        sort={sort}
        viewerId={user.id}
        canEdit={
          canEditOthersTasks ||
          task.createdById === user.id ||
          task.assignedToId === user.id
        }
        isSelected={selected.has(task.id)}
        onToggleSelect={() => toggleRowSelection(task.id)}
        onToggleComplete={() => toggleComplete(task)}
        onEdit={() => setEditingTask(task)}
        disabled={pending}
      />
    ),
    // toggleComplete + toggleRowSelection + setEditingTask omitted —
    // they're stable closures over startTransition / setSelected /
    // setEditingTask which React guarantees stable across renders.
    // Including them would force a renderRow rebuild every render
    // since arrow-function identities are fresh each call. See
    // renderCard below for the same rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeColumns,
      timePrefs,
      sort,
      user.id,
      canEditOthersTasks,
      selected,
      pending,
    ],
  );

  const renderCard = useCallback(
    (task: TaskRow) => (
      <TaskMobileCard
        task={task}
        prefs={timePrefs}
        viewerId={user.id}
        onToggleComplete={() => toggleComplete(task)}
        disabled={pending}
      />
    ),
    // toggleComplete uses startTransition (stable) + the action import
    // + router.refresh() — all stable for the lifetime of the
    // component. Including it here would force a renderCard rebuild
    // every render because toggleComplete is a fresh function
    // identity each call. The lint rule is silenced via
    // eslint-disable-next-line; the dependency intent is documented.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timePrefs, user.id, pending],
  );

  const headerActions = (
    <>
      <div className="hidden md:inline-flex">
        <TaskColumnsMenu
          activeColumns={activeColumns}
          activeViewId={activeView.id}
          baseColumns={baseColumns}
        />
      </div>
      <div className="hidden md:inline-flex">
        <BulkTagToolbarButton
          loadedIds={loadedIds}
          availableTags={allTags}
          canApply={canApplyTags}
          filters={filters}
          activeViewParam={activeViewParam}
        />
      </div>
      {user.isAdmin ? (
        <Link
          href="/tasks/archived"
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 whitespace-nowrap transition hover:bg-muted md:inline-flex"
        >
          Archived
        </Link>
      ) : null}
    </>
  );

  const filtersSlot = (
    <div className="space-y-3">
      {/* View selector + MODIFIED badge + Save-as-new + Delete.
          Desktop-only — these are power-user affordances that don't
          fit the mobile chip toolbar. Lives inside the client
          component so the MODIFIED badge can react to client filter
          state. */}
      <div className="hidden md:block">
        <TaskViewSelector
          activeViewId={activeView.id}
          activeViewName={activeViewName}
          builtinViews={builtinViews}
          savedViews={savedViews}
          currentFilters={currentFiltersForSave}
          currentSort={sort}
          currentColumns={activeColumns}
          viewModified={viewModified}
          modifiedFields={modifiedFields}
          resetClientState={clearFilters}
        />
      </div>

      {/* Per-row bulk-action toolbar (Complete / Delete / Reassign).
          Renders when ≥1 row checked via the per-row checkbox.
          Distinct from the BulkSelectionBanner / BulkActionToolbar
          which drive the bulk-tag affordance. */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
          <span className="font-medium text-primary">
            {selected.size} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={bulkComplete}
              disabled={pending}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
            >
              Complete
            </button>
            <button
              type="button"
              onClick={bulkDelete}
              disabled={pending}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
            >
              Delete
            </button>
            {canReassign && assignableUsers.length > 0 ? (
              <button
                type="button"
                onClick={openReassign}
                disabled={pending}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
              >
                Reassign…
              </button>
            ) : null}
            <button
              type="button"
              onClick={clearSelection}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <TaskFiltersBar
        draft={draft}
        onDraftChange={setDraft}
        onApply={applyDraft}
        onClear={clearFilters}
        onMobileImmediate={(next) => {
          setDraft(next);
          setFilters(next);
          clearSelection();
          dispatch({ type: "clear" });
        }}
        allTags={allTags}
        canViewOthers={canViewOthers}
        hasActiveFilters={filtersAreModified}
      />

      {/* Desktop column headers — sortable via URL nav. Renders as
          a `<thead>` inside a `<table>` wrapper so the header row
          aligns with the per-row layout below. Leading checkbox
          column + trailing edit-button column kept at fixed width. */}
      <div className="hidden overflow-x-auto rounded-t-lg border border-b-0 border-border bg-muted/40 md:block">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-2 py-3" aria-label="select" />
              <th className="w-8 px-2 py-3" aria-label="complete" />
              {activeColumns.map((key) => {
                const sortable = TASK_SORTABLE_COLUMNS.has(key);
                const label =
                  AVAILABLE_TASK_COLUMNS.find((c) => c.key === key)?.label ??
                  key;
                return (
                  <th
                    key={key}
                    className="flex-1 px-5 py-3 font-medium whitespace-nowrap"
                  >
                    {sortable ? (
                      <SortableHeaderLink
                        field={key}
                        label={label}
                        sort={sort}
                      />
                    ) : (
                      <span>{label}</span>
                    )}
                  </th>
                );
              })}
              <th className="w-16 px-2 py-3" aria-label="actions" />
            </tr>
          </thead>
        </table>
      </div>
    </div>
  );

  return (
    <>
      <StandardListPage<TaskRow, TaskFilters>
        queryKey={[
          "tasks",
          activeViewParam,
          activeColumns.join(","),
          sortField ?? "",
          sortDir ?? "",
        ]}
        fetchPage={fetchPageInstrumented}
        filters={memoizedFilters}
        renderRow={renderRow}
        renderCard={renderCard}
        rowEstimateSize={56}
        cardEstimateSize={96}
        emptyState={
          <StandardEmptyState
            title="No tasks match this view."
            description={
              filtersAreModified
                ? "Adjust or clear the filters to see records here."
                : undefined
            }
          />
        }
        header={{
          title: "Tasks",
          fontFamily: "display",
          actions: headerActions,
        }}
        filtersSlot={filtersSlot}
        bulkActions={{
          banner: <BulkSelectionBanner />,
          toolbar: (
            <BulkActionToolbar>
              <BulkTagToolbarButton
                loadedIds={loadedIds}
                availableTags={allTags}
                canApply={canApplyTags}
                filters={filters}
                activeViewParam={activeViewParam}
              />
            </BulkActionToolbar>
          ),
        }}
      />

      {editingTask ? (
        <TaskEditDialog
          task={editingTask}
          assignableUsers={assignableUsers}
          canReassign={canReassign}
          canApplyTags={canApplyTags}
          canManageTagDefinitions={canManageTagDefinitions}
          onClose={() => setEditingTask(null)}
          onSaved={() => {
            setEditingTask(null);
            router.refresh();
          }}
        />
      ) : null}

      {/* bulk-reassign modal — inline dialog
          (no Radix). Backed by bulkReassignTasksAction; the server
          gate-checks canReassignTasks before the UPDATE fires. */}
      {reassignOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reassign selected tasks"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Reassign {selected.size} task{selected.size === 1 ? "" : "s"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The new assignee will receive the task; this emits a
              `task.reassigned` audit per task. Notifications follow
              the recipient&apos;s preferences.
            </p>
            <label className="mt-4 block text-xs uppercase tracking-wide text-muted-foreground">
              Assign to
            </label>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              disabled={pending}
              className="mt-1 h-9 w-full rounded-md border border-border bg-input/60 px-2 text-sm"
            >
              <option value="">— select user —</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.email})
                </option>
              ))}
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReassignOpen(false)}
                disabled={pending}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReassign}
                disabled={pending || !reassignTo}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Reassigning…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Toolbar surface for the bulk-tag affordance. Reads the current
 * selection scope from BulkSelectionProvider and translates it into
 * the BulkScope shape that `bulkTagAction` accepts.
 */
function BulkTagToolbarButton({
  loadedIds,
  availableTags,
  canApply,
  filters,
  activeViewParam,
}: {
  loadedIds: string[];
  availableTags: AvailableTag[];
  canApply: boolean;
  filters: TaskFilters;
  activeViewParam: string;
}) {
  const { scope } = useBulkSelection();

  const bulkScope = useMemo(() => {
    if (scope.kind === "none") {
      return { kind: "ids" as const, ids: [] };
    }
    if (scope.kind === "individual") {
      return { kind: "ids" as const, ids: Array.from(scope.ids) };
    }
    if (scope.kind === "all_loaded") {
      return { kind: "ids" as const, ids: loadedIds };
    }
    // all_matching
    return {
      kind: "filtered" as const,
      entity: "task" as const,
      filters: { ...filters, view: activeViewParam },
    };
  }, [scope, loadedIds, filters, activeViewParam]);

  return (
    <BulkTagButton
      entityType="task"
      scope={bulkScope}
      availableTags={availableTags}
      canApply={canApply}
    />
  );
}

/**
 * Desktop row. Flex layout matching the column-header layout above.
 * Each column is a flex-1 cell so widths align with the header.
 * Leading selection-checkbox + complete-toggle cells + trailing
 * edit-button cell stay fixed-width.
 */
function TaskDesktopRow({
  task,
  columns,
  prefs,
  sort: _sort,
  viewerId,
  canEdit,
  isSelected,
  onToggleSelect,
  onToggleComplete,
  onEdit,
  disabled,
}: {
  task: TaskRow;
  columns: TaskColumnKey[];
  prefs: TimePrefs;
  sort: TaskViewSort;
  viewerId: string;
  canEdit: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleComplete: () => void;
  onEdit: () => void;
  disabled: boolean;
}) {
  const overdue =
    task.dueAt !== null &&
    task.dueAt < new Date() &&
    task.status !== "completed";
  const isCompleted = task.status === "completed";
  return (
    <div
      className={cn(
        "group flex items-stretch border-b border-border/60 text-sm transition",
        isSelected
          ? "bg-primary/5"
          : isCompleted
            ? "bg-card opacity-60"
            : "bg-card hover:bg-muted/40",
      )}
      data-row-flash="new"
    >
      <div className="flex w-10 shrink-0 items-center justify-center px-2 py-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          disabled={disabled}
          aria-label={`Select ${task.title}`}
          className="h-4 w-4 cursor-pointer"
        />
      </div>
      <div className="flex w-8 shrink-0 items-center justify-center px-2 py-3">
        <input
          type="checkbox"
          checked={isCompleted}
          onChange={onToggleComplete}
          disabled={disabled}
          aria-label={`Mark ${task.title} ${isCompleted ? "open" : "complete"}`}
          className="h-4 w-4 cursor-pointer"
        />
      </div>
      {columns.map((c) => {
        const colLabel =
          AVAILABLE_TASK_COLUMNS.find((col) => col.key === c)?.label ?? c;
        return (
          <div
            key={c}
            data-label={colLabel}
            className={cn(
              "min-w-0 flex-1 truncate px-5 py-3",
              c === "title" && isCompleted ? "line-through" : undefined,
            )}
          >
            {renderTaskCell(task, c, { viewerId, prefs, overdue })}
          </div>
        );
      })}
      <div className="flex w-16 shrink-0 items-center justify-end px-2 py-3">
        {canEdit ? (
          <button
            type="button"
            onClick={onEdit}
            disabled={disabled}
            aria-label={`Edit ${task.title}`}
            className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            Edit
          </button>
        ) : (
          <span
            aria-hidden
            className="inline-block rounded-md border border-transparent px-2 py-1 text-[11px] opacity-0"
          >
            Edit
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Mobile card for one task. Compact layout: title + status pill +
 * due-date strip + priority pill. Tap toggles complete via the
 * checkbox; long-tap / expand is deferred (the user can switch to
 * desktop for the edit dialog).
 */
function TaskMobileCard({
  task,
  prefs,
  viewerId,
  onToggleComplete,
  disabled,
}: {
  task: TaskRow;
  prefs: TimePrefs;
  viewerId: string;
  onToggleComplete: () => void;
  disabled: boolean;
}) {
  const overdue =
    task.dueAt !== null &&
    task.dueAt < new Date() &&
    task.status !== "completed";
  const isCompleted = task.status === "completed";
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-border/60 bg-card p-3 text-sm",
        isCompleted ? "opacity-60" : undefined,
      )}
      data-row-flash="new"
    >
      <input
        type="checkbox"
        checked={isCompleted}
        onChange={onToggleComplete}
        disabled={disabled}
        aria-label={`Mark ${task.title} ${isCompleted ? "open" : "complete"}`}
        className="mt-1 h-4 w-4 cursor-pointer"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={cn(
            "text-sm font-medium text-foreground",
            isCompleted ? "line-through" : undefined,
          )}
        >
          {task.title}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {task.dueAt ? (
            <span className={overdue ? "text-destructive font-medium" : ""}>
              {formatUserTime(task.dueAt, prefs, "date")}
              {overdue ? " · overdue" : ""}
            </span>
          ) : null}
          {task.priority !== "normal" ? (
            <PriorityPill priority={task.priority} />
          ) : null}
          {task.status !== "open" ? (
            <StatusPill status={task.status} />
          ) : null}
          {task.assignedToId && task.assignedToId !== viewerId ? (
            <UserChip
              user={{
                id: task.assignedToId,
                displayName: task.assignedToName,
                photoUrl: null,
              }}
            />
          ) : null}
        </div>
        {task.tags && task.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {task.tags.map((t) => (
              <TagChip key={t.id} name={t.name} color={t.color ?? "slate"} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Sortable column header — emits a URL change to `?sort=field&dir=…`
 * via Link. The page re-renders, the searchParams hook re-reads,
 * and the query key changes (since sort/dir are folded into it),
 * which resets the list to top.
 */
function SortableHeaderLink({
  field,
  label,
  sort,
}: {
  field: TaskColumnKey;
  label: string;
  sort: TaskViewSort;
}) {
  const direction =
    sort.field === (field as TaskViewSort["field"]) && sort.direction === "asc"
      ? "desc"
      : "asc";
  // Preserve any other URL params alongside the new sort/dir.
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  params.set("sort", field);
  params.set("dir", direction);
  const href = `?${params.toString()}`;
  return (
    <Link
      href={href}
      scroll={false}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {label}
      <SortIndicator
        active={sort.field === (field as TaskViewSort["field"])}
        direction={sort.direction}
      />
    </Link>
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: "asc" | "desc";
}) {
  if (!active) return <span className="opacity-30">↕</span>;
  return <span>{direction === "asc" ? "↑" : "↓"}</span>;
}

/**
 * Render one cell body for a given column key. Centralised so the
 * column-chooser system can swap columns without touching the row
 * template.
 */
function renderTaskCell(
  task: TaskRow,
  key: TaskColumnKey,
  ctx: { viewerId: string; prefs: TimePrefs; overdue: boolean },
) {
  switch (key) {
    case "title":
      return (
        <>
          <span className="font-medium text-sm">{task.title}</span>
          {task.description ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {task.description.length > 80
                ? task.description.slice(0, 80) + "…"
                : task.description}
            </span>
          ) : null}
        </>
      );
    case "related":
      return <RelatedTo task={task} />;
    case "dueAt":
      return task.dueAt ? (
        <span
          className={ctx.overdue ? "text-destructive font-medium" : undefined}
        >
          {formatUserTime(task.dueAt, ctx.prefs, "date")}
          {ctx.overdue ? " · overdue" : ""}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "priority":
      return <PriorityPill priority={task.priority} />;
    case "assignee":
      return task.assignedToId ? (
        task.assignedToId === ctx.viewerId ? (
          <span className="text-muted-foreground">You</span>
        ) : (
          <UserChip
            user={{
              id: task.assignedToId,
              displayName: task.assignedToName,
              photoUrl: null,
            }}
          />
        )
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "status":
      return <StatusPill status={task.status} />;
    case "tags":
      return <TagsCell tags={task.tags} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(task.createdAt, ctx.prefs, "date")}
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(task.updatedAt, ctx.prefs, "date")}
        </span>
      );
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

function RelatedTo({ task }: { task: TaskRow }) {
  if (task.leadId && task.leadName) {
    return (
      <Link
        href={`/leads/${task.leadId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Lead
        </span>
        {task.leadName}
      </Link>
    );
  }
  if (task.accountId && task.accountName) {
    return (
      <Link
        href={`/accounts/${task.accountId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Account
        </span>
        {task.accountName}
      </Link>
    );
  }
  if (task.contactId && task.contactName) {
    return (
      <Link
        href={`/contacts/${task.contactId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Contact
        </span>
        {task.contactName}
      </Link>
    );
  }
  if (task.opportunityId && task.opportunityName) {
    return (
      <Link
        href={`/opportunities/${task.opportunityId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Opportunity
        </span>
        {task.opportunityName}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Filter bar with desktop form-submit layout + mobile chip-row
 * variant. Mirrors the opportunities/contacts pattern: desktop uses
 * Apply + Clear; mobile uses chip selects with immediate apply.
 */
function TaskFiltersBar({
  draft,
  onDraftChange,
  onApply,
  onClear,
  onMobileImmediate,
  allTags,
  canViewOthers,
  hasActiveFilters,
}: {
  draft: TaskFilters;
  onDraftChange: (next: TaskFilters) => void;
  onApply: () => void;
  onClear: () => void;
  onMobileImmediate: (next: TaskFilters) => void;
  allTags: AvailableTag[];
  canViewOthers: boolean;
  hasActiveFilters: boolean;
}) {
  const setField = <K extends keyof TaskFilters>(
    key: K,
    value: TaskFilters[K],
  ) => onDraftChange({ ...draft, [key]: value });

  const assigneeOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: "me", label: "Me" },
    ...(canViewOthers ? [{ value: "any", label: "Anyone" }] : []),
  ];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
      className="sticky top-0 z-30 -mx-4 space-y-2 border-b border-border/40 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6 md:static md:z-auto md:mx-0 md:space-y-0 md:border-0 md:bg-transparent md:px-0 md:pt-0 md:pb-0 md:backdrop-blur-none"
    >
      {/* Mobile search input on its own row. */}
      <div className="md:hidden">
        <label className="relative block">
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx={9} cy={9} r={6} />
            <path d="m17 17-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={draft.q}
            onChange={(e) => setField("q", e.target.value)}
            onBlur={onApply}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApply();
              }
            }}
            placeholder="Search task title…"
            className="block h-11 w-full rounded-full border border-border bg-muted/40 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </div>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0">
        {/* Desktop search input. */}
        <input
          type="search"
          value={draft.q}
          onChange={(e) => setField("q", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onApply();
            }
          }}
          placeholder="Search task title…"
          className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[200px]"
        />

        {/* Mobile chip-style selects (auto-apply). Comma-separated
            multi-select chips for status / priority are flattened to
            single-select on mobile to fit the chip row. Desktop has
            the full multi-select via the form. */}
        <div className="contents md:hidden">
          <ControlledMobileSelect
            value={draft.assignee}
            onChange={(v) => onMobileImmediate({ ...draft, assignee: v })}
            options={assigneeOptions}
            placeholder="Assignee"
          />
          <ControlledMobileSelect
            value={draft.due}
            onChange={(v) => onMobileImmediate({ ...draft, due: v })}
            options={DUE_OPTIONS}
            placeholder="Due"
          />
          <ControlledMobileSelect
            value={draft.relation}
            onChange={(v) => onMobileImmediate({ ...draft, relation: v })}
            options={RELATION_OPTIONS}
            placeholder="Related"
          />
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/90"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Desktop selects + Apply. */}
        <div className="hidden items-center gap-2 md:flex md:gap-3 md:flex-wrap">
          <ControlledFilterSelect
            value={draft.assignee}
            onChange={(v) => setField("assignee", v)}
            options={assigneeOptions}
            placeholder="Assignee"
          />
          <ControlledMultiSelect
            value={draft.status}
            options={STATUS_OPTIONS}
            onChange={(v) => setField("status", v)}
            placeholder="Status"
          />
          <ControlledMultiSelect
            value={draft.priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => setField("priority", v)}
            placeholder="Priority"
          />
          <ControlledFilterSelect
            value={draft.relation}
            onChange={(v) => setField("relation", v)}
            options={RELATION_OPTIONS}
            placeholder="Relation"
          />
          <ControlledFilterSelect
            value={draft.related}
            onChange={(v) => setField("related", v)}
            options={RELATED_ENTITY_OPTIONS}
            placeholder="Entity"
          />
          <ControlledFilterSelect
            value={draft.due}
            onChange={(v) => setField("due", v)}
            options={DUE_OPTIONS}
            placeholder="Due"
          />
          <ControlledTagFilter
            value={draft.tag}
            options={allTags}
            onChange={(v) => setField("tag", v)}
          />
          <button
            type="submit"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Apply
          </button>
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground/90"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function ControlledFilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ControlledMobileSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  const isSet = value.length > 0;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 min-w-0 shrink-0 appearance-none rounded-full border px-3 pr-7 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-ring/40",
        isSet
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor'><path d='M5.516 7.548c.436-.446 1.043-.481 1.527 0L10 10.5l2.957-2.952c.483-.481 1.091-.446 1.527 0 .437.445.418 1.196 0 1.625-.418.43-4.5 4.5-4.5 4.5a1.063 1.063 0 0 1-1.498 0s-4.083-4.07-4.5-4.5c-.418-.43-.436-1.18 0-1.625Z'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.5rem center",
        backgroundSize: "1rem",
      }}
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Controlled multi-select. Emits a comma-separated string so the
 * value round-trips through TaskFilters' string-keyed shape.
 */
function ControlledMultiSelect({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => value.split(",").map((s) => s.trim()).filter(Boolean),
    [value],
  );

  function toggle(opt: string) {
    const next = selected.includes(opt)
      ? selected.filter((s) => s !== opt)
      : [...selected, opt];
    onChange(next.join(","));
  }

  const buttonLabel =
    selected.length === 0
      ? `All ${placeholder}`
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
        : `${placeholder}: ${selected.length}`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 hover:bg-muted"
      >
        {buttonLabel}
      </button>
      {open ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="listbox"
            className="absolute right-0 z-50 mt-1 w-44 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          >
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                  className="h-4 w-4"
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Controlled multi-tag filter. Local-only because the catalogue
 * picker (`TagFilterSelect`) is uncontrolled. Functionally identical
 * to the opportunities/contacts ControlledTagFilter.
 */
function ControlledTagFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: AvailableTag[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () =>
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [value],
  );

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((n) => n !== name)
      : [...selected, name];
    onChange(next.join(","));
  };

  const clearAll = () => onChange("");

  const buttonLabel =
    selected.length === 0
      ? "All Tags"
      : selected.length === 1
        ? selected[0]
        : `Tags: ${selected.length}`;

  return (
    <div className="relative">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm transition hover:bg-muted",
          selected.length > 0 ? "text-foreground" : "text-foreground/80",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="inline-flex items-center gap-1 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{buttonLabel}</span>
        </button>
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clearAll();
            }}
            aria-label="Clear tag filter"
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="listbox"
            className="absolute right-0 z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          >
            {options.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                No tags yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {options.map((t) => {
                  const isPicked = selected.includes(t.name);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggle(t.name)}
                      aria-pressed={isPicked}
                      className={cn(
                        "rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isPicked
                          ? "opacity-100 ring-2 ring-ring"
                          : "opacity-60 hover:opacity-90",
                      )}
                    >
                      <TagChip name={t.name} color={t.color ?? "slate"} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
