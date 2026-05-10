"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { formatDistanceToNow } from "date-fns";
import { Lock, Unlock } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

interface LockHolder {
  userId: string;
  userName: string;
  acquiredAt: Date;
}

interface LockedTemplateBannerProps {
  templateId: string;
  holder: LockHolder;
  isAdmin: boolean;
  onForceUnlock: () => Promise<void>;
}

/**
 * Phase 21 — Banner shown on the template editor page when another
 * user holds the soft-lock. Offers a read-only fallback link and an
 * admin "force unlock" affordance gated behind a Radix AlertDialog
 * (the same primitive `ConfirmDeleteDialog` uses, so the focus trap
 * and ESC handling come for free).
 */
export function LockedTemplateBanner({
  templateId,
  holder,
  isAdmin,
  onForceUnlock,
}: LockedTemplateBannerProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const distance = formatDistanceToNow(holder.acquiredAt, { addSuffix: false });

  function handleConfirm() {
    startTransition(async () => {
      await onForceUnlock();
      setOpen(false);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]">
          <Lock className="h-4 w-4" aria-hidden />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            {holder.userName} is currently editing this template
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            They started editing {distance} ago. Only one editor may make
            changes at a time so concurrent edits don&apos;t overwrite each
            other silently.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              href={`/marketing/templates/${templateId}`}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
            >
              View read-only
            </Link>
            {isAdmin ? (
              <AlertDialog.Root open={open} onOpenChange={setOpen}>
                <AlertDialog.Trigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30"
                  >
                    <Unlock className="h-3.5 w-3.5" aria-hidden />
                    Force unlock (admin)
                  </button>
                </AlertDialog.Trigger>
                <AlertDialog.Portal>
                  <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
                  <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
                    <AlertDialog.Title className="text-base font-semibold text-foreground">
                      Force unlock this template?
                    </AlertDialog.Title>
                    <AlertDialog.Description asChild>
                      <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                        <p>
                          The previous editor (
                          <span className="font-medium text-foreground">
                            {holder.userName}
                          </span>
                          ) will lose any unsaved work. This action is
                          recorded in the audit log.
                        </p>
                        <p className="text-xs text-muted-foreground/80">
                          Continue?
                        </p>
                      </div>
                    </AlertDialog.Description>
                    <div className="mt-5 flex justify-end gap-2">
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
                        className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/40 disabled:opacity-50"
                      >
                        {pending ? "Unlocking…" : "Force unlock"}
                      </button>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Portal>
              </AlertDialog.Root>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
