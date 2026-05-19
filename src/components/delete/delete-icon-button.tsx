"use client";

import { Trash2 } from "lucide-react";
import {
  ConfirmDeleteDialog,
  type EntityKind,
  type RestorePath,
} from "./confirm-delete-dialog";
import { showUndoToast } from "./undo-toast";
import { toast } from "sonner";

/**
 * list-row trash icon. Hidden on desktop until the row's
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
  /**
   * Restore path the actor will use to recover the record. Threaded
   * to the confirm dialog so the copy is accurate: non-admin owners
   * see "from your notifications"; admins see "from the <e> archive".
   * Defaults to "notifications" — the universally-reachable path.
   */
  restorePath?: RestorePath;
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
  /**
   * Navigation to run AFTER the undo toast is enqueued. Detail pages
   * pass `() => router.push("/leads")`; list pages pass
   * `() => router.refresh()`. Kept separate from `onConfirm` so the
   * toast is always added to the (persistent) Toaster store before the
   * route transition starts — otherwise a detail-page `router.push`
   * races and the undo toast is never seen (the original bug).
   */
  onNavigate?: () => void;
}

export function DeleteIconButton(props: DeleteIconButtonProps) {
  if (!props.canDelete) return null;

  return (
    <ConfirmDeleteDialog
      entityKind={props.entityKind}
      entityName={props.entityName}
      extraBody={props.extraBody}
      restorePath={props.restorePath}
      onConfirm={async (reason) => {
        const res = await props.onConfirm(reason);
        if (!res.ok) {
          toast.error(res.error ?? "Archive failed.");
          return;
        }
        // Enqueue the toast BEFORE navigating. <Toaster> lives in the
        // persistent (app) layout so a queued toast survives a
        // push/refresh — but only if it is queued first.
        if (res.undoToken && props.onUndo) {
          const undoToken = res.undoToken;
          const onUndo = props.onUndo;
          showUndoToast({
            entityKind: props.entityKind,
            entityName: props.entityName,
            onUndo: () => onUndo(undoToken),
          });
        } else {
          toast.success("Archived.");
        }
        props.onNavigate?.();
      }}
      trigger={
        <button
          type="button"
          aria-label={`Archive ${props.entityKind}`}
          className="rounded-md p-1.5 text-muted-foreground/70 transition opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted hover:text-destructive focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring/40"
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
  if (!props.canDelete) return null;

  return (
    <ConfirmDeleteDialog
      entityKind={props.entityKind}
      entityName={props.entityName}
      extraBody={props.extraBody}
      restorePath={props.restorePath}
      onConfirm={async (reason) => {
        const res = await props.onConfirm(reason);
        if (!res.ok) {
          toast.error(res.error ?? "Archive failed.");
          return;
        }
        // Enqueue the toast BEFORE navigating. <Toaster> lives in the
        // persistent (app) layout so a queued toast survives a
        // push/refresh — but only if it is queued first.
        if (res.undoToken && props.onUndo) {
          const undoToken = res.undoToken;
          const onUndo = props.onUndo;
          showUndoToast({
            entityKind: props.entityKind,
            entityName: props.entityName,
            onUndo: () => onUndo(undoToken),
          });
        } else {
          toast.success("Archived.");
        }
        props.onNavigate?.();
      }}
      trigger={
        <button
          type="button"
          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30"
        >
          {props.label ?? "Archive"}
        </button>
      }
    />
  );
}
