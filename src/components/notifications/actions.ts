"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { markAllRead } from "@/lib/notifications";
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

