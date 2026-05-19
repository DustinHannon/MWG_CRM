"use client";

import {
  softDeleteLeadAction,
  undoArchiveLeadAction,
} from "../actions";
import { DeleteIconButton } from "@/components/delete";
import { useRouter } from "next/navigation";

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
      onNavigate={() => router.refresh()}
      onUndo={async (undoToken) => {
        const res = await undoArchiveLeadAction({ undoToken });
        if (res.ok) {
          router.refresh();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
