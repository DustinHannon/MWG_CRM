"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { markAllRead, markRead } from "@/lib/notifications";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export async function markAllReadAction(): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "notifications.mark_all_read" },
    async () => {
      const session = await requireSession();
      await markAllRead(session.id);
      revalidatePath("/notifications");
    },
  );
}

export async function markReadAction(id: string): Promise<ActionResult> {
  return withErrorBoundary(
    {
      action: "notifications.mark_read",
      entityType: "notification",
      entityId: id,
    },
    async () => {
      const session = await requireSession();
      await markRead(id, session.id);
      revalidatePath("/notifications");
    },
  );
}
