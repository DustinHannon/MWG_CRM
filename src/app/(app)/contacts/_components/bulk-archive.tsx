"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { bulkArchiveContactsAction } from "../actions";

/**
 * row-selection + bulk-archive coordination for the
 * /contacts desktop table. Context is consumed by the toolbar
 * (BulkArchiveBar) and each row (RowCheckbox); the provider lives
 * at the page level wrapping the entire table region.
 */
interface BulkCtx {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  archive: () => void;
  pending: boolean;
}

const Ctx = createContext<BulkCtx | null>(null);

function useBulkCtx(): BulkCtx {
  const v = useContext(Ctx);
  if (!v) {
    // Render-safe fallback when consumed outside the provider.
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
  const [pending, startTransition] = useTransition();

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
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
    startTransition(async () => {
      const res = await bulkArchiveContactsAction({
        ids: Array.from(selected),
      });
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
        return;
      }
      const { archived, denied } = res.data;
      if (denied > 0) {
        toast.success(
          `Archived ${archived}. Skipped ${denied} you don't own.`,
        );
      } else {
        toast.success(
          `Archived ${archived} ${archived === 1 ? "contact" : "contacts"}.`,
        );
      }
      setSelected(new Set());
      router.refresh();
    });
  }, [selected, router]);

  const value = useMemo<BulkCtx>(
    () => ({ selected, toggle, clear, archive, pending }),
    [selected, toggle, clear, archive, pending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function RowCheckbox({ id }: { id: string }) {
  const ctx = useBulkCtx();
  const checked = ctx.selected.has(id);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => ctx.toggle(id)}
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
