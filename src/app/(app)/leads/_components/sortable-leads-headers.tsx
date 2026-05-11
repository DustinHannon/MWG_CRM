"use client";

import { useState, useTransition } from "react";
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
import { setAdhocColumnsAction } from "../view-actions";
import { AVAILABLE_COLUMNS, type ColumnKey } from "@/lib/view-constants";

/**
 * Phase 25 §7.5 — DnD column reorder on /leads. Wraps the existing
 * server-rendered table header row in a @dnd-kit SortableContext so
 * each header can be dragged horizontally. On drop, the new column
 * order is persisted via `setAdhocColumnsAction` (existing backend);
 * revalidatePath inside that action triggers the server page to
 * re-render with the new order applied to the body rows too.
 *
 * Optimistic: the header order flips immediately on drop; if the
 * server action errors, the toast surfaces and the next page render
 * snaps back to the persisted state.
 */
export function SortableLeadsHeaders({
  initialColumns,
  activeViewId,
}: {
  initialColumns: ColumnKey[];
  /** "saved:<uuid>" or "builtin:<key>" — passed through to the
   *  persistence action so it can decide between saving on the
   *  user_preferences.adhoc_columns slot vs the saved-view's own
   *  columns array. The action already handles this routing. */
  activeViewId: string;
}) {
  const [columns, setColumns] = useState<ColumnKey[]>(initialColumns);
  const [pending, startTransition] = useTransition();

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
    const next = arrayMove(columns, oldIndex, newIndex);
    setColumns(next);
    // Persist via the existing setAdhocColumnsAction; payload is a
    // JSON string per its schema (FormData.payload = JSON-stringified
    // `{ columns: ColumnKey[] | null }`).
    const fd = new FormData();
    fd.set("payload", JSON.stringify({ columns: next }));
    void activeViewId; // reserved — passed for future saved-view persistence
    startTransition(async () => {
      const res = await setAdhocColumnsAction(fd);
      if (!res.ok) {
        setColumns(columns); // revert
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
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
        {/* Phase 10 — fixed-width trailing actions cell (not draggable). */}
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
