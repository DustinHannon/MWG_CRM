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
}: {
  opportunityId: string;
  opportunityName: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteIconButton
      entityKind="opportunity"
      entityId={opportunityId}
      entityName={opportunityName}
      canDelete={canDelete}
      onConfirm={async (reason) => {
        const res = await softDeleteOpportunityAction({
          id: opportunityId,
          reason,
        });
        if (res.ok) {
          router.refresh();
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
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
