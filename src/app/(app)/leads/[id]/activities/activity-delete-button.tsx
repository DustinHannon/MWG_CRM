"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  softDeleteActivityAction,
  undoArchiveActivityAction,
} from "./actions";
import { ConfirmDeleteDialog, showUndoToast } from "@/components/delete";

/**
 * activity timeline-card delete trigger. Hover-revealed
 * top-right of the card. Calls softDeleteActivityAction; recompute of
 * `last_activity_at` happens server-side. Undo restores both the
 * activity and the recomputed parent timestamp.
 */
export function ActivityDeleteButton({
  activityId,
  activityName,
}: {
  activityId: string;
  activityName: string;
}) {
  const router = useRouter();
  return (
    <ConfirmDeleteDialog
      entityKind="activity"
      entityName={activityName}
      // Activities do not emit a persistent archive notification
      // (they are timeline entries on a parent record) AND no
      // /activities/archived page exists. Both built-in restore
      // paths would misdirect the user — "none" keeps the dialog
      // honest; the undo toast is the only restore on this surface
      // (L-11 sibling of M-4).
      restorePath="none"
      extraBody={
        <p>
          The parent record&rsquo;s last-activity timestamp will recompute.
        </p>
      }
      onConfirm={async () => {
        const res = await softDeleteActivityAction({ activityId });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const undoToken = res.data.undoToken;
        showUndoToast({
          entityKind: "activity",
          entityName: activityName,
          onUndo: async () => {
            const u = await undoArchiveActivityAction({ undoToken });
            if (u.ok) {
              router.refresh();
              return { ok: true };
            }
            return { ok: false, error: u.error };
          },
        });
        router.refresh();
      }}
      trigger={
        <button
          type="button"
          aria-label={`Archive activity ${activityName}`}
          className="rounded-md p-1.5 text-muted-foreground/70 transition hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      }
    />
  );
}
