"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import type { ActionResult } from "@/lib/server-action";

/**
 * Shared DnD column-reorder header row for every StandardListPage list
 * (leads / contacts / accounts / opportunities). One implementation so
 * the reorder rules can never drift per entity.
 *
 * Reorder rule:
 *  - Saved view: the drop persists the order into that saved view via
 *    `updateViewAction` (OCC) then router.refresh()es so the server
 *    re-renders body + header in the new order. Remembered.
 *  - Built-in / default view: the drop writes the order to the ?cols=
 *    URL param — the same mechanism the column picker uses — and is
 *    never written to the account or the view. A fresh visit, a reload
 *    without the param, or a view switch (which drops ?cols=) reverts
 *    to the view's default order.
 *
 * The call site keys this on the resolved column set
 * (`key={activeColumns.join(",")}`) so a stale set can't be dragged
 * into a save after a picker/view change.
 */
export interface SortableColumnHeadersProps<K extends string> {
  initialColumns: K[];
  /** "saved:<uuid>" or "builtin:<key>". */
  activeViewId: string;
  /** OCC version of the active saved view; absent for built-ins. */
  activeViewVersion?: number;
  /** Canonical column metadata for header label lookup. */
  columnDefs: ReadonlyArray<{ key: K; label: string }>;
  /** This entity's saved-view OCC update server action. */
  updateViewAction: (formData: FormData) => Promise<ActionResult<unknown>>;
  /** Leads has no leading select cell; the other lists do. */
  leadingSelectCell?: boolean;
}

export function SortableColumnHeaders<K extends string>({
  initialColumns,
  activeViewId,
  activeViewVersion,
  columnDefs,
  updateViewAction,
  leadingSelectCell = false,
}: SortableColumnHeadersProps<K>) {
  const [columns, setColumns] = useState<K[]>(initialColumns);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = columns.indexOf(active.id as K);
    const newIndex = columns.indexOf(over.id as K);
    if (oldIndex < 0 || newIndex < 0) return;
    // Ignore a drop while a prior saved-view save is still in flight so
    // back-to-back saves can't race the OCC version.
    if (pending) return;
    const next = arrayMove(columns, oldIndex, newIndex);
    const prev = columns;
    setColumns(next);

    if (!activeViewId.startsWith("saved:")) {
      // Built-in / default view: apply the reorder for this session via
      // the ?cols= URL param (the same mechanism the column picker
      // uses). Never written to the account/view, so a fresh visit or
      // a view switch (onPickView drops ?cols=) reverts to the default.
      const params = new URLSearchParams(searchParams.toString());
      params.set("cols", next.join(","));
      router.push(`${pathname}?${params.toString()}`);
      return;
    }

    // Saved view: persist into the saved view itself (same OCC path the
    // toolbar "Save changes" uses); activeViewVersion is the
    // server-fresh OCC token. Then refresh so the server re-renders the
    // body rows in the new order too (revalidatePath alone won't
    // re-render a mounted client route).
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
        {leadingSelectCell ? (
          <th className="w-10 px-2 py-3" aria-label="select" />
        ) : null}
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
              <SortableHeader
                key={c}
                id={c}
                label={columnDefs.find((m) => m.key === c)?.label ?? c}
                pending={pending}
              />
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
  label,
  pending,
}: {
  id: string;
  label: string;
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
      {label}
    </th>
  );
}
