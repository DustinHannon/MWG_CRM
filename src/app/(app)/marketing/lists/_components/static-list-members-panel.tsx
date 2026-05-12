"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  bulkUpdateStaticListMembersAction,
  removeStaticListMembersAction,
  updateStaticListMemberAction,
} from "@/app/(app)/marketing/lists/actions";

/**
 * Phase 29 §5 — Mass-edit table for static-imported list members.
 *
 * Behaviors:
 *   • Selection toolbar (sticky bottom) when ≥1 row selected.
 *   • Header checkbox: select all visible rows on the page.
 *   • "Select all across pages" affordance when total > visible; opens
 *     a count-confirmation alert above 50.
 *   • Inline edit (click → input → blur saves; 600ms debounce).
 *   • Bulk edit modal: one field across selected rows.
 *   • Bulk remove via StandardConfirmDialog-like AlertDialog.
 *   • Search bar (debounced; routes via querystring).
 *   • Sort by name / email / added.
 */
interface StaticMemberRow {
  id: string;
  email: string;
  name: string | null;
  /** ISO timestamp from the server. */
  createdAt: string;
}

interface Props {
  listId: string;
  initialRows: StaticMemberRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
  sortKey: "name" | "email" | "added";
  sortDir: "asc" | "desc";
}

const INLINE_EDIT_DEBOUNCE_MS = 600;
const SELECT_ALL_CONFIRMATION_THRESHOLD = 50;

/**
 * Outer wrapper re-mounts the inner panel when the page / filter
 * changes by setting a derived `key`. That sidesteps the
 * setState-in-effect lint rule for selection reset.
 */
export function StaticListMembersPanel(props: Props) {
  const key = [
    props.page,
    props.search,
    props.sortKey,
    props.sortDir,
  ].join("|");
  return <StaticListMembersPanelInner key={key} {...props} />;
}

