"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { savedViews } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { NotFoundError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const subscribeSchema = z.object({
  savedViewId: z.string().uuid(),
  frequency: z.enum(["daily", "weekly"]).default("daily"),
});

export async function subscribeToViewAction(
  raw: z.infer<typeof subscribeSchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "saved_search_subscription.subscribe" },
    async () => {
      const session = await requireSession();
      const parsed = subscribeSchema.parse(raw);

      // Verify the user owns the saved view (anti-tamper).
      const [view] = await db
        .select({ id: savedViews.id, userId: savedViews.userId })
        .from(savedViews)
        .where(eq(savedViews.id, parsed.savedViewId))
        .limit(1);
      if (!view || view.userId !== session.id) {
        throw new NotFoundError("saved view");
      }

      await db
        .insert(savedSearchSubscriptions)
        .values({
          userId: session.id,
          savedViewId: parsed.savedViewId,
          frequency: parsed.frequency,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [
            savedSearchSubscriptions.userId,
            savedSearchSubscriptions.savedViewId,
          ],
          set: { frequency: parsed.frequency, isActive: true },
        });

      await writeAudit({
        actorId: session.id,
        action: "saved_search_subscription.subscribe",
        targetType: "saved_views",
        targetId: parsed.savedViewId,
        after: { frequency: parsed.frequency },
      });

      revalidatePath("/settings");
    },
  );
}

export async function unsubscribeFromViewAction(
  savedViewId: string,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "saved_search_subscription.unsubscribe" },
    async () => {
      const session = await requireSession();
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
    },
  );
}
