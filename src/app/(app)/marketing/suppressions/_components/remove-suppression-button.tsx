"use client";

import { useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { removeSuppressionAction } from "../actions";

interface RemoveSuppressionButtonProps {
  email: string;
  source: string;
  suppressedAt: string;
  onRemoved?: () => void;
}

/**
 * Per-row remove control. Confirmation dialog requires a typed reason
 * before the Remove button enables — the reason is captured in the
 * audit row so future investigators can see WHY an address was
 * re-subscribed.
 */
export function RemoveSuppressionButton({
  email,
  source,
  suppressedAt,
  onRemoved,
}: RemoveSuppressionButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !pending && reason.trim().length > 0;

  function handleOpenChange(next: boolean): void {
    if (!next) {
      setReason("");
      setError(null);
    }
    setOpen(next);
  }

  function handleConfirm(): void {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await removeSuppressionAction({
          email,
          reason: reason.trim(),
        });
        if (!result.ok) {
          setError(result.error ?? "Remove failed.");
          return;
        }
        toast.success("Suppression removed.");
        setOpen(false);
        setReason("");
        onRemoved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Remove failed.");
      }
    });
  }

  const dateLabel = new Date(suppressedAt).toLocaleDateString();

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`Remove suppression for ${email}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Title className="text-sm font-semibold text-foreground">
            Remove from suppression?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-muted-foreground">
            This effectively re-subscribes{" "}
            <span className="font-mono text-foreground">{email}</span>. They
            previously hit {source} on {dateLabel}. Confirm they have
            requested to opt back in or that this is a correction of an
            error.
          </Dialog.Description>

          <div className="mt-4 flex flex-col gap-1">
            <label
              htmlFor={`remove-reason-${email}`}
              className="text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              Reason
            </label>
            <textarea
              id={`remove-reason-${email}`}
              required
              maxLength={500}
              rows={3}
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              className="rounded-md border border-border bg-input px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Customer called requesting re-subscription, false-positive bounce, etc."
            />
            <span className="text-[10px] text-muted-foreground/70">
              {reason.length} / 500
            </span>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-xs text-[var(--status-lost-fg)]"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleConfirm}
              className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
