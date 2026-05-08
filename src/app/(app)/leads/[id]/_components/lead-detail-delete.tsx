"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete";
import {
  softDeleteLeadAction,
  undoArchiveLeadAction,
} from "../../actions";

/**
 * Phase 10 — detail-page Archive trigger. After archive succeeds, the
 * server action revalidates `/leads`; we route the user there since the
 * just-archived lead would 404 if they reload.
 */
export function LeadDetailDelete({
  leadId,
  leadName,
}: {
  leadId: string;
  leadName: string;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="lead"
      entityId={leadId}
      entityName={leadName}
      canDelete
      extraBody={
        <p>
          Linked activities and tasks will be hidden along with it.
          They&rsquo;re restored together if the lead is restored.
        </p>
      }
      onConfirm={async (reason) => {
        const res = await softDeleteLeadAction({ id: leadId, reason });
        if (res.ok) {
          router.push("/leads");
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onUndo={async (undoToken) => {
        const res = await undoArchiveLeadAction({ undoToken });
        if (res.ok) {
          router.push(`/leads/${leadId}`);
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
