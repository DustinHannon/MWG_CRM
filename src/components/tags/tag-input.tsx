"use client";

import { useEffect, useRef, useState } from "react";
import { TagChip } from "./tag-chip";
import { searchTagsAction, getOrCreateTagAction } from "./actions";

interface SelectedTag {
  id: string;
  name: string;
  color: string;
}

interface TagInputProps {
  /** Initial selected tags (rendered as chips). */
  value: SelectedTag[];
  onChange: (next: SelectedTag[]) => void;
  /** name + value pair are written to a hidden input so server actions
   * can read selected tag IDs from form data. */
  hiddenInputName?: string;
}

/**
 * Combobox-with-multiselect for tags. Type to search; "Create '<name>'"
 * appears as the last item when no exact match exists. Pressing Enter
 * with that highlighted creates the tag (default color slate) via a
 * server action.
 */
export function TagInput({ value, onChange, hiddenInputName }: TagInputProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SelectedTag[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Search on query change (debounced).
  useEffect(() => {
    const handle = setTimeout(async () => {
      const res = await searchTagsAction(query);
      if (!res.ok) return;
      // Filter out already-selected.
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
  const showCreate = query.trim().length > 0 && !exactMatch;
  const items = [
    ...results,
    ...(showCreate ? [{ kind: "create" as const, name: query.trim() }] : []),
  ];

  function selectTag(tag: SelectedTag) {
    if (value.some((v) => v.id === tag.id)) return;
    onChange([...value, tag]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }

  async function createAndSelect(name: string) {
    const res = await getOrCreateTagAction(name);
    if (res.ok && res.data) {
      const created = res.data;
      selectTag({ id: created.id, name: created.name, color: created.color });
    }
  }

  function removeTag(id: string) {
    onChange(value.filter((v) => v.id !== id));
  }

  async function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
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
      if ("kind" in item && item.kind === "create") {
        await createAndSelect(item.name);
      } else {
        selectTag(item as SelectedTag);
      }
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-glass-border bg-input/60 p-1.5">
        {value.map((t) => (
          <TagChip
            key={t.id}
            name={t.name}
            color={t.color}
            onRemove={() => removeTag(t.id)}
          />
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          placeholder={value.length === 0 ? "Add tags…" : ""}
          className="min-w-[120px] flex-1 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {hiddenInputName ? (
        <input
          type="hidden"
          name={hiddenInputName}
          value={value.map((v) => v.id).join(",")}
        />
      ) : null}

      {open && items.length > 0 ? (
        <div className="glass-surface glass-surface--3 absolute z-20 mt-1 w-full overflow-hidden rounded-md p-1 shadow-lg">
          {items.map((item, i) => {
            if ("kind" in item) {
              return (
                <button
                  key="__create"
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void createAndSelect(item.name);
                  }}
                  className={
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm " +
                    (active === i ? "bg-accent/40" : "hover:bg-accent/30")
                  }
                  onMouseEnter={() => setActive(i)}
                >
                  <span>
                    Create{" "}
                    <span className="font-medium">&ldquo;{item.name}&rdquo;</span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Enter
                  </span>
                </button>
              );
            }
            const tag = item as SelectedTag;
            return (
              <button
                key={tag.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectTag(tag);
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
