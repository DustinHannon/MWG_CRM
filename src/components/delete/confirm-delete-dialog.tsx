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
 * Phase 10 — canonical archive confirmation dialog. Wraps Radix
 * AlertDialog so the focus trap, ESC handling, and portal placement
 * come for free. Body copy is derived from `entityKind`; pass
 * `extraBody` for entity-specific cascade hints (e.g., "Its 14
 * activities and 3 tasks will be hidden too.").
 */
export interface ConfirmDeleteDialogProps {
  trigger: ReactNode;
  entityKind: EntityKind;
  entityName: string;
  /** Extra paragraph rendered before the standard archive-view hint. */
  extraBody?: ReactNode;
  /** Whether to show the optional reason textarea. Defaults true. */
  showReason?: boolean;
  /** Called with the reason string (or undefined) on Archive click. */
  onConfirm: (reason: string | undefined) => Promise<void>;
}

export function ConfirmDeleteDialog({
  trigger,
  entityKind,
  entityName,
  extraBody,
  showReason = true,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const label = ENTITY_LABEL[entityKind];

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
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        {/* Phase 12 Sub-E — `mwg-mobile-sheet` collapses the centered
            modal to a full-bleed bottom sheet at <640px; desktop
            ≥640px keeps the centered placement. */}
        <AlertDialog.Content className="mwg-mobile-sheet fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            Archive this {label}?
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{entityName}</span>{" "}
                will be hidden from active views.
              </p>
              {extraBody ? <div className="text-sm">{extraBody}</div> : null}
              <p className="text-xs text-muted-foreground/80">
                You can restore it from the {label} archive within 30 days, or
                click Undo on the toast that appears next.
              </p>
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
              className="rounded-md border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 px-3 py-1.5 text-sm text-rose-700 dark:text-rose-100 transition hover:bg-rose-500/30 disabled:opacity-50"
            >
              {pending ? "Archiving…" : "Archive"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * Hard-delete (admin-only) confirmation. Distinct from archive — this
 * is permanent. Used from archive views.
 */
export function ConfirmHardDeleteDialog({
  trigger,
  entityKind,
  entityName,
  onConfirm,
}: {
  trigger: ReactNode;
  entityKind: EntityKind;
  entityName: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const label = ENTITY_LABEL[entityKind];

  function handleConfirm() {
    startTransition(async () => {
      await onConfirm();
      setOpen(false);
    });
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <AlertDialog.Content className="mwg-mobile-sheet fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-rose-500/30 dark:border-rose-300/30 bg-background p-6 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-rose-700 dark:text-rose-300">
            Permanently delete this {label}?
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{entityName}</span>{" "}
                and all linked child data will be removed. This cannot be undone.
              </p>
              <p className="text-xs text-muted-foreground/80">
                A snapshot is written to the audit log before deletion.
              </p>
            </div>
          </AlertDialog.Description>
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
              className="rounded-md border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/30 px-3 py-1.5 text-sm text-rose-700 dark:text-rose-100 transition hover:bg-rose-500/40 disabled:opacity-50"
            >
              {pending ? "Deleting…" : "Delete forever"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
