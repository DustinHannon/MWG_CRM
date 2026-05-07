"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { savedViews } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";

const subscribeSchema = z.object({
  savedViewId: z.string().uuid(),
  frequency: z.enum(["daily", "weekly"]).default("daily"),
});

export async function subscribeToViewAction(
  raw: z.infer<typeof subscribeSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const parsed = subscribeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input." };
  }

  // Verify the user owns the saved view (anti-tamper).
  const [view] = await db
    .select({ id: savedViews.id, userId: savedViews.userId })
    .from(savedViews)
    .where(eq(savedViews.id, parsed.data.savedViewId))
    .limit(1);
  if (!view || view.userId !== session.id) {
    return { ok: false, error: "Saved view not found." };
  }

  try {
    await db
      .insert(savedSearchSubscriptions)
      .values({
        userId: session.id,
        savedViewId: parsed.data.savedViewId,
        frequency: parsed.data.frequency,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [
          savedSearchSubscriptions.userId,
          savedSearchSubscriptions.savedViewId,
        ],
        set: { frequency: parsed.data.frequency, isActive: true },
      });

    await writeAudit({
      actorId: session.id,
      action: "saved_search_subscription.subscribe",
      targetType: "saved_views",
      targetId: parsed.data.savedViewId,
      after: { frequency: parsed.data.frequency },
    });

    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error("subscription.subscribe_failed", {
      savedViewId: parsed.data.savedViewId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not subscribe." };
  }
}

export async function unsubscribeFromViewAction(
  savedViewId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  try {
    await db
      .delete(savedSearchSubscriptions)
      .where(
        and(
          eq(savedSearchSubscriptions.userId, session.id),
          eq(savedSearchSubscriptions.savedViewId, savedViewId),
        ),
      );

    await writeAudit({
      actorId: session.id,
      action: "saved_search_subscription.unsubscribe",
      targetType: "saved_views",
      targetId: savedViewId,
    });

    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error("subscription.unsubscribe_failed", {
      savedViewId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not unsubscribe." };
  }
}
