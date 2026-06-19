"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send, Trash2 } from "lucide-react";
import { StandardConfirmDialog } from "@/components/standard";
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
 * State-dependent action buttons for the campaign detail
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
  // Send-now is authorized solely by the `canMarketingCampaignsSendNow`
  // permission in sendCampaignNowAction (the single authoritative gate),
  // matching the wizard and the public API route. Visibility here tracks
  // that permission only — gating the button additionally on isAdmin made
  // the detail UI imply an admin-only rule the action never enforced.
  void isAdmin;

  // Each confirm runs inside StandardConfirmDialog's onConfirm. The action
  // result is surfaced inline (matching the existing error <p>); the dialog
  // closes once the promise resolves. The startTransition wrapper keeps the
  // buttons in their pending state while the mutation is in flight.
  async function callCancel() {
    setError(null);
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        const res = await cancelCampaignAction(campaignId);
        if (!res.ok) {
          setError(res.error);
        } else {
          router.refresh();
        }
        resolve();
      });
    });
  }

  async function callSendNow() {
    setError(null);
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        const res = await sendCampaignNowAction(campaignId);
        if (!res.ok) {
          setError(res.error);
        } else {
          router.refresh();
        }
        resolve();
      });
    });
  }

  async function callDelete() {
    setError(null);
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        const res = await deleteCampaignAction(campaignId);
        if (!res.ok) {
          setError(res.error);
        } else {
          router.push("/marketing/campaigns");
        }
        resolve();
      });
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
          <StandardConfirmDialog
            trigger={
              <button
                type="button"
                disabled={pending}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            }
            title="Cancel this campaign?"
            body="Recipients will not receive it."
            confirmLabel="Cancel campaign"
            cancelLabel="Keep campaign"
            tone="destructive"
            onConfirm={callCancel}
          />
        ) : null}
        {canSendNow ? (
          <StandardConfirmDialog
            trigger={
              <button
                type="button"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
              >
                <Send className="h-4 w-4" aria-hidden />
                Send now
              </button>
            }
            title="Send this campaign now?"
            body="This cannot be undone once recipients start receiving emails."
            confirmLabel="Send now"
            onConfirm={callSendNow}
          />
        ) : null}
        {canDelete ? (
          <StandardConfirmDialog
            trigger={
              <button
                type="button"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </button>
            }
            title="Delete this campaign?"
            body="This cannot be undone."
            confirmLabel="Delete campaign"
            tone="destructive"
            onConfirm={callDelete}
          />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-[var(--status-lost-fg)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
