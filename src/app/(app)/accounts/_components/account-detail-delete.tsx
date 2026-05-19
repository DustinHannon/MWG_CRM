"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete";
import {
  softDeleteAccountAction,
  undoArchiveAccountAction,
} from "../actions";

export function AccountDetailDelete({
  accountId,
  accountName,
  isAdmin,
}: {
  accountId: string;
  accountName: string;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      entityKind="account"
      entityId={accountId}
      entityName={accountName}
      canDelete
      restorePath={isAdmin ? "archive" : "notifications"}
      extraBody={
        <p>
          Linked Contacts and Opportunities are not cascaded — they remain
          visible but show an archived-account indicator.
        </p>
      }
      onConfirm={async (reason) => {
        const res = await softDeleteAccountAction({ id: accountId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={() => router.push("/accounts")}
      onUndo={async (undoToken) => {
        const res = await undoArchiveAccountAction({ undoToken });
        if (res.ok) {
          router.push(`/accounts/${accountId}`);
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
