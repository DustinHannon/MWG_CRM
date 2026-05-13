"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AVAILABLE_ACCOUNT_COLUMNS,
  type AccountColumnKey,
} from "@/lib/account-view-constants";
import { ModifiedBadge } from "@/components/saved-views";
import {
  subscribeToViewAction,
  unsubscribeFromViewAction,
} from "@/app/(app)/settings/subscriptions-actions";
import {
  createAccountViewAction,
  deleteAccountViewAction,
  resetAccountViewAction,
  setAccountAdhocColumnsAction,
  setDefaultAccountViewAction,
  updateAccountViewAction,
} from "./view-actions";

export interface AccountViewSummary {
  id: string;
  name: string;
  source: "builtin" | "saved";
  scope: "mine" | "all";
  isPinned?: boolean;
  /** present on saved views; required when posting Save changes. */
  version?: number;
}

export interface AccountViewToolbarProps {
  views: AccountViewSummary[];
  activeViewId: string;
  activeViewName: string;
  activeColumns: AccountColumnKey[];
  baseColumns: AccountColumnKey[];
  /** "saved:<uuid>" if active view is saved AND user has dirty state, else null. */
  savedDirtyId: string | null;
  columnsModified: boolean;
  viewModified: boolean;
  modifiedFields: string[];
  /** saved-view ids the current user is subscribed to. */
  subscribedViewIds?: string[];
  /** "saved:<uuid>" of the user's default account view, or null. */
  defaultViewId: string | null;
}

/**
 * Top-of-page toolbar for /accounts. View selector (built-in + saved)
 * + Modified badge + Save changes / Save as new + Set as default +
 * Subscribe + Delete + Column chooser.
 */
export function AccountViewToolbar({
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
}: AccountViewToolbarProps) {
  const router = useRouter();
  const search = useSearchParams();
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();

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
      "industry",
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
      router.push(`/accounts?${params.toString()}`);
    });
  };

  const onToggleColumn = async (key: AccountColumnKey) => {
    const next = activeColumns.includes(key)
      ? activeColumns.filter((c) => c !== key)
      : [...activeColumns, key];
    if (next.length === 0) return;
    const params = new URLSearchParams(search.toString());
    params.set("cols", next.join(","));
    router.push(`/accounts?${params.toString()}`);

    if (activeViewId.startsWith("builtin:")) {
      const fd = new FormData();
      fd.set(
        "payload",
        JSON.stringify({
          columns: next.length === baseColumns.length ? null : next,
        }),
      );
      void setAccountAdhocColumnsAction(fd);
    }
  };

  const onResetColumns = () => {
    const params = new URLSearchParams(search.toString());
    params.delete("cols");
    router.push(`/accounts?${params.toString()}`);
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
          void resetAccountViewAction({
            viewId: activeViewId,
            viewName: activeViewName,
            modifiedFields,
          });
          const params = new URLSearchParams();
          params.set("view", activeViewId);
          router.push(`/accounts?${params.toString()}`);
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
              const res = await updateAccountViewAction(fd);
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
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted"
        >
          Save changes
        </button>
      ) : null}

      {columnsModified ? (
        <button
          type="button"
          onClick={() => setSaveOpen(true)}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted"
        >
          Save as new view
        </button>
      ) : null}

      <div className="relative ml-auto">
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
            onClose={() => setColumnsOpen(false)}
            onReset={onResetColumns}
          />
        ) : null}
      </div>

      {activeViewId.startsWith("saved:") ? (
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
      ) : null}

      {activeViewId.startsWith("saved:") ? (
        <button
          type="button"
          onClick={() => {
            startTransition(async () => {
              const next = isDefaultActive ? null : activeViewId;
              const res = await setDefaultAccountViewAction({ viewId: next });
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
              ? "rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20"
              : "rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground transition hover:bg-muted"
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
              await deleteAccountViewAction(fd);
              router.push("/accounts?view=builtin:my-open");
            });
          }}
          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] transition hover:bg-destructive/20"
        >
          Delete view
        </button>
      ) : null}

      {saveOpen ? (
        <SaveViewDialog
          defaultColumns={activeColumns}
          activeViewId={activeViewId}
          search={search.toString()}
          onClose={() => setSaveOpen(false)}
          onSaved={(id) => {
            setSaveOpen(false);
            const params = new URLSearchParams(search.toString());
            params.set("view", id);
            params.delete("cols");
            startTransition(() => {
              router.push(`/accounts?${params.toString()}`);
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
  grouped: { builtin: AccountViewSummary[]; saved: AccountViewSummary[] };
  activeViewId: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = [...grouped.builtin, ...grouped.saved].find(
    (v) => v.id === activeViewId,
  );
  return (
    <div className="relative">
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
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
          />
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
  view: AccountViewSummary;
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
  onClose,
  onReset,
}: {
  active: AccountColumnKey[];
  onToggle: (key: AccountColumnKey) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close column chooser"
        className="fixed inset-0 z-40 cursor-default"
      />
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
        {AVAILABLE_ACCOUNT_COLUMNS.map((c) => (
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

function SaveViewDialog({
  defaultColumns,
  activeViewId,
  search,
  onClose,
  onSaved,
}: {
  defaultColumns: AccountColumnKey[];
  activeViewId: string;
  search: string;
  onClose: () => void;
  onSaved: (newId: string) => void;
}) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);

    // Derive filters from URL params.
    const params = new URLSearchParams(search);
    const filters: Record<string, unknown> = {};
    if (params.get("q")) filters.search = params.get("q");
    if (params.get("owner"))
      filters.owner = params.get("owner")!.split(",").filter(Boolean);
    if (params.get("industry"))
      filters.industry = params.get("industry")!.split(",").filter(Boolean);
    if (params.get("recentlyUpdatedDays")) {
      const n = Number(params.get("recentlyUpdatedDays"));
      if (Number.isFinite(n) && n > 0) filters.recentlyUpdatedDays = n;
    }
    if (params.get("tag")) {
      // tag accepts a comma-separated list (multi-select).
      const raw = params.get("tag") ?? "";
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length > 0) filters.tags = list;
    }

    const sortField = params.get("sort") ?? "updatedAt";
    const sortDir = params.get("dir") === "asc" ? "asc" : "desc";

    const payload = {
      name: name.trim(),
      isPinned: pin,
      scope: activeViewId.includes("all") ? "all" : "mine",
      filters,
      columns: defaultColumns,
      sort: { field: sortField, direction: sortDir },
    };
    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));
    const res = await createAccountViewAction(fd);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed.");
      return;
    }
    if (res.data?.id) onSaved(`saved:${res.data.id}`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-border bg-[var(--popover)] text-[var(--popover-foreground)] p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Save current view</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Captures your current filters and columns so you can come back to
          them with one click.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              placeholder="e.g. Texas healthcare accounts"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pin}
              onChange={(e) => setPin(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
            />
            <span>Pin to top of list</span>
          </label>
          {error ? (
            <p className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-xs text-[var(--status-lost-fg)]">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Save view"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
