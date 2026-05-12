"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteListAction,
  refreshListAction,
} from "@/app/(app)/marketing/lists/actions";

/**
 * Client island for detail-page actions: refresh now,
 * archive. Edit is a plain link rendered by the server page.
 */
interface Props {
  listId: string;
  listName: string;
  // static lists don't have a filter to refresh, so the
  // "Refresh now" affordance is hidden for them.
  listType?: "dynamic" | "static_imported";
}

export function ListDetailActions({ listId, listName, listType }: Props) {
  const router = useRouter();
  const [pendingRefresh, startRefreshTransition] = useTransition();
  const [pendingDelete, startDeleteTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const isStatic = listType === "static_imported";

  function handleRefresh() {
    startRefreshTransition(async () => {
      const result = await refreshListAction(listId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { added, removed, total } = result.data;
      toast.success(
        `Refreshed: +${added}, -${removed}, total ${total.toLocaleString()}.`,
      );
      router.refresh();
    });
  }

  function handleDelete() {
    startDeleteTransition(async () => {
      const result = await deleteListAction(listId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("List archived.");
      setOpen(false);
      router.push("/marketing/lists");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {!isStatic ? (
        <button
          type="button"
          onClick={handleRefresh}
          disabled={pendingRefresh}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw
            className={
              pendingRefresh ? "h-4 w-4 animate-spin" : "h-4 w-4"
            }
            aria-hidden
          />
          {pendingRefresh ? "Refreshing…" : "Refresh now"}
        </button>
      ) : null}

      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Trigger asChild>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground/90 transition hover:bg-muted"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </button>
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              Archive this list?
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">{listName}</span>{" "}
                  will be hidden from the lists index. Members are preserved
                  for audit but the list cannot be used in new campaigns.
                </p>
              </div>
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  disabled={pendingDelete}
                  className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={handleDelete}
                disabled={pendingDelete}
                className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/30 disabled:opacity-50"
              >
                {pendingDelete ? "Archiving…" : "Archive"}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
