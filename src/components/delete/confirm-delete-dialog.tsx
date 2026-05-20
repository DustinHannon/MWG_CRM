"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useState, useTransition, type ReactNode } from "react";

export type EntityKind =
  | "lead"
  | "account"
  | "contact"
  | "opportunity"
  | "task"
  | "activity";

const ENTITY_LABEL: Record<EntityKind, string> = {
  lead: "lead",
  account: "account",
  contact: "contact",
  opportunity: "opportunity",
  task: "task",
  activity: "activity",
};

/**
 * Where the user can find this entity to restore it. Drives the
 * restore-hint copy in the dialog body. Defaults to "notifications"
 * — the path every authenticated user can reach. Callers explicitly
 * pass "archive" only when the user is an admin (the /<e>/archived
 * page is admin-only). "none" omits the restore hint entirely — used
 * for surfaces that do NOT emit a persistent archive prompt AND do
 * NOT have an admin-archive page (e.g. reports, activities); the
 * undo toast remains the only restore path on those surfaces.
 */
export type RestorePath = "notifications" | "archive" | "none";

/**
 * canonical archive confirmation dialog. Wraps Radix
 * AlertDialog so the focus trap, ESC handling, and portal placement
 * come for free. Body copy is derived from `entityKind`; pass
 * `extraBody` for entity-specific cascade hints (e.g., "Its 14
 * activities and 3 tasks will be hidden too.").
 *
 * Supports both single-row and bulk callers: pass `count` > 1 for
 * the bulk variant — the title pluralizes the label and the body
 * shows "N <label>s" instead of the single name. `entityName` is
 * still required for single-row callers and ignored for bulk.
 */
export interface ConfirmDeleteDialogProps {
  trigger: ReactNode;
  entityKind: EntityKind;
  entityName: string;
  /**
   * Number of records being archived. Defaults to 1 (single-row
   * surfaces). Pass the selection size for bulk surfaces; the title
   * and body switch to pluralized copy automatically.
   */
  count?: number;
  /** Extra paragraph rendered before the standard archive-view hint. */
  extraBody?: ReactNode;
  /** Whether to show the optional reason textarea. Defaults true. */
  showReason?: boolean;
  /**
   * Where the actor can self-restore: "notifications" for non-admin
   * owners (the persistent archive prompt in the bell + /notifications
   * page), "archive" for admins (the /<e>/archived page), or "none"
   * for surfaces that do not emit a persistent prompt AND have no
   * admin-archive page (the undo toast is the only restore path).
   * Defaults to "notifications" — the universally-reachable path.
   */
  restorePath?: RestorePath;
  /** Called with the reason string (or undefined) on Archive click. */
  onConfirm: (reason: string | undefined) => Promise<void>;
}

export function ConfirmDeleteDialog({
  trigger,
  entityKind,
  entityName,
  count = 1,
  extraBody,
  showReason = true,
  restorePath = "notifications",
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const label = ENTITY_LABEL[entityKind];
  const isBulk = count > 1;
  const pluralLabel = `${label}s`;
  // Restore-hint copy varies by destination. "none" omits it entirely
  // (surfaces with no archive page and no persistent prompt — only
  // the undo toast is offered).
  const restoreHint =
    restorePath === "none"
      ? `You can click Undo on the toast that appears next.`
      : restorePath === "archive"
      ? `You can restore ${isBulk ? "them" : "it"} from the ${label} archive within 30 days, or click Undo on the toast that appears next.`
      : `You can restore ${isBulk ? "them" : "it"} from your notifications within 30 days, or click Undo on the toast that appears next.`;

  function handleConfirm() {
    startTransition(async () => {
      await onConfirm(reason.trim() || undefined);
      setOpen(false);
      setReason("");
    });
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        {/* `mwg-mobile-sheet` collapses the centered
            modal to a full-bleed bottom sheet at <640px; desktop
            ≥640px keeps the centered placement.
            fade only (no zoom/slide) so the centering
            translates aren't fought by tw-animate-css's enter/exit
            transforms. */}
        <AlertDialog.Content className="mwg-mobile-sheet fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            {isBulk
              ? `Archive ${count} ${pluralLabel}?`
              : `Archive this ${label}?`}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>
                {isBulk ? (
                  <>
                    <span className="font-medium text-foreground">
                      {count} {pluralLabel}
                    </span>{" "}
                    will be hidden from active views.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">
                      {entityName}
                    </span>{" "}
                    will be hidden from active views.
                  </>
                )}
              </p>
              {extraBody ? <div className="text-sm">{extraBody}</div> : null}
              <p className="text-xs text-muted-foreground/80">{restoreHint}</p>
            </div>
          </AlertDialog.Description>

          {showReason ? (
            <label className="mt-4 block text-xs uppercase tracking-wider text-muted-foreground">
              Reason (optional)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                className="mt-1 w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                placeholder="e.g., duplicate, bad data"
              />
            </label>
          ) : null}

          <div className="mwg-mobile-sheet-actions mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={pending}
              className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
            >
              {pending ? "Archiving…" : "Archive"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

