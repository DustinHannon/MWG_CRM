"use client";

import { useState, useTransition } from "react";
import { Tags } from "lucide-react";
import { toast } from "sonner";
import { bulkTagLeadsAction } from "@/components/tags/actions";
import { TagChip } from "@/components/tags/tag-chip";
import { cn } from "@/lib/utils";

/**
 * bulk-tag toolbar surface. Mirrors the
 * AddVisibleToListButton pattern: acts on the leadIds currently
 * visible in the table (passed in as a prop) rather than a per-row
 * selection model. When per-row selection lands, swap the leadIds
 * source.
 *
 * Backend: `bulkTagLeadsAction({ leadIds, tagIds, operation })`
 * already supports add + remove. UI exposes tag picker + Add/Remove
 * radio + Confirm.
 */
export interface AvailableTag {
  id: string;
  name: string;
  color: string | null;
}

export function BulkTagButton({
  leadIds,
  availableTags,
}: {
  leadIds: string[];
  availableTags: AvailableTag[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<"add" | "remove">("add");

  if (leadIds.length === 0 || availableTags.length === 0) return null;

  function toggleTag(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (picked.size === 0) {
      toast.error("Pick at least one tag first.");
      return;
    }
    startTransition(async () => {
      const res = await bulkTagLeadsAction({
        leadIds,
        tagIds: Array.from(picked),
        operation: op,
      });
      if (res.ok) {
        const { leadsTouched, tagsAdded, tagsRemoved } = res.data;
        if (op === "add") {
          toast.success(
            `Added ${tagsAdded} tag(s) across ${leadsTouched} lead${
              leadsTouched === 1 ? "" : "s"
            }.`,
          );
        } else {
          toast.success(
            `Removed ${tagsRemoved} tag(s) across ${leadsTouched} lead${
              leadsTouched === 1 ? "" : "s"
            }.`,
          );
        }
        setOpen(false);
        setPicked(new Set());
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
      >
        <Tags className="h-4 w-4" aria-hidden />
        Bulk tag
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Bulk add or remove tags from visible leads"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Bulk tag {leadIds.length.toLocaleString()} lead
              {leadIds.length === 1 ? "" : "s"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Apply the selected tags to every lead currently visible.
              Each lead gets its own audit row.
            </p>

            <div className="mt-4 flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="op"
                  value="add"
                  checked={op === "add"}
                  onChange={() => setOp("add")}
                />
                Add
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="op"
                  value="remove"
                  checked={op === "remove"}
                  onChange={() => setOp("remove")}
                />
                Remove
              </label>
            </div>

            <div className="mt-4 flex max-h-64 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-glass-border bg-input/60 p-2">
              {availableTags.map((t) => {
                const isPicked = picked.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTag(t.id)}
                    aria-pressed={isPicked}
                    className={cn(
                      "rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isPicked ? "opacity-100" : "opacity-50 hover:opacity-80",
                    )}
                  >
                    <TagChip name={t.name} color={t.color ?? "slate"} />
                  </button>
                );
              })}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || picked.size === 0}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending
                  ? "Applying…"
                  : op === "add"
                    ? "Add tags"
                    : "Remove tags"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
