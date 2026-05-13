"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { TagChip } from "./tag-chip";
import { cn } from "@/lib/utils";

/**
 * Multi-select tags filter for entity list pages.
 *
 * Renders a hidden `<input name="tag" value="comma,separated,names">`
 * inside an enclosing GET form so the values arrive on the URL on
 * Apply. The list page's server-side parser reads `sp.tag` and splits
 * on comma. The dropdown also auto-syncs the hidden input when the
 * caller toggles auto-submit (mobile chip mode).
 *
 * OR semantics: a record matches if it carries ANY selected tag.
 */
export interface TagOption {
  id: string;
  name: string;
  color: string | null;
}

export function TagFilterSelect({
  name = "tag",
  options,
  defaultValue,
  placeholder = "Tags",
  autoSubmit = false,
}: {
  /** form-field name. The URL param. */
  name?: string;
  /** All tags in the catalog. */
  options: TagOption[];
  /** Comma-separated initial values (matches URL serialisation). */
  defaultValue?: string;
  placeholder?: string;
  /** When true, the enclosing form is submit()ed on every toggle. */
  autoSubmit?: boolean;
}) {
  const initial = (defaultValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const [selected, setSelected] = useState<string[]>(initial);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Auto-submit support — when the value changes and `autoSubmit` is
  // set, trigger the enclosing form. The mount ref skips the initial
  // render so the form does not auto-submit on first paint with the
  // hydrated default value.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!autoSubmit) {
      mountedRef.current = true;
      return;
    }
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const form = hiddenRef.current?.form;
    if (form) form.requestSubmit();
  }, [autoSubmit, selected]);

  function toggle(tagName: string) {
    setSelected((prev) =>
      prev.includes(tagName)
        ? prev.filter((n) => n !== tagName)
        : [...prev, tagName],
    );
  }

  function clearAll() {
    setSelected([]);
  }

  const hiddenValue = selected.join(",");
  const buttonLabel =
    selected.length === 0
      ? `All ${placeholder}`
      : selected.length === 1
        ? selected[0]
        : `${placeholder}: ${selected.length}`;

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={hiddenRef}
        type="hidden"
        name={name}
        value={hiddenValue}
      />
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
          {selected.length === 0 ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : null}
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
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-xl"
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
      ) : null}
    </div>
  );
}
