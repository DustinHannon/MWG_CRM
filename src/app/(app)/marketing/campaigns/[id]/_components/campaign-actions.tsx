"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send, Trash2 } from "lucide-react";
import {
  cancelCampaignAction,
  deleteCampaignAction,
  sendCampaignNowAction,
} from "../../actions";

interface CampaignActionsProps {
  campaignId: string;
  status: string;
  editable: boolean;
  canSchedule: boolean;
  canCancel: boolean;
  canSendNow: boolean;
  canDelete: boolean;
  isAdmin: boolean;
}

/**
 * Phase 21 — State-dependent action buttons for the campaign detail
 * page. The server component decides which buttons are visible; this
 * client component handles the optimistic UI + confirm dialogs.
 */
export function CampaignActions({
  campaignId,
  status,
  editable,
  canCancel,
  canSendNow,
  canDelete,
  isAdmin,
}: CampaignActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  void status;

  function callCancel() {
    if (!confirm("Cancel this campaign? Recipients will not receive it.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await cancelCampaignAction(campaignId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function callSendNow() {
    if (
      !confirm(
        "Send this campaign now? This cannot be undone once recipients start receiving emails.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await sendCampaignNowAction(campaignId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function callDelete() {
    if (!confirm("Delete this campaign? This cannot be undone.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteCampaignAction(campaignId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/marketing/campaigns");
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <Link
            href={`/marketing/campaigns/${campaignId}/edit`}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Edit
          </Link>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            disabled={pending}
            onClick={callCancel}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
        {canSendNow && isAdmin ? (
          <button
            type="button"
            disabled={pending}
            onClick={callSendNow}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" aria-hidden />
            Send now
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            disabled={pending}
            onClick={callDelete}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-[var(--status-lost-fg)]">{error}</p>
      ) : null}
    </div>
  );
}
