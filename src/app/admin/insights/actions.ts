"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth-helpers";

/**
 * Phase 26 §4 — manual cache bust for the Insights dashboard.
 *
 * Invalidates the page-level cache plus the `unstable_cache` layer
 * that `queryBetterStack` and `listRecentDeployments` sit on, so the
 * next render re-fetches from Better Stack and the Vercel API.
 */
export async function refreshInsightsAction(): Promise<void> {
  await requireAdmin();
  revalidatePath("/admin/insights");
}
