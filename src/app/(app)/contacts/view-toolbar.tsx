"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AVAILABLE_CONTACT_COLUMNS,
  type ContactColumnKey,
} from "@/lib/contact-view-constants";
import { ModifiedBadge, SaveViewDialog } from "@/components/saved-views";
import { useClickOutside } from "@/hooks/use-click-outside";
import {
  subscribeToViewAction,
  unsubscribeFromViewAction,
} from "@/app/(app)/settings/subscriptions-actions";
import {
  createContactViewAction,
  deleteContactViewAction,
  resetContactViewAction,
  setContactAdhocColumnsAction,
  setDefaultContactViewAction,
  updateContactViewAction,
} from "./view-actions";

export interface ContactViewSummary {
  id: string;
  name: string;
  source: "builtin" | "saved";
  scope: "mine" | "all";
  isPinned?: boolean;
  /** present on saved views; required when posting Save changes. */
  version?: number;
}

/**
 * Live client filter state, owned by the contacts list client
 * (TanStack Query migration). The toolbar reads this when building a
 * saved-view payload because these filters live ONLY in client state —
 * they are never written to the page URL, so useSearchParams can't see
 * them. Shape mirrors the list client's `ContactFilters` exactly.
 */
export interface ContactFilters {
  q: string;
  owner: string; // comma-separated owner ids
  account: string; // comma-separated account ids
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  doNotMail: boolean;
  city: string;
  state: string;
  country: string;
  recentlyUpdatedDays: string;
  tag: string; // comma-separated tag names
}

export interface ContactViewToolbarProps {
  views: ContactViewSummary[];
  activeViewId: string;
  activeViewName: string;
  activeColumns: ContactColumnKey[];
  baseColumns: ContactColumnKey[];
  /** "saved:<uuid>" if active view is saved AND user has dirty state, else null. */
  savedDirtyId: string | null;
  columnsModified: boolean;
  viewModified: boolean;
  modifiedFields: string[];
  /** saved-view ids the current user is subscribed to. */
  subscribedViewIds?: string[];
  /** "saved:<uuid>" of the user's default contact view, or null. */
  defaultViewId: string | null;
  /**
   * Live client-owned filter state. Required so "Save as new view"
   * captures the active filters — they live only in the list client's
   * useState (TanStack Query migration) and are never pushed to the
   * page URL, so they can't be reconstructed from useSearchParams.
   */
  filters: ContactFilters;
  /**
   * Called when the user confirms the MODIFIED → Reset flow. The client
   * component owns filter state (TanStack Query migration),
   * so URL navigation alone can't clear filters — the parent must reset its
   * useState here.
   */
  resetClientState: () => void;
}

