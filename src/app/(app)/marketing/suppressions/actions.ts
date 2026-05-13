"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Manual suppression add / remove from the admin UI.
 *
 * The system path (cron + webhook) still owns auto-suppressions from
 * SendGrid events. These actions are the operator-initiated
 * complement: an admin manually suppresses or un-suppresses an
 * address with a written reason for the audit trail.
 */

const addSchema = z.object({
  email: z.string().email().max(254),
  reason: z.string().trim().min(1).max(500),
});

const removeSchema = z.object({
  email: z.string().email().max(254),
  reason: z.string().trim().min(1).max(500),
});

export async function addSuppressionAction(
  input: unknown,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: MARKETING_AUDIT_EVENTS.SUPPRESSION_MANUALLY_ADDED },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin) {
        const perms = await getPermissions(user.id);
        if (!perms.canMarketingSuppressionsAdd) {
          throw new ForbiddenError(
            "You don't have permission to add suppressions.",
          );
        }
      }

      const parsed = addSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }

      const email = parsed.data.email.toLowerCase();

      // Dedup: refuse if any existing row (any source) already
      // suppresses this address. Surface a friendly error instead of
      // silently succeeding — operators need to know the address was
      // already on the list. INSERT … ON CONFLICT DO NOTHING is
      // race-safe (vs the SELECT-then-INSERT pattern, which lets two
      // concurrent admins both pass the existence check then collide
      // on PK); the empty RETURNING means the row was already present.
      const inserted = await db
        .insert(marketingSuppressions)
        .values({
          email,
          suppressionType: "manual",
          reason: parsed.data.reason,
          addedByUserId: user.id,
        })
        .onConflictDoNothing({ target: marketingSuppressions.email })
        .returning({ email: marketingSuppressions.email });
      if (inserted.length === 0) {
        throw new ConflictError("This email is already suppressed.");
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.SUPPRESSION_MANUALLY_ADDED,
        targetType: "marketing_suppression",
        targetId: email,
        after: {
          email,
          reason: parsed.data.reason,
        },
      });

      revalidatePath("/marketing/suppressions");
    },
  );
}

export async function removeSuppressionAction(
  input: unknown,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: MARKETING_AUDIT_EVENTS.SUPPRESSION_MANUALLY_REMOVED },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin) {
        const perms = await getPermissions(user.id);
        if (!perms.canMarketingSuppressionsRemove) {
          throw new ForbiddenError(
            "You don't have permission to remove suppressions.",
          );
        }
      }

      const parsed = removeSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }

      const email = parsed.data.email.toLowerCase();

      // Snapshot the row before delete so the audit row carries the
      // original source + when it was added.
      const [existing] = await db
        .select({
          email: marketingSuppressions.email,
          suppressionType: marketingSuppressions.suppressionType,
          suppressedAt: marketingSuppressions.suppressedAt,
        })
        .from(marketingSuppressions)
        .where(eq(marketingSuppressions.email, email))
        .limit(1);
      if (!existing) {
        throw new NotFoundError("suppression");
      }

      await db
        .delete(marketingSuppressions)
        .where(eq(marketingSuppressions.email, email));

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.SUPPRESSION_MANUALLY_REMOVED,
        targetType: "marketing_suppression",
        targetId: email,
        before: {
          email,
          originalSource: existing.suppressionType,
          originalAddedAt: existing.suppressedAt.toISOString(),
        },
        after: {
          reason: parsed.data.reason,
        },
      });

      revalidatePath("/marketing/suppressions");
    },
  );
}
