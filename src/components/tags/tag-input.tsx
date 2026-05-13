"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { TagChip } from "./tag-chip";
import {
  applyTagAction,
  getOrCreateTagAction,
  removeTagAction,
  searchTagsAction,
} from "./actions";

interface SelectedTag {
  id: string;
  name: string;
  color: string;
}

type EntityType = "lead" | "account" | "contact" | "opportunity" | "task";

type FormHiddenProps = {
  mode?: "form-hidden";
  value: SelectedTag[];
  onChange: (next: SelectedTag[]) => void;
  hiddenInputName?: string;
  /** Disable interactive controls (chips still render). */
  disabled?: boolean;
  /** Per-tag click handler (e.g., open edit modal). */
  onTagClick?: (tag: SelectedTag) => void;
};

type ActionProps = {
  mode: "action";
  value: SelectedTag[];
  /** Required when mode === "action". */
  entityType: EntityType;
  /** Required when mode === "action". */
  entityId: string;
  /** Called after a successful add (server returned a new chip). */
  onApplied?: (tag: SelectedTag) => void;
  /** Called after a successful remove. */
  onRemoved?: (tagId: string) => void;
  /** Disable interactive controls (chips still render). */
  disabled?: boolean;
  /** Per-tag click handler (e.g., open edit modal). */
  onTagClick?: (tag: SelectedTag) => void;
};

type TagInputProps = FormHiddenProps | ActionProps;

/**
 * Combobox-with-multiselect for tags.
 *
 * Two modes:
 *  - `form-hidden` (default; legacy): selected tag IDs are written
 *    to a hidden form input so a server action can pick them up on
 *    form submit.
 *  - `action`: each add/remove calls applyTagAction / removeTagAction
 *    inline against the given (entityType, entityId). Used by
 *    `<TagSection>` on every entity edit form.
 */
