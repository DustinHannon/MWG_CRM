"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { DeleteIconButton } from "@/components/delete";
import {
  softDeleteAccountAction,
  undoArchiveAccountAction,
} from "../actions";

export function AccountRowActions({
  accountId,
  accountName,
  canDelete,
  isAdmin,
}: {
  accountId: string;
  accountName: string;
  canDelete: boolean;
  /** Drives the confirm-dialog restore-hint copy. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The list rows come from StandardListPage's TanStack infinite query;
  // router.refresh() only re-runs the server shell and does NOT refetch
  // that client cache, so the archived row would linger. Invalidate so
  // the list refetches and drops (archive) / restores (undo) the row.
  // Account archive cascades to linked contacts + opportunities, so
  // invalidate those lists too — otherwise the global 30s staleTime could
  // show archived children on a cached sibling list for up to 30s.
  const refreshList = () => {
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    router.refresh();
  };
  return (
    <DeleteIconButton
      entityKind="account"
      entityId={accountId}
      entityName={accountName}
      canDelete={canDelete}
      restorePath={isAdmin ? "archive" : "notifications"}
      extraBody={
        <p>
          Linked contacts and opportunities are archived with the account and
          restored together.
        </p>
      }
      onConfirm={async (reason) => {
        const res = await softDeleteAccountAction({ id: accountId, reason });
        if (res.ok) {
          return { ok: true, undoToken: res.data.undoToken };
        }
        return { ok: false, error: res.error };
      }}
      onNavigate={refreshList}
      onUndo={async (undoToken) => {
        const res = await undoArchiveAccountAction({ undoToken });
        if (res.ok) {
          refreshList();
          return { ok: true };
        }
        return { ok: false, error: res.error };
      }}
    />
  );
}
