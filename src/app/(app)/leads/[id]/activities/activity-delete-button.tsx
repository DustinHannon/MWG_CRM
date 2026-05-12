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
