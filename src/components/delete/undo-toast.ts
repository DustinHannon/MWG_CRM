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
};

/**
 * show the post-archive sonner toast with an Undo action.
 * The action runs `onUndo()` which the caller wires to its
 * `restore<Entity>Action({ undoToken })` server action.
 *
 * The toast lives 5 seconds — after which the undo token also expires
 * server-side (HMAC `exp`), so a late click would fail validation.
 */
export function showUndoToast(args: {
  entityKind: EntityKind;
  entityName: string;
  onUndo: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const label = LABEL[args.entityKind];
  toast.success(`${label} "${args.entityName}" archived.`, {
    duration: 5000,
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
