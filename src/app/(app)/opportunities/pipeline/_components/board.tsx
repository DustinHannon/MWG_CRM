"use client";

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
// Phase 9C — direct import (not the barrel) keeps the server-only
// UserHoverCard out of the client bundle.
import { UserAvatar } from "@/components/user-display/user-avatar";
import { updateOpportunityStageAction } from "../actions";

interface Card {
  id: string;
  stage: string;
  // Phase 8D Wave 4 (FIX-004) — OCC version threaded through DnD.
  version: number;
  name: string;
  accountName: string | null;
  amount: string | null;
  // Phase 9C — owner id powers the canonical xs avatar on the card.
  ownerId: string | null;
  ownerName: string | null;
}

const STAGES = [
  { id: "prospecting", label: "Prospecting" },
  { id: "qualification", label: "Qualification" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "closed_won", label: "Closed Won" },
  { id: "closed_lost", label: "Closed Lost" },
] as const;

type StageId = (typeof STAGES)[number]["id"];

export function OppPipelineBoard({
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
    const overStage = String(over.id) as StageId;
    let fromStage: StageId | null = null;
    let card: Card | null = null;
    for (const s of STAGES) {
      const found = columns[s.id]?.find((c) => c.id === cardId);
      if (found) {
        fromStage = s.id;
        card = found;
        break;
      }
    }
    if (!card || !fromStage || fromStage === overStage) return;

    setColumns((prev) => ({
      ...prev,
      [fromStage!]: prev[fromStage!].filter((c) => c.id !== cardId),
      [overStage]: [{ ...card!, stage: overStage }, ...(prev[overStage] ?? [])],
    }));

    startTransition(async () => {
      const res = await updateOpportunityStageAction(
        cardId,
        overStage,
        card!.version,
      );
      if (!res.ok) {
        toast.error(res.error);
        setColumns((prev) => ({
          ...prev,
          [overStage]: prev[overStage].filter((c) => c.id !== cardId),
          [fromStage!]: [card!, ...(prev[fromStage!] ?? [])],
        }));
      } else {
        // Phase 8D — bump local version so a follow-up drag posts the
        // right stamp instead of the now-stale one.
        const newVersion = res.data?.version;
        if (typeof newVersion === "number") {
          setColumns((prev) => ({
            ...prev,
            [overStage]: prev[overStage].map((c) =>
              c.id === cardId ? { ...c, version: newVersion } : c,
            ),
          }));
        }
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((s) => (
          <Column
            key={s.id}
            id={s.id}
            label={s.label}
            cards={columns[s.id] ?? []}
          />
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
  id: StageId;
  label: string;
  cards: Card[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const total = cards.reduce((sum, c) => sum + Number(c.amount ?? 0), 0);

  return (
    <div
      ref={setNodeRef}
      className={
        "flex w-[260px] shrink-0 flex-col rounded-lg border p-2 transition " +
        (isOver
          ? "border-primary/50 bg-primary/5"
          : "border-glass-border bg-input/30")
      }
    >
      <div className="px-2 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wide">
          {label}{" "}
          <span className="text-muted-foreground">· {cards.length}</span>
        </p>
        {total > 0 ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            ${total.toLocaleString()}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((c) => (
          <Card key={c.id} card={c} />
        ))}
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
      className="cursor-grab rounded-md border border-glass-border bg-card p-3 text-sm shadow-sm active:cursor-grabbing"
    >
      <Link
        href={`/opportunities/${card.id}`}
        onClick={(e) => e.stopPropagation()}
        className="block font-medium hover:underline"
      >
        {card.name}
      </Link>
      {card.accountName ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {card.accountName}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        {card.ownerId ? (
          // Phase 9C — avatar-only chip (xs/20px) for the dense card.
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
        ) : (
          <span>—</span>
        )}
        {card.amount ? (
          <span className="tabular-nums text-foreground/80">
            ${Number(card.amount).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  );
}
