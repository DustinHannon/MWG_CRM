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
}: {
  contactId: string;
  contactName: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteIconButton
      entityKind="contact"
      entityId={contactId}
      entityName={contactName}
      canDelete={canDelete}
      onConfirm={async (reason) => {
        const res = await softDeleteContactAction({ id: contactId, reason });
        if (res.ok) {
          router.refresh();
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
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