export function ContactViewToolbar({
  views,
  activeViewId,
  activeViewName,
  activeColumns,
  baseColumns,
  savedDirtyId,
  columnsModified,
  viewModified,
  modifiedFields,
  subscribedViewIds,
  defaultViewId,
  filters,
  resetClientState,
}: ContactViewToolbarProps) {
  const router = useRouter();
  const search = useSearchParams();
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const columnsContainerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(
    columnsContainerRef,
    () => setColumnsOpen(false),
    columnsOpen,
  );

  const grouped = useMemo(() => {
    return {
      builtin: views.filter((v) => v.source === "builtin"),
      saved: views.filter((v) => v.source === "saved"),
    };
  }, [views]);

  const onPickView = (id: string) => {
    const params = new URLSearchParams(search.toString());
    params.set("view", id);
    for (const k of [
      "q",
      "owner",
      "account",
      "doNotContact",
      "doNotEmail",
      "doNotCall",
      "doNotMail",
      "city",
      "state",
      "country",
      "recentlyUpdatedDays",
      "tag",
      "cols",
      "sort",
      "dir",
      "page",
      "cursor",
    ]) {
      params.delete(k);
    }
    startTransition(() => {
      router.push(`/contacts?${params.toString()}`);
    });
  };

  const onToggleColumn = async (key: ContactColumnKey) => {
    const next = activeColumns.includes(key)
      ? activeColumns.filter((c) => c !== key)
      : [...activeColumns, key];
    if (next.length === 0) return;
    const params = new URLSearchParams(search.toString());
    params.set("cols", next.join(","));
    router.push(`/contacts?${params.toString()}`);

    if (activeViewId.startsWith("builtin:")) {
      // Persist only the SELECTION here, in canonical column order.
      // A built-in drag-reorder lives only in ?cols= (session) and
      // must never be laundered into prefs.adhoc_columns.
      const adhocCols = AVAILABLE_CONTACT_COLUMNS.map((c) => c.key).filter((k) =>
        next.includes(k),
      );
      const fd = new FormData();
      fd.set(
        "payload",
        JSON.stringify({
          columns: adhocCols.length === baseColumns.length ? null : adhocCols,
        }),
      );
      void setContactAdhocColumnsAction(fd);
    }
  };

  const onResetColumns = () => {
    const params = new URLSearchParams(search.toString());
    params.delete("cols");
    router.push(`/contacts?${params.toString()}`);
  };

  const isDefaultActive = defaultViewId === activeViewId;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ViewSelectMenu
        grouped={grouped}
        activeViewId={activeViewId}
        onPick={onPickView}
      />

      <ModifiedBadge
        isModified={viewModified}
        savedViewName={activeViewName}
        modifiedFields={modifiedFields}
        onReset={() => {
          // Reset client-owned filter state first so the parent's
          // useState<ContactFilters> drops back to EMPTY_FILTERS before
          // the URL navigation re-renders the server shell.
          resetClientState();
          void resetContactViewAction({
            viewId: activeViewId,
            viewName: activeViewName,
            modifiedFields,
          });
          const params = new URLSearchParams();
          params.set("view", activeViewId);
          router.push(`/contacts?${params.toString()}`);
          toast.success("View reset.");
        }}
      />

      {savedDirtyId && columnsModified ? (
        <button
          type="button"
          onClick={() => {
            const id = savedDirtyId.slice("saved:".length);
            const view = views.find((v) => v.id === savedDirtyId);
            const fd = new FormData();
            fd.set("id", id);
            fd.set("version", String(view?.version ?? 1));
            fd.set("payload", JSON.stringify({ columns: activeColumns }));
            startTransition(async () => {
              const res = await updateContactViewAction(fd);
              if (!res.ok) {
                toast.error(res.error, {
                  duration: Infinity,
                  dismissible: true,
                });
                return;
              }
              router.refresh();
            });
          }}
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Save changes
        </button>
      ) : null}

      {columnsModified ? (
        <button
          type="button"
          onClick={() => setSaveOpen(true)}
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Save as new view
        </button>
      ) : null}

      <div className="relative ml-auto hidden md:inline-flex" ref={columnsContainerRef}>
        <button
          type="button"
          onClick={() => setColumnsOpen((o) => !o)}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted"
        >
          Columns ({activeColumns.length})
        </button>
        {columnsOpen ? (
          <ColumnChooser
            active={activeColumns}
            onToggle={onToggleColumn}
            onReset={onResetColumns}
          />
        ) : null}
      </div>

      {activeViewId.startsWith("saved:") ? (
        <span className="hidden md:inline-flex">
          <SubscribeButton
            savedViewId={activeViewId.slice("saved:".length)}
            isSubscribed={
              subscribedViewIds?.includes(
                activeViewId.slice("saved:".length),
              ) ?? false
            }
            disabled={pending}
            onChange={() => router.refresh()}
          />
        </span>
      ) : null}

      {activeViewId.startsWith("saved:") ? (
        <button
          type="button"
          onClick={() => {
            startTransition(async () => {
              const next = isDefaultActive ? null : activeViewId;
              const res = await setDefaultContactViewAction({ viewId: next });
              if (!res.ok) {
                toast.error(res.error, {
                  duration: Infinity,
                  dismissible: true,
                });
                return;
              }
              toast.success(
                next ? "Set as default view." : "Default view cleared.",
              );
              router.refresh();
            });
          }}
          className={
            isDefaultActive
              ? "hidden rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20 md:inline-flex"
              : "hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground transition hover:bg-muted md:inline-flex"
          }
        >
          {isDefaultActive ? "Default" : "Set as default"}
        </button>
      ) : null}

      {activeViewId.startsWith("saved:") ? (
        <button
          type="button"
          onClick={() => {
            if (!confirm("Delete this saved view? This cannot be undone.")) return;
            const id = activeViewId.slice("saved:".length);
            const fd = new FormData();
            fd.set("id", id);
            startTransition(async () => {
              await deleteContactViewAction(fd);
              router.push("/contacts?view=builtin:my-open");
            });
          }}
          className="hidden rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] transition hover:bg-destructive/20 md:inline-flex"
        >
          Delete view
        </button>
      ) : null}

      {saveOpen ? (
        <SaveViewDialog
          onClose={() => setSaveOpen(false)}
          namePlaceholder="e.g. Atlanta benefits contacts"
          buildPayloadJson={({ name, pin }) => {
            // Filters live only in the list client's useState (TanStack
            // Query migration) and are never written to the page URL, so
            // read them from the live `filters` prop — NOT useSearchParams.
            // Sort still lives in the URL, so it stays on `search`.
            const params = new URLSearchParams(search.toString());
            const savedFilters: Record<string, unknown> = {};
            if (filters.q) savedFilters.search = filters.q;
            const ownerIds = filters.owner.split(",").filter(Boolean);
            if (ownerIds.length > 0) savedFilters.owner = ownerIds;
            const accountIds = filters.account.split(",").filter(Boolean);
            if (accountIds.length > 0) savedFilters.account = accountIds;
            if (filters.doNotContact) savedFilters.doNotContact = true;
            if (filters.doNotEmail) savedFilters.doNotEmail = true;
            if (filters.doNotCall) savedFilters.doNotCall = true;
            if (filters.doNotMail) savedFilters.doNotMail = true;
            if (filters.city) savedFilters.city = filters.city;
            if (filters.state) savedFilters.state = filters.state;
            if (filters.country) savedFilters.country = filters.country;
            if (filters.recentlyUpdatedDays) {
              const n = Number(filters.recentlyUpdatedDays);
              if (Number.isFinite(n) && n > 0) {
                savedFilters.recentlyUpdatedDays = n;
              }
            }
            const tagList = filters.tag
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (tagList.length > 0) savedFilters.tags = tagList;
            const sortField = params.get("sort") ?? "updatedAt";
            const sortDir = params.get("dir") === "asc" ? "asc" : "desc";
            return JSON.stringify({
              name,
              isPinned: pin,
              scope: activeViewId.includes("all") ? "all" : "mine",
              filters: savedFilters,
              columns: activeColumns,
              sort: { field: sortField, direction: sortDir },
            });
          }}
          onSave={async ({ payloadJson }) => {
            const fd = new FormData();
            fd.set("payload", payloadJson);
            return createContactViewAction(fd);
          }}
          onSaved={(id) => {
            setSaveOpen(false);
            const params = new URLSearchParams(search.toString());
            params.set("view", id);
            params.delete("cols");
            startTransition(() => {
              router.push(`/contacts?${params.toString()}`);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function ViewSelectMenu({
  grouped,
  activeViewId,
  onPick,
}: {
  grouped: { builtin: ContactViewSummary[]; saved: ContactViewSummary[] };
  activeViewId: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(containerRef, () => setOpen(false), open);
  const active = [...grouped.builtin, ...grouped.saved].find(
    (v) => v.id === activeViewId,
  );
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground transition hover:bg-muted"
      >
        <span className="font-medium">{active?.name ?? "Pick a view"}</span>
        <span className="text-muted-foreground/80">▾</span>
      </button>
      {open ? (
        <>
          <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-[var(--popover)] text-[var(--popover-foreground)] shadow-2xl">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
              Built-in
            </div>
            {grouped.builtin.map((v) => (
              <ViewMenuItem
                key={v.id}
                view={v}
                active={v.id === activeViewId}
                onPick={() => {
                  setOpen(false);
                  onPick(v.id);
                }}
              />
            ))}
            {grouped.saved.length > 0 ? (
              <>
                <div className="mt-2 border-t border-border px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  Saved
                </div>
                {grouped.saved.map((v) => (
                  <ViewMenuItem
                    key={v.id}
                    view={v}
                    active={v.id === activeViewId}
                    onPick={() => {
                      setOpen(false);
                      onPick(v.id);
                    }}
                  />
                ))}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ViewMenuItem({
  view,
  active,
  onPick,
}: {
  view: ContactViewSummary;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-muted/40 ${active ? "bg-muted font-medium" : ""}`}
    >
      <span className="flex items-center gap-2">
        {view.isPinned ? <span aria-hidden>⭐</span> : null}
        {view.name}
      </span>
      {active ? <span aria-hidden>✓</span> : null}
    </button>
  );
}

function ColumnChooser({
  active,
  onToggle,
  onReset,
}: {
  active: ContactColumnKey[];
  onToggle: (key: ContactColumnKey) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="absolute right-0 top-full z-50 mt-1 max-h-96 w-72 overflow-y-auto rounded-md border border-border bg-[var(--popover)] text-[var(--popover-foreground)] p-2 shadow-2xl">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
            Show columns
          </span>
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        </div>
        {AVAILABLE_CONTACT_COLUMNS.map((c) => (
          <label
            key={c.key}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-muted/40"
          >
            <input
              type="checkbox"
              checked={active.includes(c.key)}
              onChange={() => onToggle(c.key)}
              className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function SubscribeButton({
  savedViewId,
  isSubscribed,
  disabled,
  onChange,
}: {
  savedViewId: string;
  isSubscribed: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const [optimisticState, setOptimisticState] = useState(isSubscribed);
  const [submitting, startSubscribeTransition] = useTransition();

  function toggle() {
    const next = !optimisticState;
    setOptimisticState(next);
    startSubscribeTransition(async () => {
      const res = next
        ? await subscribeToViewAction({ savedViewId })
        : await unsubscribeFromViewAction({ savedViewId });
      if (res.ok) {
        toast.success(
          next
            ? "Subscribed. Digests sent to your Microsoft 365 mailbox."
            : "Unsubscribed.",
        );
        onChange();
      } else {
        setOptimisticState(!next);
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || submitting}
      className={
        optimisticState
          ? "rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20"
          : "rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground transition hover:bg-muted"
      }
      title={
        optimisticState
          ? "Subscribed. Click to unsubscribe."
          : "Subscribe to a digest of new matches sent from your own Microsoft 365 mailbox."
      }
    >
      {submitting
        ? "Saving…"
        : optimisticState
          ? "Subscribed"
          : "Subscribe"}
    </button>
  );
}
