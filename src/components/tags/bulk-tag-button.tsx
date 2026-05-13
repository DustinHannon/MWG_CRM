"use client";

import { useEffect, useState, useTransition } from "react";
import { Tags } from "lucide-react";
import { toast } from "sonner";
import { bulkTagAction } from "./actions";
import { TagChip } from "./tag-chip";
import { cn } from "@/lib/utils";

/**
 * Bulk-tag toolbar surface for any tag-aware entity list. Mirrors the
 * AddVisibleToListButton pattern: acts on `recordIds` currently
 * visible (or selected) — passed in as a prop — rather than a per-row
 * selection model.
 *
 * Backend: `bulkTagAction({ entityType, recordIds, tagIds, operation })`.
 * Supports add + remove. UI exposes tag picker + Add/Remove radio.
 *
 * Originally lived at `src/app/(app)/leads/_components/bulk-tag-button.tsx`
 * scoped to leads only. Relocated and generalised so all five
 * entities share one implementation.
 */
export interface AvailableTag {
  id: string;
  name: string;
  color: string | null;
}

export type BulkTagEntityType =
  | "lead"
  | "account"
  | "contact"
  | "opportunity"
  | "task";

const ENTITY_NOUN: Record<BulkTagEntityType, { single: string; plural: string }> = {
  lead: { single: "lead", plural: "leads" },
  account: { single: "account", plural: "accounts" },
  contact: { single: "contact", plural: "contacts" },
  opportunity: { single: "opportunity", plural: "opportunities" },
  task: { single: "task", plural: "tasks" },
};

export function BulkTagButton({
  entityType,
  recordIds,
  availableTags,
}: {
  entityType: BulkTagEntityType;
  recordIds: string[];
  availableTags: AvailableTag[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<"add" | "remove">("add");

  // Escape closes the dialog — WCAG 2.1.2. Without this, keyboard
  // users cannot dismiss the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending]);

  if (recordIds.length === 0 || availableTags.length === 0) return null;

  const noun = ENTITY_NOUN[entityType];

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
      const res = await bulkTagAction({
        entityType,
        recordIds,
        tagIds: Array.from(picked),
        operation: op,
      });
      if (res.ok) {
        const { recordsTouched, tagsAdded, tagsRemoved } = res.data;
        const recordWord =
          recordsTouched === 1 ? noun.single : noun.plural;
        if (op === "add") {
          toast.success(
            `Added ${tagsAdded} tag(s) across ${recordsTouched} ${recordWord}.`,
          );
        } else {
          toast.success(
            `Removed ${tagsRemoved} tag(s) across ${recordsTouched} ${recordWord}.`,
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
          aria-label={`Bulk add or remove tags from visible ${noun.plural}`}
          onClick={() => {
            if (!pending) setOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Bulk tag {recordIds.length.toLocaleString()}{" "}
              {recordIds.length === 1 ? noun.single : noun.plural}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Apply the selected tags to every {noun.single} currently
              visible. Each {noun.single} gets its own audit row.
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
