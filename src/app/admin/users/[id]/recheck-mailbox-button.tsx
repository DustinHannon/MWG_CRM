"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

interface MailboxState {
  kind: string | null;
  checkedAt: string | null;
}

interface RecheckMailboxButtonProps {
  userId: string;
  initialKind: string | null;
  initialCheckedAt: string | null;
}

/**
 * admin-only mailbox re-check. POSTs to the admin endpoint
 * (which forces past the 24h cache) and optimistically renders the new
 * resolution. The endpoint returns both the freshly-resolved `kind` and
 * the persisted `mailboxCheckedAt` so we don't need to revalidate the
 * page to see the update.
 */
export function RecheckMailboxButton({
  userId,
  initialKind,
  initialCheckedAt,
}: RecheckMailboxButtonProps) {
  const [state, setState] = useState<MailboxState>({
    kind: initialKind,
    checkedAt: initialCheckedAt,
  });
  const [isPending, startTransition] = useTransition();

  const click = () => {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/users/${userId}/recheck-mailbox`,
          { method: "POST" },
        );
        if (!res.ok) {
          let message = "Mailbox re-check failed.";
          try {
            const body = (await res.json()) as { message?: string };
            if (body?.message) message = body.message;
          } catch {
            /* swallow — fall through to default */
          }
          toast.error(message);
          return;
        }
        const body = (await res.json()) as {
          ok: boolean;
          kind: string;
          message?: string;
          mailboxKind?: string | null;
          mailboxCheckedAt?: string | null;
        };
        const nextKind = body.mailboxKind ?? body.kind;
        const nextChecked = body.mailboxCheckedAt ?? new Date().toISOString();
        setState({ kind: nextKind, checkedAt: nextChecked });
        if (body.ok) {
          toast.success(`Mailbox: ${formatKind(nextKind)}`);
        } else {
          toast.warning(
            body.message
              ? `${formatKind(nextKind)} — ${body.message}`
              : formatKind(nextKind),
          );
        }
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Mailbox re-check failed.",
        );
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Mailbox</span>
          <span className="font-medium text-foreground">
            {state.kind ? formatKind(state.kind) : "Not yet checked"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Last checked</span>
          <span className="text-foreground/80">
            {state.checkedAt ? formatStamp(state.checkedAt) : "Never"}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={click}
        disabled={isPending}
        className="self-start rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Re-checking…" : "Re-check mailbox"}
      </button>
    </div>
  );
}

function formatKind(kind: string): string {
  switch (kind) {
    case "exchange_online":
      return "Exchange Online";
    case "on_premises":
      return "On-premises Exchange";
    case "not_licensed":
      return "Not licensed";
    case "unknown":
      return "Unknown";
    default:
      return kind;
  }
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
