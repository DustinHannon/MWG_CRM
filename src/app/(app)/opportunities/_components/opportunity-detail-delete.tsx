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
}: {
  opportunityId: string;
  opportunityName: string;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="opportunity"
      entityId={opportunityId}
      entityName={opportunityName}
      canDelete
      onConfirm={async (reason) => {
        const res = await softDeleteOpportunityAction({
          id: opportunityId,
          reason,
        });
        if (res.ok) {
          router.push("/opportunities");
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
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
