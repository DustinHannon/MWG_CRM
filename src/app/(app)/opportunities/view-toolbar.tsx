"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Star } from "lucide-react";
import {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  type OpportunityColumnKey,
} from "@/lib/opportunity-view-constants";
import { ModifiedBadge, SaveViewDialog } from "@/components/saved-views";
import { StandardConfirmDialog } from "@/components/standard";
import { useClickOutside } from "@/hooks/use-click-outside";
import {
  subscribeToViewAction,
  unsubscribeFromViewAction,
} from "@/app/(app)/settings/subscriptions-actions";
import {
  createOpportunityViewAction,
  deleteOpportunityViewAction,
  resetOpportunityViewAction,
  setDefaultOpportunityViewAction,
  setOpportunityAdhocColumnsAction,
  updateOpportunityViewAction,
} from "./view-actions";

export interface OpportunityViewSummary {
  id: string;
  name: string;
  source: "builtin" | "saved";
  scope: "mine" | "all";
  isPinned?: boolean;
  /** present on saved views; required when posting Save changes. */
  version?: number;
}

export interface OpportunityViewToolbarProps {
  views: OpportunityViewSummary[];
  activeViewId: string;
  activeViewName: string;
  activeColumns: OpportunityColumnKey[];
  baseColumns: OpportunityColumnKey[];
  /** "saved:<uuid>" if active view is saved AND user has dirty state, else null. */
  savedDirtyId: string | null;
  columnsModified: boolean;
  viewModified: boolean;
  modifiedFields: string[];
  /** saved-view ids the current user is subscribed to. */
  subscribedViewIds?: string[];
  /** "saved:<uuid>" of the user's default opportunity view, or null. */
  defaultViewId: string | null;
  /**
   * Called when the user confirms the MODIFIED → Reset flow. The client
   * component owns filter state (TanStack Query migration),
   * so URL navigation alone can't clear filters — the parent must reset its
   * useState here.
   */
  resetClientState: () => void;
}

export function OpportunityViewToolbar({
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
  resetClientState,
}: OpportunityViewToolbarProps) {
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
      "stage",
      "closingWithinDays",
      "minAmount",
      "maxAmount",
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
      router.push(`/opportunities?${params.toString()}`);
    });
  };

  const onToggleColumn = async (key: OpportunityColumnKey) => {
    const next = activeColumns.includes(key)
      ? activeColumns.filter((c) => c !== key)
      : [...activeColumns, key];
    if (next.length === 0) return;
    const params = new URLSearchParams(search.toString());
    params.set("cols", next.join(","));
    router.push(`/opportunities?${params.toString()}`);

    if (activeViewId.startsWith("builtin:")) {
      // Persist only the SELECTION here, in canonical column order.
      // A built-in drag-reorder lives only in ?cols= (session) and
      // must never be laundered into prefs.adhoc_columns.
      const adhocCols = AVAILABLE_OPPORTUNITY_COLUMNS.map((c) => c.key).filter((k) =>
        next.includes(k),
      );
      const fd = new FormData();
      fd.set(
        "payload",
        JSON.stringify({
          columns: adhocCols.length === baseColumns.length ? null : adhocCols,
        }),
      );
      void setOpportunityAdhocColumnsAction(fd);
    }
  };

  const onResetColumns = () => {
    const params = new URLSearchParams(search.toString());
    params.delete("cols");
    router.push(`/opportunities?${params.toString()}`);
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
          // useState<OpportunityFilters> drops back to EMPTY_FILTERS
          // before the URL navigation re-renders the server shell.
          resetClientState();
          void resetOpportunityViewAction({
            viewId: activeViewId,
            viewName: activeViewName,
            modifiedFields,
          });
          const params = new URLSearchParams();
          params.set("view", activeViewId);
          router.push(`/opportunities?${params.toString()}`);
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
              const res = await updateOpportunityViewAction(fd);
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
              const res = await setDefaultOpportunityViewAction({
                viewId: next,
              });
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
        <StandardConfirmDialog
          trigger={
            <button
              type="button"
              className="hidden rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] transition hover:bg-[var(--status-lost-bg)]/70 md:inline-flex"
            >
              Delete view
            </button>
          }
          title="Delete this saved view?"
          body="This cannot be undone."
          confirmLabel="Delete view"
          tone="destructive"
          onConfirm={() => {
            const id = activeViewId.slice("saved:".length);
            const fd = new FormData();
            fd.set("id", id);
            startTransition(async () => {
              await deleteOpportunityViewAction(fd);
              router.push("/opportunities?view=builtin:my-open");
            });
          }}
        />
      ) : null}

      {saveOpen ? (
        <SaveViewDialog
          onClose={() => setSaveOpen(false)}
          namePlaceholder="e.g. Enterprise deals closing this quarter"
          buildPayloadJson={({ name, pin }) => {
            const params = new URLSearchParams(search.toString());
            const filters: Record<string, unknown> = {};
            if (params.get("q")) filters.search = params.get("q");
            if (params.get("owner"))
              filters.owner = params.get("owner")!.split(",").filter(Boolean);
            if (params.get("account"))
              filters.account = params.get("account")!.split(",").filter(Boolean);
            if (params.get("stage"))
              filters.stage = params.get("stage")!.split(",").filter(Boolean);
            if (params.get("closingWithinDays")) {
              const n = Number(params.get("closingWithinDays"));
              if (Number.isFinite(n) && n > 0) filters.closingWithinDays = n;
            }
            if (params.get("minAmount")) {
              const n = Number(params.get("minAmount"));
              if (Number.isFinite(n) && n >= 0) filters.minAmount = n;
            }
            if (params.get("maxAmount")) {
              const n = Number(params.get("maxAmount"));
              if (Number.isFinite(n) && n >= 0) filters.maxAmount = n;
            }
            if (params.get("tag")) {
              const raw = params.get("tag") ?? "";
              const list = raw
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              if (list.length > 0) filters.tags = list;
            }
            const sortField = params.get("sort") ?? "expectedCloseDate";
            const sortDir = params.get("dir") === "asc" ? "asc" : "desc";
            return JSON.stringify({
              name,
              isPinned: pin,
              scope: activeViewId.includes("all") ? "all" : "mine",
              filters,
              columns: activeColumns,
              sort: { field: sortField, direction: sortDir },
            });
          }}
          onSave={async ({ payloadJson }) => {
            const fd = new FormData();
            fd.set("payload", payloadJson);
            return createOpportunityViewAction(fd);
          }}
          onSaved={(id) => {
            setSaveOpen(false);
            const params = new URLSearchParams(search.toString());
            params.set("view", id);
            params.delete("cols");
            startTransition(() => {
              router.push(`/opportunities?${params.toString()}`);
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
  grouped: {
    builtin: OpportunityViewSummary[];
    saved: OpportunityViewSummary[];
  };
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
        <ChevronDown
          aria-hidden
          className="h-4 w-4 text-muted-foreground/80"
        />
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
  view: OpportunityViewSummary;
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
        {view.isPinned ? (
          <Star aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        ) : null}
        {view.name}
      </span>
      {active ? <Check aria-hidden className="h-4 w-4" /> : null}
    </button>
  );
}

function ColumnChooser({
  active,
  onToggle,
  onReset,
}: {
  active: OpportunityColumnKey[];
  onToggle: (key: OpportunityColumnKey) => void;
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
        {AVAILABLE_OPPORTUNITY_COLUMNS.map((c) => (
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
