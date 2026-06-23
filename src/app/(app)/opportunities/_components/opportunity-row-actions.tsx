"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { DeleteIconButton } from "@/components/delete";
import {
  softDeleteOpportunityAction,
  undoArchiveOpportunityAction,
} from "../actions";

export function OpportunityRowActions({
  opportunityId,
  opportunityName,
  canDelete,
  isAdmin,
}: {
  opportunityId: string;
  opportunityName: string;
  canDelete: boolean;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The list rows come from StandardListPage's TanStack infinite query;
  // router.refresh() only re-runs the server shell and does NOT refetch
  // that client cache, so the archived row would linger. Invalidate so the
  // list refetches and drops (archive) / restores (undo) the row.
  const refreshList = () => {
    void queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    router.refresh();
  };
  return (
    <DeleteIconButton
      entityKind="opportunity"
      entityId={opportunityId}
      entityName={opportunityName}
      canDelete={canDelete}
      restorePath={isAdmin ? "archive" : "notifications"}
      onConfirm={async (reason) => {
        const res = await softDeleteOpportunityAction({
          id: opportunityId,
          reason,
        });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={refreshList}
      onUndo={async (undoToken) => {
        const res = await undoArchiveOpportunityAction({ undoToken });
        if (res.ok) {
          refreshList();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
