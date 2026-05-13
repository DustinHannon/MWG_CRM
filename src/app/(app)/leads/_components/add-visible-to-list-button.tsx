"use client";

import { useTransition } from "react";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { ListPicker } from "@/components/marketing/list-picker";
import { bulkAddLeadsToListAction } from "@/app/(app)/marketing/lists/actions";

/**
 * Marketing bulk-action surface on the leads index.
 *
 * Surgical addition: no checkbox column today, so this acts on the set
 * of leads currently visible in the table (passed in as a prop). When
 * a real selection model lands later, swap `leadIds` source for the
 * selection set without touching the action wiring.
 *
 * Visibility is gated upstream by `canManage` (admin or
 * canMarketingListsBulkAdd) so the button never renders for users
 * without bulk-add permission.
 */
interface Props {
  leadIds: string[];
  canManage: boolean;
}

export function AddVisibleToListButton({ leadIds, canManage }: Props) {
  const [pending, startTransition] = useTransition();

  if (!canManage) return null;
  if (leadIds.length === 0) return null;

  function handleSelect(listId: string, listName: string) {
    startTransition(async () => {
      const result = await bulkAddLeadsToListAction({ listId, leadIds });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { added } = result.data;
      if (added === 0) {
        toast.info(`No new recipients added to "${listName}".`);
      } else {
        toast.success(
          `Added ${added.toLocaleString()} ${added === 1 ? "lead" : "leads"} to "${listName}".`,
        );
      }
    });
  }

  return (
    <ListPicker
      trigger={
        <button
          type="button"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
        >
          <ListPlus className="h-4 w-4" aria-hidden />
          {pending ? "Adding…" : "Add to marketing list"}
        </button>
      }
      onSelect={handleSelect}
    />
  );
}
