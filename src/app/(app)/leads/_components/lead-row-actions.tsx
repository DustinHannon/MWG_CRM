"use client";

import {
  softDeleteLeadAction,
  undoArchiveLeadAction,
} from "../actions";
import { DeleteIconButton } from "@/components/delete";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

/**
 * list-row delete trigger. Wraps the canonical
 * `<DeleteIconButton>` with the lead-specific server actions.
 */
export function LeadRowActions({
  leadId,
  leadName,
  canDelete,
  isAdmin,
}: {
  leadId: string;
  leadName: string;
  canDelete: boolean;
  /**
   * Drives the confirm-dialog restore-hint copy: admins are sent to
   * the /<e>/archived page; non-admin owners are sent to the
   * notifications bell + /notifications page (the path they can
   * actually reach).
   */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The list rows come from StandardListPage's TanStack infinite query
  // (queryKey ["leads", …]); router.refresh() only re-runs the server
  // shell and does NOT refetch that client cache, so the archived row
  // would linger until a view/filter change. Invalidate the query so the
  // list refetches and drops (archive) / restores (undo) the row.
  const refreshList = () => {
    void queryClient.invalidateQueries({ queryKey: ["leads"] });
    router.refresh();
  };
  return (
    <DeleteIconButton
      entityKind="lead"
      entityId={leadId}
      entityName={leadName}
      canDelete={canDelete}
      restorePath={isAdmin ? "archive" : "notifications"}
      onConfirm={async (reason) => {
        const res = await softDeleteLeadAction({ id: leadId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={refreshList}
      onUndo={async (undoToken) => {
        const res = await undoArchiveLeadAction({ undoToken });
        if (res.ok) {
          refreshList();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
