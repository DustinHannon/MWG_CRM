"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-helpers";

/**
 * Manual refresh for /admin/server-logs.
 *
 * The page is `revalidate = 60`, and every Better Stack query is
 * wrapped in `unstable_cache` with the same TTL. Clicking "Refresh"
 * busts both layers by calling `revalidatePath`, which marks the
 * route's cache entries stale; the next render re-queries Better
 * Stack and gets fresh rows.
 *
 * Admin-only — guarded by `requireAdmin`. The page already gates,
 * but the action also gates so the endpoint can't be POSTed from
 * a non-admin session.
 */
export async function refreshServerLogsAction(): Promise<void> {
  await requireAdmin();
  revalidatePath("/admin/server-logs");
}
