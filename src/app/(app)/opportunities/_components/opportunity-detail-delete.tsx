"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete";
import {
  softDeleteOpportunityAction,
  undoArchiveOpportunityAction,
} from "../actions";

export function OpportunityDetailDelete({
  opportunityId,
  opportunityName,
  isAdmin,
}: {
  opportunityId: string;
  opportunityName: string;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="opportunity"
      entityId={opportunityId}
      entityName={opportunityName}
      canDelete
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
      onNavigate={() => router.push("/opportunities")}
      onUndo={async (undoToken) => {
        const res = await undoArchiveOpportunityAction({ undoToken });
        if (res.ok) {
          router.push(`/opportunities/${opportunityId}`);
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
