"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-helpers";
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
    console.error("[notifications] markAllReadAction failed", err);
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
    console.error("[notifications] markReadAction failed", err);
    return { ok: false, error: "Could not mark notification read." };
  }
}
