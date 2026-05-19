"use client";

import { useRouter } from "next/navigation";
import { DeleteIconButton } from "@/components/delete";
import {
  softDeleteContactAction,
  undoArchiveContactAction,
} from "../actions";

export function ContactRowActions({
  contactId,
  contactName,
  canDelete,
  isAdmin,
}: {
  contactId: string;
  contactName: string;
  canDelete: boolean;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteIconButton
      entityKind="contact"
      entityId={contactId}
      entityName={contactName}
      canDelete={canDelete}
      restorePath={isAdmin ? "archive" : "notifications"}
      onConfirm={async (reason) => {
        const res = await softDeleteContactAction({ id: contactId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={() => router.refresh()}
      onUndo={async (undoToken) => {
        const res = await undoArchiveContactAction({ undoToken });
        if (res.ok) {
          router.refresh();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