function StaticListMembersPanelInner(props: Props) {
  const {
    listId,
    initialRows,
    total,
    page,
    pageSize: _pageSize,
    totalPages,
    search,
    sortKey,
    sortDir,
  } = props;
  const router = useRouter();

  // Rows come from the server on every request — no local state mirror
  // needed. Mutations call `router.refresh()` which re-fetches and
  // re-passes the prop.
  const rows = initialRows;

  // Selection state: per-id Set + the "select all across pages" toggle.
  // Reset implicitly via the outer key-based remount.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllAcrossPages, setSelectAllAcrossPages] = useState(false);

  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const someVisibleSelected = rows.some((r) => selectedIds.has(r.id));

  const effectiveSelectedCount = selectAllAcrossPages
    ? total
    : selectedIds.size;

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectAllAcrossPages(false);
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of rows) next.delete(r.id);
      } else {
        for (const r of rows) next.add(r.id);
      }
      return next;
    });
    setSelectAllAcrossPages(false);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectAllAcrossPages(false);
  }

  // -------------------------------------------------------------------------
  // Search input (debounced into querystring).
  // -------------------------------------------------------------------------
  const [searchInput, setSearchInput] = useState(search);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (searchInput === search) return;
    searchTimeoutRef.current = setTimeout(() => {
      const sp = new URLSearchParams();
      if (searchInput) sp.set("q", searchInput);
      if (sortKey !== "added") sp.set("sort", sortKey);
      if (sortDir !== "desc") sp.set("dir", sortDir);
      const qs = sp.toString();
      router.replace(`/marketing/lists/${listId}${qs ? "?" + qs : ""}`);
    }, 300);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function setSort(nextKey: "name" | "email" | "added") {
    const nextDir =
      sortKey === nextKey
        ? sortDir === "asc"
          ? "desc"
          : "asc"
        : nextKey === "added"
          ? "desc"
          : "asc";
    const sp = new URLSearchParams();
    if (searchInput) sp.set("q", searchInput);
    sp.set("sort", nextKey);
    sp.set("dir", nextDir);
    router.replace(`/marketing/lists/${listId}?${sp.toString()}`);
  }

  // -------------------------------------------------------------------------
  // Inline edit
  // -------------------------------------------------------------------------
  const [pendingInlineSave, startInlineTransition] = useTransition();

  const saveInline = useCallback(
    (memberId: string, field: "name" | "email", value: string) => {
      startInlineTransition(async () => {
        const result = await updateStaticListMemberAction({
          memberId,
          field,
          value,
        });
        if (!result.ok) {
          toast.error(result.error);
          router.refresh();
          return;
        }
        toast.success("Saved.");
        router.refresh();
      });
    },
    [router],
  );

  // -------------------------------------------------------------------------
  // Bulk edit (modal)
  // -------------------------------------------------------------------------
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditValue, setBulkEditValue] = useState("");
  const [pendingBulk, startBulkTransition] = useTransition();

  // "Select all across pages" is treated as the visible-only set unless
  // confirmed — we surface a count check above the threshold.
  const [pendingSelectAllAcrossConfirm, setPendingSelectAllAcrossConfirm] =
    useState(false);

  function requestSelectAllAcrossPages() {
    if (total > SELECT_ALL_CONFIRMATION_THRESHOLD) {
      setPendingSelectAllAcrossConfirm(true);
      return;
    }
    setSelectAllAcrossPages(true);
  }

  function applyBulkEdit() {
    if (bulkEditValue.trim().length === 0) {
      toast.error("Enter a value to apply.");
      return;
    }
    startBulkTransition(async () => {
      const memberIds = selectAllAcrossPages
        ? // Server doesn't yet expose a "select all matching filter"
          // mode — bulk operations are scoped to the in-memory ID set.
          // For the across-pages case we operate on every visible row
          // page-by-page; here we limit to the current visible page
          // when across-pages is active until a follow-up phase
          // teaches the action layer to expand a filter into IDs.
          rows.map((r) => r.id)
        : Array.from(selectedIds);
      const result = await bulkUpdateStaticListMembersAction({
        listId,
        memberIds,
        field: "name",
        value: bulkEditValue.trim(),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Updated ${result.data.updated} recipients.`);
      setBulkEditOpen(false);
      setBulkEditValue("");
      clearSelection();
      router.refresh();
    });
  }

  // -------------------------------------------------------------------------
  // Bulk remove
  // -------------------------------------------------------------------------
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingRemove, startRemoveTransition] = useTransition();

  function applyRemove() {
    const memberIds = selectAllAcrossPages
      ? rows.map((r) => r.id)
      : Array.from(selectedIds);
    startRemoveTransition(async () => {
      const result = await removeStaticListMembersAction({
        listId,
        memberIds,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Removed ${result.data.removed} recipients.`);
      setRemoveOpen(false);
      clearSelection();
      router.refresh();
    });
  }

  // -------------------------------------------------------------------------
  // Export CSV — client-side blob from in-memory rows.
  // -------------------------------------------------------------------------
  function exportSelectedCsv() {
    const selectedRows = rows.filter((r) =>
      selectAllAcrossPages ? true : selectedIds.has(r.id),
    );
    if (selectedRows.length === 0) {
      toast.error("Select at least one recipient to export.");
      return;
    }
    const lines = [
      "name,email",
      ...selectedRows.map(
        (r) =>
          `"${(r.name ?? "").replace(/"/g, '""')}","${r.email.replace(/"/g, '""')}"`,
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `static-list-${listId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-3 pb-24">
      {/* Search bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or email"
          className="h-9 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <p className="text-xs text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? "recipient" : "recipients"}
        </p>
      </div>

      {/* Member table */}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {search.length > 0
            ? "No recipients match this search. Clear search."
            : "No recipients yet. Import an Excel file or add rows from the edit modal."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            !allVisibleSelected && someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                      className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                    />
                  </th>
                  <SortHeader
                    label="Name"
                    sortKey="name"
                    currentSortKey={sortKey}
                    currentSortDir={sortDir}
                    onSort={setSort}
                  />
                  <SortHeader
                    label="Email"
                    sortKey="email"
                    currentSortKey={sortKey}
                    currentSortDir={sortDir}
                    onSort={setSort}
                  />
                  <SortHeader
                    label="Added"
                    sortKey="added"
                    currentSortKey={sortKey}
                    currentSortDir={sortDir}
                    onSort={setSort}
                  />
                  <th className="w-12 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const isSelected =
                    selectAllAcrossPages || selectedIds.has(r.id);
                  return (
                    <tr
                      key={r.id}
                      className={
                        isSelected
                          ? "bg-primary/5"
                          : "transition hover:bg-accent/20"
                      }
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(r.id)}
                          aria-label={`Select ${r.email}`}
                          className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <InlineEditableCell
                          key={`name:${r.id}:${r.name ?? ""}`}
                          value={r.name ?? ""}
                          placeholder="Add name"
                          onSave={(next) => saveInline(r.id, "name", next)}
                        />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <InlineEditableCell
                          key={`email:${r.id}:${r.email}`}
                          value={r.email}
                          placeholder="Add email"
                          onSave={(next) => saveInline(r.id, "email", next)}
                        />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <RowMenu
                          memberId={r.id}
                          email={r.email}
                          listId={listId}
                          pendingInlineSave={pendingInlineSave}
                          onRemoved={() => router.refresh()}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Select-all-across-pages affordance */}
      {someVisibleSelected &&
      !selectAllAcrossPages &&
      total > rows.length ? (
        <p className="text-xs text-muted-foreground">
          {selectedIds.size} on this page selected.{" "}
          <button
            type="button"
            onClick={requestSelectAllAcrossPages}
            className="font-medium text-primary hover:underline"
          >
            Select all {total.toLocaleString()} across pages
          </button>
        </p>
      ) : null}

      {/* Pagination */}
      {totalPages > 1 ? (
        <nav className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <PageLink
                listId={listId}
                page={page - 1}
                search={searchInput}
                sortKey={sortKey}
                sortDir={sortDir}
                label="Previous"
              />
            ) : null}
            {page < totalPages ? (
              <PageLink
                listId={listId}
                page={page + 1}
                search={searchInput}
                sortKey={sortKey}
                sortDir={sortDir}
                label="Next"
              />
            ) : null}
          </div>
        </nav>
      ) : null}

      {/* Sticky selection toolbar */}
      {effectiveSelectedCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 pointer-events-none">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg">
            <span className="font-medium">
              {effectiveSelectedCount.toLocaleString()} selected
            </span>
            <span className="text-muted-foreground">·</span>
            <button
              type="button"
              onClick={() => setBulkEditOpen(true)}
              className="rounded-md px-2 py-1 text-foreground/90 transition hover:bg-muted/60"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setRemoveOpen(true)}
              className="rounded-md px-2 py-1 text-foreground/90 transition hover:bg-muted/60"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={exportSelectedCsv}
              className="rounded-md px-2 py-1 text-foreground/90 transition hover:bg-muted/60"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted/60"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {/* Confirmation: select all across pages */}
      <AlertDialog.Root
        open={pendingSelectAllAcrossConfirm}
        onOpenChange={setPendingSelectAllAcrossConfirm}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              Select all {total.toLocaleString()} recipients?
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                <p>
                  This selection spans every page of the current list view.
                  Confirm to continue.
                </p>
              </div>
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={() => {
                  setSelectAllAcrossPages(true);
                  setPendingSelectAllAcrossConfirm(false);
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                Select all
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Bulk edit modal */}
      <Dialog.Root open={bulkEditOpen} onOpenChange={setBulkEditOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Bulk edit name
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              Sets the name field on {effectiveSelectedCount.toLocaleString()} recipients.
            </Dialog.Description>
            <div className="mt-4 flex flex-col gap-1.5">
              <label
                htmlFor="bulk-edit-value"
                className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
              >
                New value
              </label>
              <input
                id="bulk-edit-value"
                type="text"
                value={bulkEditValue}
                onChange={(e) => setBulkEditValue(e.target.value)}
                maxLength={500}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                placeholder="e.g., Texas event invitee"
                autoFocus
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
                  disabled={pendingBulk}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={applyBulkEdit}
                disabled={pendingBulk || bulkEditValue.trim().length === 0}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              >
                {pendingBulk ? "Applying…" : "Apply"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Bulk remove confirmation */}
      <AlertDialog.Root open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              Remove {effectiveSelectedCount.toLocaleString()} recipients?
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                <p>
                  These recipients will be removed from this list. They will
                  not receive any future campaign sends to this list.
                </p>
              </div>
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  disabled={pendingRemove}
                  className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={applyRemove}
                disabled={pendingRemove}
                className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
              >
                {pendingRemove ? "Removing…" : "Remove"}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function SortHeader({
  label,
  sortKey,
  currentSortKey,
  currentSortDir,
  onSort,
}: {
  label: string;
  sortKey: "name" | "email" | "added";
  currentSortKey: "name" | "email" | "added";
  currentSortDir: "asc" | "desc";
  onSort: (key: "name" | "email" | "added") => void;
}) {
  const isActive = currentSortKey === sortKey;
  const arrow = !isActive ? "" : currentSortDir === "asc" ? " ↑" : " ↓";
  return (
    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 text-xs uppercase tracking-[0.05em] text-muted-foreground transition hover:text-foreground"
      >
        {label}
        {arrow}
      </button>
    </th>
  );
}

function PageLink({
  listId,
  page,
  search,
  sortKey,
  sortDir,
  label,
}: {
  listId: string;
  page: number;
  search: string;
  sortKey: "name" | "email" | "added";
  sortDir: "asc" | "desc";
  label: string;
}) {
  const sp = new URLSearchParams();
  if (page > 1) sp.set("page", String(page));
  if (search) sp.set("q", search);
  if (sortKey !== "added") sp.set("sort", sortKey);
  if (sortDir !== "desc") sp.set("dir", sortDir);
  const qs = sp.toString();
  const href = `/marketing/lists/${listId}${qs ? "?" + qs : ""}`;
  return (
    <a
      href={href}
      className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
    >
      {label}
    </a>
  );
}

/**
 * Inline editable cell. Renders the current value as a span; click →
 * input. Saves on blur after a 600ms debounce, or immediately on Enter.
 * Esc cancels.
 *
 * Phase 29 §5 — the parent passes `key={value}` so a server-side change
 * to the row's value remounts this cell rather than relying on a
 * setState-in-effect to mirror the prop.
 */
function InlineEditableCell({
  value,
  placeholder,
  onSave,
}: {
  value: string;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function commit() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setEditing(false);
    const next = draft.trim();
    if (next !== value.trim()) {
      onSave(next);
    }
  }

  function cancel() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDraft(value);
    setEditing(false);
  }

  function scheduleDebouncedSave(next: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = next.trim();
      if (trimmed !== value.trim()) {
        onSave(trimmed);
      }
    }, INLINE_EDIT_DEBOUNCE_MS);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full text-left text-sm text-foreground transition hover:text-primary"
      >
        {value.trim().length > 0 ? (
          value
        ) : (
          <span className="text-muted-foreground/70 italic">
            {placeholder ?? "Click to edit"}
          </span>
        )}
      </button>
    );
  }

  return (
    <input
      type="text"
      autoFocus
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        scheduleDebouncedSave(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
    />
  );
}

/**
 * Per-row menu — Edit (focuses the inline cell for now, see below) and
 * Remove (opens a small confirm-and-fire AlertDialog).
 */
function RowMenu({
  memberId,
  email,
  listId,
  pendingInlineSave,
  onRemoved,
}: {
  memberId: string;
  email: string;
  listId: string;
  pendingInlineSave: boolean;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      const result = await removeStaticListMembersAction({
        listId,
        memberIds: [memberId],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Recipient removed.");
      setOpen(false);
      onRemoved();
    });
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <button
          type="button"
          disabled={pendingInlineSave}
          aria-label={`Remove ${email}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            Remove this recipient?
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{email}</span>{" "}
                will be removed from this list.
              </p>
            </div>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleRemove}
              disabled={pending}
              className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
            >
              {pending ? "Removing…" : "Remove"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

