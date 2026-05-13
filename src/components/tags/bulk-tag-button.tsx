"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Tags } from "lucide-react";
import { toast } from "sonner";
import { bulkTagAction } from "./actions";
import { TagChip } from "./tag-chip";
import { cn } from "@/lib/utils";
import type { BulkScope } from "@/lib/bulk-actions/scope";

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

/**
 * Props accept either the legacy `recordIds: string[]` shape (used
 * by callers that pre-date the four-state selection model) OR the
 * new `scope: BulkScope` shape. Internally the component normalises
 * to a single `BulkScope` so the rest of the component has one
 * code path.
 *
 * The legacy `recordIds` shape will be removed in a follow-on
 * cleanup once consumers have migrated. Both shapes go through the
 * same server action.
 */
type BulkTagButtonLegacyProps = {
  entityType: BulkTagEntityType;
  recordIds: string[];
  scope?: undefined;
  availableTags: AvailableTag[];
  canApply: boolean;
};
type BulkTagButtonScopeProps = {
  entityType: BulkTagEntityType;
  scope: BulkScope;
  recordIds?: undefined;
  availableTags: AvailableTag[];
  canApply: boolean;
};
export type BulkTagButtonProps =
  | BulkTagButtonLegacyProps
  | BulkTagButtonScopeProps;

export function BulkTagButton(props: BulkTagButtonProps) {
  const { entityType, availableTags, canApply } = props;
  // Normalise the two prop shapes to a single internal `scope`.
  // Memoised so it's referentially stable for the submit path and
  // any future effect dependencies.
  const scope = useMemo<BulkScope>(() => {
    if (props.scope) return props.scope;
    return { kind: "ids", ids: props.recordIds ?? [] };
  }, [props.scope, props.recordIds]);

  // Banner / button affordance count. For `ids` scope we use the
  // array length; for `filtered` scope we don't know the count
  // client-side, so render an entity-noun-only label and let the
  // server-side resolution apply.
  const scopeCount = scope.kind === "ids" ? scope.ids.length : null;

  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<"add" | "remove">("add");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFocusRef = useRef<HTMLInputElement>(null);

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

  // Focus management — WCAG 2.4.3 Focus Order. When the dialog opens,
  // move focus into it (first focusable: the Add radio). When the
  // dialog closes (after having been open), return focus to the
  // trigger so keyboard users land back where they started. A
  // `hasOpened` ref guards the close branch so the first render with
  // `open=false` does NOT yank focus from whatever else is focused.
  const hasOpenedRef = useRef(false);
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      // setTimeout 0 so the focus call runs after the DOM mounts.
      const handle = setTimeout(() => {
        firstFocusRef.current?.focus();
      }, 0);
      return () => clearTimeout(handle);
    }
    if (hasOpenedRef.current) {
      triggerRef.current?.focus();
    }
  }, [open]);

  if (!canApply) return null;
  // For `ids` scope, hide the button when there are no selected
  // records. `filtered` scope is always actionable — the server
  // walks pages to determine the actual set. Either scope still
  // requires at least one available tag to render the picker.
  if (scope.kind === "ids" && scope.ids.length === 0) return null;
  if (availableTags.length === 0) return null;

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
        // Forward the normalised scope. The action accepts either
        // shape (legacy `recordIds` or new `scope`); we always send
        // `scope` so the server has a single code path.
        scope,
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
        ref={triggerRef}
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
          aria-label={`Bulk add or remove tags from selected ${noun.plural}`}
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
              {scopeCount !== null
                ? `Bulk tag ${scopeCount.toLocaleString()} ${scopeCount === 1 ? noun.single : noun.plural}`
                : `Bulk tag all matching ${noun.plural}`}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {scopeCount !== null
                ? `Apply the selected tags to every ${noun.single} in the current selection. Each ${noun.single} gets its own audit row.`
                : `Apply the selected tags to every ${noun.single} matching the current filters. Each ${noun.single} gets its own audit row.`}
            </p>

            <div className="mt-4 flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  ref={firstFocusRef}
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
