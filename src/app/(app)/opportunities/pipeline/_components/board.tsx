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
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
// Phase 9C — direct import (not the barrel) keeps the server-only
// UserHoverCard out of the client bundle.
import { UserAvatar } from "@/components/user-display/user-avatar";
import { updateOpportunityStageAction } from "../actions";
import {
  softDeleteOpportunityAction,
  undoArchiveOpportunityAction,
} from "../../actions";
import { ConfirmDeleteDialog, showUndoToast } from "@/components/delete";

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
  currentUserId,
  isAdmin,
}: {
  initialColumns: Record<string, Card[]>;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const canDelete = (c: Card) =>
    isAdmin || c.ownerId === currentUserId;

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

  function removeCard(cardId: string, fromStage: string) {
    setColumns((prev) => ({
      ...prev,
      [fromStage]: prev[fromStage].filter((c) => c.id !== cardId),
    }));
  }
  function reinsertCard(card: Card) {
    setColumns((prev) => ({
      ...prev,
      [card.stage]: [card, ...(prev[card.stage] ?? [])],
    }));
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
            canDelete={canDelete}
            onArchive={async (card) => {
              const original = card;
              removeCard(card.id, card.stage);
              const res = await softDeleteOpportunityAction({ id: card.id });
              if (!res.ok) {
                reinsertCard(original);
                toast.error(res.error);
                return;
              }
              const undoToken = res.data.undoToken;
              showUndoToast({
                entityKind: "opportunity",
                entityName: card.name,
                onUndo: async () => {
                  const u = await undoArchiveOpportunityAction({ undoToken });
                  if (u.ok) {
                    reinsertCard(original);
                    return { ok: true };
                  }
                  return { ok: false, error: u.error };
                },
              });
              router.refresh();
            }}
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
  canDelete,
  onArchive,
}: {
  id: StageId;
  label: string;
  cards: Card[];
  canDelete: (c: Card) => boolean;
  onArchive: (c: Card) => Promise<void>;
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
          <Card
            key={c.id}
            card={c}
            canDelete={canDelete(c)}
            onArchive={onArchive}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  card,
  canDelete,
  onArchive,
}: {
  card: Card;
  canDelete: boolean;
  onArchive: (c: Card) => Promise<void>;
}) {
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
      className="group/card relative cursor-grab rounded-md border border-glass-border bg-card p-3 text-sm shadow-sm active:cursor-grabbing"
    >
      {canDelete ? (
        // Phase 10 — hover-revealed trash icon, top-right of card.
        // Wrapped in a div that stops drag propagation so clicking
        // the icon doesn't initiate a drag.
        <div
          className="absolute right-1 top-1 opacity-100 md:opacity-0 md:group-hover/card:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ConfirmDeleteDialog
            entityKind="opportunity"
            entityName={card.name}
            onConfirm={async () => {
              await onArchive(card);
            }}
            trigger={
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label={`Archive ${card.name}`}
                className="rounded-md p-1 text-muted-foreground/70 hover:bg-muted hover:text-rose-600 dark:hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            }
          />
        </div>
      ) : null}
      <Link
        href={`/opportunities/${card.id}`}
        onClick={(e) => e.stopPropagation()}
        className="block pr-6 font-medium hover:underline"
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
