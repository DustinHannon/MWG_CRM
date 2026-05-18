"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { updateViewAction } from "../view-actions";
import { AVAILABLE_COLUMNS, type ColumnKey } from "@/lib/view-constants";

/**
 * DnD column reorder for this list. Wraps the server-rendered header
 * row in a @dnd-kit SortableContext so each header can be dragged
 * horizontally.
 *
 * Persistence rule: the new order is remembered ONLY when the active
 * view is a saved view — the drop writes it into that view via the
 * shared OCC update action (the same path the toolbar "Save changes"
 * button uses) and then router.refresh()es so the server re-renders
 * with the body rows in the new order too. On built-in / default
 * views a drag is a no-op: they keep their default column order and
 * never persist a reorder.
 */
export function SortableLeadsHeaders({
  initialColumns,
  activeViewId,
  activeViewVersion,
}: {
  initialColumns: ColumnKey[];
  /** Active view id: "saved:<uuid>" or "builtin:<key>". Column order
   * is remembered only on saved views. */
  activeViewId: string;
  /** OCC version of the active saved view; absent for built-ins. */
  activeViewVersion?: number;
}) {
  const [columns, setColumns] = useState<ColumnKey[]>(initialColumns);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = columns.indexOf(active.id as ColumnKey);
    const newIndex = columns.indexOf(over.id as ColumnKey);
    if (oldIndex < 0 || newIndex < 0) return;
    // Ignore a drop while a prior reorder is still persisting so
    // back-to-back saves can't race the saved-view OCC version.
    if (pending) return;
    // Reorder is remembered only on saved views. On built-in/default
    // views the body rows stay server-driven, so reordering only the
    // header would desync the two — keep the default order instead.
    if (!activeViewId.startsWith("saved:")) return;
    const next = arrayMove(columns, oldIndex, newIndex);
    const prev = columns;
    setColumns(next);
    // Persist into the saved view itself (same OCC path the toolbar
    // "Save changes" uses); activeViewVersion is the server-fresh OCC
    // token. Then refresh so the server re-renders the body rows in
    // the new order too (revalidatePath alone won't re-render a
    // mounted client route).
    const fd = new FormData();
    fd.set("id", activeViewId.slice("saved:".length));
    fd.set("version", String(activeViewVersion ?? 1));
    fd.set("payload", JSON.stringify({ columns: next }));
    startTransition(async () => {
      const res = await updateViewAction(fd);
      if (!res.ok) {
        setColumns(prev);
        toast.error(res.error, { duration: Infinity, dismissible: true });
        return;
      }
      router.refresh();
    });
  }

  return (
    <thead>
      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={columns}
            strategy={horizontalListSortingStrategy}
          >
            {columns.map((c) => (
              <SortableHeader key={c} id={c} pending={pending} />
            ))}
          </SortableContext>
        </DndContext>
        {/* fixed-width trailing actions cell (not draggable). */}
        <th className="w-10 px-2 py-3" aria-label="actions" />
      </tr>
    </thead>
  );
}

function SortableHeader({
  id,
  pending,
}: {
  id: ColumnKey;
  pending: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: pending ? "wait" : "grab",
  } as const;
  return (
    <th
      ref={setNodeRef}
      style={style}
      className="px-5 py-3 font-medium whitespace-nowrap select-none"
      {...attributes}
      {...listeners}
    >
      {AVAILABLE_COLUMNS.find((col) => col.key === id)?.label ?? id}
    </th>
  );
}
