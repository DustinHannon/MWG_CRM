"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useState, useTransition, type ReactNode } from "react";

/**
 * / §5.4 — canonical generic confirmation dialog.
 *
 * Generalises the existing `ConfirmDeleteDialog` (which is
 * entity-archive specific) for non-archive destructive actions:
 * cancel campaign, force-unlock template, reject batch, abort
 * import run, etc.
 *
 * Wraps Radix AlertDialog so focus trap, ESC handling, portal
 * placement, and aria attributes come for free. Pass `tone="destructive"`
 * to render the confirm button in destructive styling; default
 * `tone="primary"` keeps the standard accent.
 *
 * For "type the word to confirm" extreme-action gates, pass
 * `requireTypedConfirmation` with the word the user must type.
 */
export interface StandardConfirmDialogProps {
  /** Trigger element rendered inline; receives Radix's dialog-open binding. */
  trigger: ReactNode;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "destructive";
  /**
   * When set, an input box prompts the user to type this exact word
   * (case-sensitive) before the Confirm button enables. Use for
   * cross-the-Rubicon actions like "DELETE" or "PURGE".
   */
  requireTypedConfirmation?: string;
  /** Called on confirm. Dialog closes after the promise resolves. */
  onConfirm: () => Promise<void> | void;
  /** Optional callback when the user cancels (Cancel button or ESC). */
  onCancel?: () => void;
}

export function StandardConfirmDialog({
  trigger,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  requireTypedConfirmation,
  onConfirm,
  onCancel,
}: StandardConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();

  const typedOk =
    !requireTypedConfirmation || typed === requireTypedConfirmation;

  function handleConfirm() {
    if (!typedOk) return;
    startTransition(async () => {
      await onConfirm();
      setOpen(false);
      setTyped("");
    });
  }

  function handleOpenChange(next: boolean) {
    if (!next && !pending) {
      setTyped("");
      onCancel?.();
    }
    setOpen(next);
  }

  const confirmClass =
    tone === "destructive"
      ? "rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
      : "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <AlertDialog.Title className="text-sm font-semibold text-foreground">
            {title}
          </AlertDialog.Title>
          {body ? (
            <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
              {body}
            </AlertDialog.Description>
          ) : null}
          {requireTypedConfirmation ? (
            <div className="mt-3 space-y-1.5">
              <label className="block text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Type{" "}
                <span className="font-mono normal-case tracking-normal text-foreground">
                  {requireTypedConfirmation}
                </span>{" "}
                to confirm
              </label>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={pending || !typedOk}
              className={confirmClass}
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
