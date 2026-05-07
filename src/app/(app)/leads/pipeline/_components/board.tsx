"use client";

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { updateLeadStatusAction } from "../actions";

interface Card {
  id: string;
  status: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
  rating: string;
  ownerName: string | null;
  estimatedValue: string | null;
  lastActivityAt: Date | null;
}

const STATUSES = [
  { id: "new", label: "New" },
  { id: "contacted", label: "Contacted" },
  { id: "qualified", label: "Qualified" },
  { id: "unqualified", label: "Unqualified" },
  { id: "lost", label: "Lost" },
] as const;

type StatusId = (typeof STATUSES)[number]["id"];

export function PipelineBoard({
  initialColumns,
}: {
  initialColumns: Record<string, Card[]>;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const cardId = String(active.id);
    const overStatus = String(over.id) as StatusId;

    let fromStatus: StatusId | null = null;
    let card: Card | null = null;
    for (const s of STATUSES) {
      const found = columns[s.id]?.find((c) => c.id === cardId);
      if (found) {
        fromStatus = s.id;
        card = found;
        break;
      }
    }
    if (!card || !fromStatus || fromStatus === overStatus) return;

    // Optimistic move.
    setColumns((prev) => ({
      ...prev,
      [fromStatus!]: prev[fromStatus!].filter((c) => c.id !== cardId),
      [overStatus]: [{ ...card!, status: overStatus }, ...(prev[overStatus] ?? [])],
    }));

    startTransition(async () => {
      const res = await updateLeadStatusAction(cardId, overStatus);
      if (!res.ok) {
        toast.error(res.error);
        // Roll back.
        setColumns((prev) => ({
          ...prev,
          [overStatus]: prev[overStatus].filter((c) => c.id !== cardId),
          [fromStatus!]: [card!, ...(prev[fromStatus!] ?? [])],
        }));
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STATUSES.map((s) => (
          <Column key={s.id} id={s.id} label={s.label} cards={columns[s.id] ?? []} />
        ))}
      </div>
    </DndContext>
  );
}

function Column({
  id,
  label,
  cards,
}: {
  id: StatusId;
  label: string;
  cards: Card[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const totalValue = useMemo(() => {
    return cards.reduce((sum, c) => sum + Number(c.estimatedValue ?? 0), 0);
  }, [cards]);

  return (
    <div
      ref={setNodeRef}
      className={
        "flex w-[280px] shrink-0 flex-col rounded-lg border p-2 transition " +
        (isOver
          ? "border-primary/50 bg-primary/5"
          : "border-glass-border bg-input/30")
      }
    >
      <div className="px-2 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {label} <span className="text-muted-foreground">· {cards.length}</span>
        </p>
        {totalValue > 0 ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            ${totalValue.toLocaleString()}
          </p>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {cards.map((c) => (
          <Card key={c.id} card={c} />
        ))}
        {cards.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">
            Drop here
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Card({ card }: { card: Card }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: card.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-md border border-glass-border bg-card p-3 text-sm shadow-sm transition active:cursor-grabbing"
    >
      <Link
        href={`/leads/${card.id}`}
        onClick={(e) => e.stopPropagation()}
        className="block"
      >
        <p className="font-medium text-foreground">
          {card.firstName} {card.lastName}
        </p>
        {card.companyName ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.companyName}
          </p>
        ) : null}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          className={
            "inline-block h-1.5 w-1.5 rounded-full " +
            (card.rating === "hot"
              ? "bg-destructive"
              : card.rating === "warm"
                ? "bg-amber-400"
                : "bg-blue-400")
          }
        />
        {card.ownerName ? <span>{card.ownerName}</span> : null}
        {card.estimatedValue ? (
          <span className="ml-auto tabular-nums text-foreground/80">
            ${Number(card.estimatedValue).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
