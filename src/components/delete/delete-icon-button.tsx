"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { ConfirmDeleteDialog, type EntityKind } from "./confirm-delete-dialog";
import { showUndoToast } from "./undo-toast";
import { toast } from "sonner";

/**
 * Phase 10 — list-row trash icon. Hidden on desktop until the row's
 * parent `<tr class="group">` is hovered; always visible on mobile.
 *
 * Renders nothing if `canDelete` is false — no disabled-but-shown state.
 *
 * The parent row MUST have `className="group ..."` for hover to work.
 */
export interface DeleteIconButtonProps {
  entityKind: EntityKind;
  entityId: string;
  entityName: string;
  canDelete: boolean;
  /** Optional cascade hint for the modal body. */
  extraBody?: React.ReactNode;
  /**
   * Server action invoker. Returns the action result; success may
   * include `{ undoToken }` which we round-trip into the Undo toast.
   */
  onConfirm: (
    reason: string | undefined,
  ) => Promise<{ ok: boolean; error?: string; undoToken?: string }>;
  /**
   * Called by the toast Undo button. Receives the undoToken signed at
   * archive time; should call the matching `restoreXAction`.
   */
  onUndo?: (
    undoToken: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function DeleteIconButton(props: DeleteIconButtonProps) {
  const [, startTransition] = useTransition();
  if (!props.canDelete) return null;

  return (
    <ConfirmDeleteDialog
      entityKind={props.entityKind}
      entityName={props.entityName}
      extraBody={props.extraBody}
      onConfirm={async (reason) => {
        const res = await props.onConfirm(reason);
        if (!res.ok) {
          toast.error(res.error ?? "Archive failed.");
          return;
        }
        if (res.undoToken && props.onUndo) {
          const undoToken = res.undoToken;
          const onUndo = props.onUndo;
          startTransition(() => {
            showUndoToast({
              entityKind: props.entityKind,
              entityName: props.entityName,
              onUndo: () => onUndo(undoToken),
            });
          });
        } else {
          toast.success("Archived.");
        }
      }}
      trigger={
        <button
          type="button"
          aria-label={`Archive ${props.entityKind}`}
          className="rounded-md p-1.5 text-muted-foreground/70 transition opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted hover:text-rose-600 dark:hover:text-rose-300 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      }
    />
  );
}

/**
 * Detail-page Archive button. Same gating + dialog as DeleteIconButton
 * but with a labeled rose-tinted button matching the existing detail
 * action row (Edit / Print / Archive).
 */
export interface DeleteButtonProps extends DeleteIconButtonProps {
  label?: string;
}

export function DeleteButton(props: DeleteButtonProps) {
  const [, startTransition] = useTransition();
  if (!props.canDelete) return null;

  return (
    <ConfirmDeleteDialog
      entityKind={props.entityKind}
      entityName={props.entityName}
      extraBody={props.extraBody}
      onConfirm={async (reason) => {
        const res = await props.onConfirm(reason);
        if (!res.ok) {
          toast.error(res.error ?? "Archive failed.");
          return;
        }
        if (res.undoToken && props.onUndo) {
          const undoToken = res.undoToken;
          const onUndo = props.onUndo;
          startTransition(() => {
            showUndoToast({
              entityKind: props.entityKind,
              entityName: props.entityName,
              onUndo: () => onUndo(undoToken),
            });
          });
        } else {
          toast.success("Archived.");
        }
      }}
      trigger={
        <button
          type="button"
          className="rounded-md border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 px-3 py-1.5 text-sm text-rose-700 dark:text-rose-100 transition hover:bg-rose-500/30"
        >
          {props.label ?? "Archive"}
        </button>
      }
    />
  );
}
