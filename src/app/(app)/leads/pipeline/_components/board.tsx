"use client";

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { formatPersonName } from "@/lib/format/person-name";
// Phase 9C — direct import (not the barrel) keeps the server-only
// UserHoverCard out of the client bundle.
import { UserAvatar } from "@/components/user-display/user-avatar";
import { updateLeadStatusAction } from "../actions";

interface Card {
  id: string;
  status: string;
  // Phase 8D Wave 4 (FIX-003) — OCC version stamp threaded through DnD.
  version: number;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  rating: string;
  // Phase 9C — owner id powers the canonical xs avatar on the card.
  ownerId: string | null;
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

  // Phase 12 Sub-E — Touch sensor with a small delay so a tap on a
  // card link still navigates; only a press-and-hold initiates a
  // drag on mobile. Pointer sensor stays as-is for desktop mouse.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
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
      const res = await updateLeadStatusAction(
        cardId,
        overStatus,
        card!.version,
      );
      if (!res.ok) {
        toast.error(res.error);
        // Roll back.
        setColumns((prev) => ({
          ...prev,
          [overStatus]: prev[overStatus].filter((c) => c.id !== cardId),
          [fromStatus!]: [card!, ...(prev[fromStatus!] ?? [])],
        }));
      } else {
        // Bump local version so a second drag of the same card carries
        // the new stamp; otherwise it would post the now-stale value
        // and the second move would fail the OCC check.
        const newVersion = res.data?.version;
        if (typeof newVersion === "number") {
          setColumns((prev) => ({
            ...prev,
            [overStatus]: prev[overStatus].map((c) =>
              c.id === cardId ? { ...c, version: newVersion } : c,
            ),
          }));
        }
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {/* Phase 12 Sub-E — horizontal scroll with snap so columns
          land aligned to viewport edges on a touch swipe. The
          snap-mandatory + snap-start on each column ensures a swipe
          doesn't leave the user mid-column. `[scrollbar-gutter:stable]`
          keeps the bottom scroll bar from disrupting layout when it
          appears. */}
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-gutter:stable]">
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
        // Phase 12 Sub-E — `snap-start` aligns each column to the
        // scroll container's left edge on swipe. Width unchanged so
        // existing desktop layouts continue to fit 4-5 columns
        // across a 1280px viewport.
        "flex w-[280px] shrink-0 snap-start flex-col rounded-lg border p-2 transition " +
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
          {formatPersonName(card)}
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
        {card.ownerId ? (
          // Phase 9C — avatar-only chip (xs/20px) for the dense card.
          // Wrapping <Link> intercepts the click so the parent draggable
          // doesn't treat it as a drag start; the card body link still
          // reaches /leads/[id] when clicked anywhere else.
          <Link
            href={`/users/${card.ownerId}`}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={card.ownerName ?? "Owner"}
            title={card.ownerName ?? undefined}
          >
            <UserAvatar
              user={{
                id: card.ownerId,
                displayName: card.ownerName,
                photoUrl: null,
              }}
              size="xs"
            />
          </Link>
        ) : null}
        {card.estimatedValue ? (
          <span className="ml-auto tabular-nums text-foreground/80">
            ${Number(card.estimatedValue).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
