"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete";
import {
  softDeleteContactAction,
  undoArchiveContactAction,
} from "../actions";

export function ContactDetailDelete({
  contactId,
  contactName,
  isAdmin,
}: {
  contactId: string;
  contactName: string;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="contact"
      entityId={contactId}
      entityName={contactName}
      canDelete
      restorePath={isAdmin ? "archive" : "notifications"}
      onConfirm={async (reason) => {
        const res = await softDeleteContactAction({ id: contactId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={() => router.push("/contacts")}
      onUndo={async (undoToken) => {
        const res = await undoArchiveContactAction({ undoToken });
        if (res.ok) {
          router.push(`/contacts/${contactId}`);
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
