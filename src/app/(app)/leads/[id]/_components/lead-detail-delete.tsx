"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete";
import {
  softDeleteLeadAction,
  undoArchiveLeadAction,
} from "../../actions";

/**
 * detail-page Archive trigger. After archive succeeds, the
 * server action revalidates `/leads`; we route the user there since the
 * just-archived lead would 404 if they reload.
 */
export function LeadDetailDelete({
  leadId,
  leadName,
  isAdmin,
}: {
  leadId: string;
  leadName: string;
  /**
   * Drives the confirm-dialog restore-hint copy: admins are sent to
   * the archive page; non-admin owners are sent to the notifications
   * bell + /notifications page (the path they can actually reach).
   */
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="lead"
      entityId={leadId}
      entityName={leadName}
      canDelete
      restorePath={isAdmin ? "archive" : "notifications"}
      extraBody={
        <p>
          Linked activities and tasks will be hidden along with it.
          They&rsquo;re restored together if the lead is restored.
        </p>
      }
      onConfirm={async (reason) => {
        const res = await softDeleteLeadAction({ id: leadId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={() => router.push("/leads")}
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
