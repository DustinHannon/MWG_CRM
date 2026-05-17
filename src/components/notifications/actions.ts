"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { markAllSeen } from "@/lib/notifications";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Clear the topbar bell badge by advancing the caller's last-seen
 * cursor (`user_preferences.notifications_last_seen_at`). Deliberately
 * does NOT mutate any notification row's is_read — the /notifications
 * activity log persists in full regardless of seen/read state.
 * Revalidates the app layout so the badge (countUnseen) recomputes on
 * the next render wherever the user currently is.
 */
export async function markAllSeenAction(): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "notifications.mark_all_seen" },
    async () => {
      const session = await requireSession();
      await markAllSeen(session.id);
      revalidatePath("/", "layout");
    },
  );
}
