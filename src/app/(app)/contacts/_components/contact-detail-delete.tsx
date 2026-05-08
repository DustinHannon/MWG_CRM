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
}: {
  contactId: string;
  contactName: string;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="contact"
      entityId={contactId}
      entityName={contactName}
      canDelete
      onConfirm={async (reason) => {
        const res = await softDeleteContactAction({ id: contactId, reason });
        if (res.ok) {
          router.push("/contacts");
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
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
