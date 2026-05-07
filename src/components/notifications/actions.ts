"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { markAllRead, markRead } from "@/lib/notifications";

export async function markAllReadAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const session = await requireSession();
  try {
    await markAllRead(session.id);
    revalidatePath("/notifications");
    return { ok: true };
  } catch (err) {
    logger.error("notifications.mark_all_read_failed", {
      userId: session.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not mark notifications read." };
  }
}

export async function markReadAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  try {
    await markRead(id, session.id);
    revalidatePath("/notifications");
    return { ok: true };
  } catch (err) {
    logger.error("notifications.mark_read_failed", {
      userId: session.id,
      notificationId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not mark notification read." };
  }
}
