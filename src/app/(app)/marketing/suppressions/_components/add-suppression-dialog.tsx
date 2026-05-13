"use client";

import { useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { addSuppressionAction } from "../actions";

/**
 * Operator-initiated add-suppression dialog. Visibility is gated by
 * the caller (parent page only renders this when canMarketingSuppressionsAdd
 * is true or the user is admin).
 */
export function AddSuppressionDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !pending && email.trim().length > 0 && reason.trim().length > 0;

  function reset(): void {
    setEmail("");
    setReason("");
    setError(null);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    setOpen(next);
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await addSuppressionAction({
          email: email.trim(),
          reason: reason.trim(),
        });
        if (!result.ok) {
          setError(result.error ?? "Add failed.");
          return;
        }
        toast.success("Suppression added.");
        reset();
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Add failed.");
      }
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" aria-hidden /> Add suppression
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Title className="text-sm font-semibold text-foreground">
            Add suppression
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Manually suppress an email from receiving marketing sends.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="suppression-email"
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                Email
              </label>
              <input
                id="suppression-email"
                name="email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
                className="min-h-[44px] rounded-md border border-border bg-input px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="name@example.com"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="suppression-reason"
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                Reason
              </label>
              <textarea
                id="suppression-reason"
                name="reason"
                required
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
                className="rounded-md border border-border bg-input px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Why is this email being suppressed? Required for audit trail."
              />
              <span className="text-[10px] text-muted-foreground/70">
                {reason.length} / 500
              </span>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-xs text-[var(--status-lost-fg)]"
              >
                {error}
              </div>
            ) : null}

            <div className="mt-2 flex justify-end gap-2">
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
                type="submit"
                disabled={!canSubmit}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
