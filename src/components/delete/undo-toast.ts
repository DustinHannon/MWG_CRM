"use client";

import { toast } from "sonner";
import type { EntityKind } from "./confirm-delete-dialog";

const LABEL: Record<EntityKind, string> = {
  lead: "Lead",
  account: "Account",
  contact: "Contact",
  opportunity: "Opportunity",
  task: "Task",
  activity: "Activity",
  report: "Report",
};

/**
 * show the post-archive sonner toast with an Undo action.
 * The action runs `onUndo()` which the caller wires to its
 * `restore<Entity>Action({ undoToken })` server action.
 *
 * The toast lives 30 seconds. It is enqueued by the shared delete
 * component BEFORE the caller navigates (the <Toaster> is mounted in
 * the persistent app layout, so the queued toast survives a
 * push/refresh). The server undo token TTL (45s, soft-delete.ts) is
 * deliberately longer than this duration so a click while the toast is
 * still visible always validates.
 */
export function showUndoToast(args: {
  entityKind: EntityKind;
  entityName: string;
  onUndo: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const label = LABEL[args.entityKind];
  toast.success(`${label} "${args.entityName}" archived.`, {
    duration: 30000,
    action: {
      label: "Undo",
      onClick: async () => {
        const res = await args.onUndo();
        if (res.ok) {
          toast.success(`${label} restored.`);
        } else {
          toast.error(res.error ?? "Undo failed — restore from the archive view.");
        }
      },
    },
  });
}
