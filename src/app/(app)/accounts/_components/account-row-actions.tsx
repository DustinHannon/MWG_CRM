"use client";

import { useRouter } from "next/navigation";
import { DeleteIconButton } from "@/components/delete";
import {
  softDeleteAccountAction,
  undoArchiveAccountAction,
} from "../actions";

export function AccountRowActions({
  accountId,
  accountName,
  canDelete,
}: {
  accountId: string;
  accountName: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteIconButton
      entityKind="account"
      entityId={accountId}
      entityName={accountName}
      canDelete={canDelete}
      extraBody={
        <p>
          Linked Contacts and Opportunities remain visible but show an
          archived-account indicator on their detail pages.
        </p>
      }
      onConfirm={async (reason) => {
        const res = await softDeleteAccountAction({ id: accountId, reason });
        if (res.ok) {
          router.refresh();
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onUndo={async (undoToken) => {
        const res = await undoArchiveAccountAction({ undoToken });
        if (res.ok) {
          router.refresh();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
