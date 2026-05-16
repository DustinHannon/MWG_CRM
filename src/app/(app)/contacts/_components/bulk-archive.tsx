"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkArchiveContactsAction } from "../actions";

/**
 * row-selection + bulk-archive coordination for the
 * /contacts desktop table. Context is consumed by the toolbar
 * (BulkArchiveBar) and each row (RowCheckbox); the provider lives
 * at the page level wrapping the entire table region.
 *
 * Each selected row carries the `version` it was rendered with so the
 * bulk archive can enforce per-row optimistic concurrency: a row
 * changed by someone else since the page loaded is skipped and
 * reported, never silently clobbered.
 */
interface BulkCtx {
  selected: Set<string>;
  toggle: (id: string, version: number) => void;
  clear: () => void;
  archive: () => void;
  pending: boolean;
}

const Ctx = createContext<BulkCtx | null>(null);

function useBulkCtx(): BulkCtx {
  const v = useContext(Ctx);
  if (!v) {
    // Render-safe fallback when consumed outside the provider — keeps
    // the desktop checkbox column inert in any future surface that
    // forgets to wrap with the provider.
    return {
      selected: new Set(),
      toggle: () => {},
      clear: () => {},
      archive: () => {},
      pending: false,
    };
  }
  return v;
}

export function BulkArchiveProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // id -> version of the currently-selected rows. A ref (not state):
  // read only at archive time, never rendered.
  const versionById = useRef<Map<string, number>>(new Map());
  const [pending, startTransition] = useTransition();

  const toggle = useCallback((id: string, version: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        versionById.current.delete(id);
      } else {
        next.add(id);
        versionById.current.set(id, version);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    versionById.current.clear();
  }, []);

  const archive = useCallback(() => {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Archive ${selected.size} ${selected.size === 1 ? "contact" : "contacts"}? Linked accounts and opportunities remain visible.`,
      )
    ) {
      return;
    }
    const items = Array.from(selected)
      .map((id) => {
        const version = versionById.current.get(id);
        return typeof version === "number" ? { id, version } : null;
      })
      .filter((x): x is { id: string; version: number } => x !== null);
    if (items.length === 0) return;
    startTransition(async () => {
      const res = await bulkArchiveContactsAction({ items });
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
        return;
      }
      const { archived, denied, conflicts } = res.data;
      if (denied > 0) {
        toast.success(
          `Archived ${archived}. Skipped ${denied} you don't own.`,
        );
      } else {
        toast.success(
          `Archived ${archived} ${archived === 1 ? "contact" : "contacts"}.`,
        );
      }
      if (conflicts.length > 0) {
        toast.warning(
          `${conflicts.length} ${
            conflicts.length === 1 ? "contact was" : "contacts were"
          } modified by someone else and were skipped. Refresh to see the latest, then retry.`,
          { duration: Infinity, dismissible: true },
        );
      }
      setSelected(new Set());
      versionById.current.clear();
      router.refresh();
    });
  }, [selected, router]);

  const value = useMemo<BulkCtx>(
    () => ({ selected, toggle, clear, archive, pending }),
    [selected, toggle, clear, archive, pending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function RowCheckbox({
  id,
  version,
}: {
  id: string;
  version: number;
}) {
  const ctx = useBulkCtx();
  const checked = ctx.selected.has(id);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => ctx.toggle(id, version)}
      aria-label="Select row"
      className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
    />
  );
}

export function BulkArchiveBar() {
  const ctx = useBulkCtx();
  if (ctx.selected.size === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-foreground">
      <span className="font-medium">{ctx.selected.size} selected</span>
      <button
        type="button"
        onClick={ctx.archive}
        disabled={ctx.pending}
        className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-2 py-1 text-[var(--status-lost-fg)] transition hover:bg-destructive/20 disabled:opacity-60"
      >
        {ctx.pending ? "Archiving…" : "Archive selected"}
      </button>
      <button
        type="button"
        onClick={ctx.clear}
        className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
      >
        Clear
      </button>
    </div>
  );
}
