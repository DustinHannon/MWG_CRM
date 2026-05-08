"use client";

import {
  softDeleteLeadAction,
  undoArchiveLeadAction,
} from "../actions";
import { DeleteIconButton } from "@/components/delete";
import { useRouter } from "next/navigation";

/**
 * Phase 10 — list-row delete trigger. Wraps the canonical
 * `<DeleteIconButton>` with the lead-specific server actions.
 */
export function LeadRowActions({
  leadId,
  leadName,
  canDelete,
}: {
  leadId: string;
  leadName: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteIconButton
      entityKind="lead"
      entityId={leadId}
      entityName={leadName}
      canDelete={canDelete}
      onConfirm={async (reason) => {
        const res = await softDeleteLeadAction({ id: leadId, reason });
        if (res.ok) {
          router.refresh();
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
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
