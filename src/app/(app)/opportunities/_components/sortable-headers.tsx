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
import { setOpportunityAdhocColumnsAction } from "../view-actions";
import {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  type OpportunityColumnKey,
} from "@/lib/opportunity-view-constants";

/**
 * DnD column reorder on /opportunities. Wraps the server-rendered
 * table header row in a @dnd-kit SortableContext so each header can
 * be dragged horizontally. On drop, the new column order is persisted
 * via `setOpportunityAdhocColumnsAction`.
 */
export function SortableOpportunitiesHeaders({
  initialColumns,
  activeViewId,
}: {
  initialColumns: OpportunityColumnKey[];
  /** "saved:<uuid>" or "builtin:<key>" — passed through for future
   * saved-view persistence. */
  activeViewId: string;
}) {
  const [columns, setColumns] = useState<OpportunityColumnKey[]>(
    initialColumns,
  );
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = columns.indexOf(active.id as OpportunityColumnKey);
    const newIndex = columns.indexOf(over.id as OpportunityColumnKey);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(columns, oldIndex, newIndex);
    setColumns(next);
    const fd = new FormData();
    fd.set("payload", JSON.stringify({ columns: next }));
    void activeViewId;
    startTransition(async () => {
      const res = await setOpportunityAdhocColumnsAction(fd);
      if (!res.ok) {
        setColumns(columns);
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <thead>
      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
        {/* Leading selection checkbox cell (not draggable). */}
        <th className="w-10 px-2 py-3" aria-label="select" />
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
        <th className="w-10 px-2 py-3" aria-label="actions" />
      </tr>
    </thead>
  );
}

function SortableHeader({
  id,
  pending,
}: {
  id: OpportunityColumnKey;
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
      {AVAILABLE_OPPORTUNITY_COLUMNS.find((col) => col.key === id)?.label ??
        id}
    </th>
  );
}
