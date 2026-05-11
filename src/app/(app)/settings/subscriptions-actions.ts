"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { savedViews, userPreferences } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Phase 25 §7.2 — saved-view subscribe / unsubscribe / frequency-override
 * server actions. Two surfaces share this same `saved_search_subscriptions`
 * table:
 *
 *   - Leads view-toolbar (per-view Subscribe / Unsubscribe button)
 *   - Settings → Notifications (list of all active subs with per-row
 *     unsubscribe + per-row frequency override)
 *
 * The `notify_saved_search` user preference stays as the global kill
 * switch (off = no in-app notifications regardless of active subs).
 * `email_digest_frequency` stays as the user-wide default for new
 * subscriptions — when omitted from a subscribe call, this falls
 * back to that pref (or 'daily' if the user has 'off' as their
 * email default, since 'off' isn't valid as a per-subscription
 * cadence; the user can still suppress emails via the master
 * notify_saved_search toggle or via emailDigestFrequency='off').
 *
 * Digest delivery is via the user's own Microsoft 365 mailbox over
 * Graph API (see lib/digest-email.ts) — NOT SendGrid. Marketing
 * sends use SendGrid; transactional / per-user digests use Graph.
 */

const subscribeSchema = z.object({
  savedViewId: z.string().uuid(),
  frequency: z.enum(["daily", "weekly"]).optional(),
});

const updateFrequencySchema = z.object({
  savedViewId: z.string().uuid(),
  frequency: z.enum(["daily", "weekly"]),
});

const unsubscribeSchema = z.object({
  savedViewId: z.string().uuid(),
});

/**
 * Resolve the default frequency for a new subscription:
 *   - If the caller passed an explicit frequency → use it.
 *   - Else if user_preferences.email_digest_frequency is 'daily' or
 *     'weekly' → use that.
 *   - Else (user has 'off' or no row) → 'daily'.
 *
 * The fallback to 'daily' on 'off' is deliberate: a subscription
 * needs a cadence to be useful at all. If the user wants no emails,
 * the master notify_saved_search toggle (or keeping
 * email_digest_frequency='off') still suppresses email; the in-app
 * notification respects notify_saved_search.
 */
async function resolveDefaultFrequency(
  userId: string,
  explicit: "daily" | "weekly" | undefined,
): Promise<"daily" | "weekly"> {
  if (explicit) return explicit;
  const [prefs] = await db
    .select({ freq: userPreferences.emailDigestFrequency })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const fromPrefs = prefs?.freq;
  if (fromPrefs === "daily" || fromPrefs === "weekly") return fromPrefs;
  return "daily";
}

/**
 * Idempotent subscribe. UPSERT means clicking Subscribe twice
 * doesn't error and clicking Subscribe on a previously-unsubscribed
 * view (is_active=false) reactivates without re-creating.
 */
export async function subscribeToViewAction(
  raw: z.infer<typeof subscribeSchema>,
): Promise<ActionResult<{ subscriptionId: string; frequency: "daily" | "weekly" }>> {
  return withErrorBoundary(
    { action: "saved_search_subscription.subscribe" },
    async () => {
      const session = await requireSession();
      const parsed = subscribeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid subscription input.");
      }

      // Anti-tamper: the view must be owned by the caller.
      const [view] = await db
        .select({ id: savedViews.id, userId: savedViews.userId, name: savedViews.name })
        .from(savedViews)
        .where(eq(savedViews.id, parsed.data.savedViewId))
        .limit(1);
      if (!view || view.userId !== session.id) {
        throw new NotFoundError("saved view");
      }

      const frequency = await resolveDefaultFrequency(
        session.id,
        parsed.data.frequency,
      );

      const upserted = await db
        .insert(savedSearchSubscriptions)
        .values({
          userId: session.id,
          savedViewId: parsed.data.savedViewId,
          frequency,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [
            savedSearchSubscriptions.userId,
            savedSearchSubscriptions.savedViewId,
          ],
          set: { frequency, isActive: true },
        })
        .returning({ id: savedSearchSubscriptions.id });

      await writeAudit({
        actorId: session.id,
        action: "saved_search_subscription.subscribe",
        targetType: "saved_views",
        targetId: parsed.data.savedViewId,
        after: { frequency, viewName: view.name },
      });

      revalidatePath("/settings");
      revalidatePath("/leads");
      return { subscriptionId: upserted[0]!.id, frequency };
    },
  );
}

/**
 * Soft unsubscribe — sets is_active=false rather than deleting. Keeps
 * the row so the cron's `last_seen_max_created_at` cursor isn't lost
 * if the user resubscribes later. Use the UI list on the settings
 * page to fully remove if desired.
 */
export async function unsubscribeFromViewAction(
  raw: z.infer<typeof unsubscribeSchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "saved_search_subscription.unsubscribe" },
    async () => {
      const session = await requireSession();
      const parsed = unsubscribeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid unsubscribe input.");
      }

      // UPDATE is no-op if no matching row; explicitly idempotent.
      await db
        .update(savedSearchSubscriptions)
        .set({ isActive: false })
        .where(
          and(
            eq(savedSearchSubscriptions.userId, session.id),
            eq(savedSearchSubscriptions.savedViewId, parsed.data.savedViewId),
          ),
        );

      await writeAudit({
        actorId: session.id,
        action: "saved_search_subscription.unsubscribe",
        targetType: "saved_views",
        targetId: parsed.data.savedViewId,
      });

      revalidatePath("/settings");
      revalidatePath("/leads");
    },
  );
}

/**
 * Update a single subscription's frequency. Used by the per-row
 * dropdown on the settings page. No effect on other subscriptions
 * or the user's global default.
 */
export async function updateSubscriptionFrequencyAction(
  raw: z.infer<typeof updateFrequencySchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "saved_search_subscription.frequency_update" },
    async () => {
      const session = await requireSession();
      const parsed = updateFrequencySchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid frequency input.");
      }

      const result = await db
        .update(savedSearchSubscriptions)
        .set({ frequency: parsed.data.frequency })
        .where(
          and(
            eq(savedSearchSubscriptions.userId, session.id),
            eq(savedSearchSubscriptions.savedViewId, parsed.data.savedViewId),
          ),
        )
        .returning({ id: savedSearchSubscriptions.id });

      if (result.length === 0) {
        throw new NotFoundError("subscription");
      }

      await writeAudit({
        actorId: session.id,
        action: "saved_search_subscription.frequency_update",
        targetType: "saved_views",
        targetId: parsed.data.savedViewId,
        after: { frequency: parsed.data.frequency },
      });

      revalidatePath("/settings");
    },
  );
}