export function TagInput(props: TagInputProps) {
  const mode = props.mode ?? "form-hidden";
  const disabled = props.disabled === true;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SelectedTag[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const value = props.value;

  // Search on query change (debounced).
  useEffect(() => {
    const handle = setTimeout(async () => {
      const res = await searchTagsAction(query);
      if (!res.ok) return;
      setResults(res.data.filter((r) => !value.some((v) => v.id === r.id)));
    }, 150);
    return () => clearTimeout(handle);
  }, [query, value]);

  // Click outside closes the dropdown.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const exactMatch = results.some(
    (r) => r.name.toLowerCase() === query.trim().toLowerCase(),
  );
  // Check whether the typed query matches the name of a tag already
  // applied to this entity. If so, the "Create" affordance would
  // mislead the user — clicking it triggers an action that resolves
  // to the existing tag and applies (no-op). Render a hint instead.
  const alreadyAppliedExact =
    query.trim().length > 0 &&
    value.some(
      (v) => v.name.toLowerCase() === query.trim().toLowerCase(),
    );
  const showCreate =
    query.trim().length > 0 && !exactMatch && !alreadyAppliedExact;
  const items: Array<
    | SelectedTag
    | { kind: "create"; name: string }
    | { kind: "already-applied"; name: string }
  > = [
    ...results,
    ...(showCreate ? [{ kind: "create" as const, name: query.trim() }] : []),
    ...(alreadyAppliedExact
      ? [{ kind: "already-applied" as const, name: query.trim() }]
      : []),
  ];

  function commitFormHidden(next: SelectedTag[]) {
    (props as FormHiddenProps).onChange?.(next);
  }

  function selectTagFormHidden(tag: SelectedTag) {
    if (value.some((v) => v.id === tag.id)) return;
    commitFormHidden([...value, tag]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }

  async function createAndSelectFormHidden(name: string) {
    const res = await getOrCreateTagAction(name);
    if (res.ok && res.data) {
      const created = res.data;
      selectTagFormHidden({
        id: created.id,
        name: created.name,
        color: created.color,
      });
    } else if (!res.ok) {
      toast.error(res.error);
    }
  }

  function removeTagFormHidden(id: string) {
    commitFormHidden(value.filter((v) => v.id !== id));
  }

  function selectTagAction(tag: SelectedTag) {
    if (value.some((v) => v.id === tag.id)) {
      setQuery("");
      setActive(0);
      return;
    }
    const { entityType, entityId, onApplied } = props as ActionProps;
    startTransition(async () => {
      const res = await applyTagAction({
        entityType,
        entityId,
        tagId: tag.id,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onApplied?.({
        id: res.data.id,
        name: res.data.name,
        color: res.data.color,
      });
      setQuery("");
      setActive(0);
      inputRef.current?.focus();
    });
  }

  function createAndSelectAction(name: string) {
    const { entityType, entityId, onApplied } = props as ActionProps;
    startTransition(async () => {
      const res = await applyTagAction({
        entityType,
        entityId,
        newTagName: name,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onApplied?.({
        id: res.data.id,
        name: res.data.name,
        color: res.data.color,
      });
      setQuery("");
      setActive(0);
      inputRef.current?.focus();
    });
  }

  function removeTagAction_(tagId: string) {
    const { entityType, entityId, onRemoved } = props as ActionProps;
    startTransition(async () => {
      const res = await removeTagAction({ entityType, entityId, tagId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onRemoved?.(tagId);
    });
  }

  function handleSelect(item: SelectedTag) {
    if (mode === "action") selectTagAction(item);
    else selectTagFormHidden(item);
  }

  function handleCreate(name: string) {
    if (mode === "action") createAndSelectAction(name);
    else void createAndSelectFormHidden(name);
  }

  function handleRemove(tagId: string) {
    if (mode === "action") removeTagAction_(tagId);
    else removeTagFormHidden(tagId);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (!item) return;
      if ("kind" in item) {
        if (item.kind === "create") handleCreate(item.name);
        // already-applied: Enter is a no-op (the item is informational).
        return;
      }
      handleSelect(item as SelectedTag);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      // Form-hidden mode: backspace pops the local-state chip (no
      // server call, fully reversible at submit). Action mode does
      // NOT support backspace-remove because it fires an immediate
      // server mutation; users must click the chip's × button to
      // make the destructive action deliberate.
      if (mode !== "action") {
        commitFormHidden(value.slice(0, -1));
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`flex flex-wrap items-center gap-1.5 rounded-md border border-glass-border bg-input/60 p-1.5 ${
          disabled ? "opacity-60" : ""
        }`}
      >
        {value.map((t) => (
          <TagChip
            key={t.id}
            name={t.name}
            color={t.color}
            onRemove={disabled ? undefined : () => handleRemove(t.id)}
            onClick={props.onTagClick ? () => props.onTagClick?.(t) : undefined}
          />
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          placeholder={
            disabled
              ? "You don't have permission to apply tags."
              : value.length === 0
                ? "Add tags…"
                : ""
          }
          className="min-w-[120px] flex-1 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
      </div>

      {mode === "form-hidden" && (props as FormHiddenProps).hiddenInputName ? (
        <input
          type="hidden"
          name={(props as FormHiddenProps).hiddenInputName}
          value={value.map((v) => v.id).join(",")}
        />
      ) : null}

      {open && !disabled && items.length > 0 ? (
        <div className="glass-surface glass-surface--3 absolute z-20 mt-1 w-full overflow-hidden rounded-md p-1 shadow-lg">
          {items.map((item, i) => {
            if ("kind" in item) {
              if (item.kind === "create") {
                return (
                  <button
                    key="__create"
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleCreate(item.name);
                    }}
                    className={
                      "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm " +
                      (active === i ? "bg-accent/40" : "hover:bg-accent/30")
                    }
                    onMouseEnter={() => setActive(i)}
                  >
                    <span>
                      Create{" "}
                      <span className="font-medium">
                        &ldquo;{item.name}&rdquo;
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Enter
                    </span>
                  </button>
                );
              }
              // kind === "already-applied" — informational, not clickable.
              return (
                <div
                  key="__already-applied"
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-muted-foreground"
                >
                  <span>
                    Already applied:{" "}
                    <span className="font-medium">
                      &ldquo;{item.name}&rdquo;
                    </span>
                  </span>
                </div>
              );
            }
            const tag = item as SelectedTag;
            return (
              <button
                key={tag.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(tag);
                }}
                onMouseEnter={() => setActive(i)}
                className={
                  "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm " +
                  (active === i ? "bg-accent/40" : "hover:bg-accent/30")
                }
              >
                <TagChip name={tag.name} color={tag.color} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
