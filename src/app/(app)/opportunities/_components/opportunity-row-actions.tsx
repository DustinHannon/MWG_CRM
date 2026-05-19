"use client";

import { useRouter } from "next/navigation";
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
      onNavigate={() => router.refresh()}
      onUndo={async (undoToken) => {
        const res = await undoArchiveOpportunityAction({ undoToken });
        if (res.ok) {
          router.refresh();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
