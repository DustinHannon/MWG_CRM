"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * bulk remap every activity carrying a particular
 * imported_by_name string to a specific app user. Sets userId +
 * createdById on the activity, clears importedByName, audits
 * affected row.
 *
 * Admin-only (requireAdmin gates the page; this action enforces
 * again at the server-action boundary).
 */

const remapSchema = z.object({
  importedByName: z.string().trim().min(1).max(200),
  newUserId: z.string().uuid(),
});

export async function remapImportedByNameAction(
  raw: z.infer<typeof remapSchema>,
): Promise<ActionResult<{ updated: number }>> {
  return withErrorBoundary(
    { action: "activities.imported_by.remapped" },
    async (): Promise<{ updated: number }> => {
      const session = await requireAdmin();
      const parsed = remapSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid remap input.");
      }

      // Verify the target user exists + is active.
      const [target] = await db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, parsed.data.newUserId))
        .limit(1);
      if (!target) throw new NotFoundError("user");
      if (!target.isActive) {
        throw new ValidationError(
          "Target user is inactive. Activate the user first or pick a different one.",
        );
      }

      // UPDATE every matching activity. Return ids so we can audit.
      const updated = await db
        .update(activities)
        .set({
          // userId is the single attribution column on activities;
          // setting it + clearing importedByName mirrors what the
          // import would have done if the name resolved on first
          // sight.
          userId: parsed.data.newUserId,
          importedByName: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(activities.importedByName, parsed.data.importedByName),
            isNull(activities.userId),
            eq(activities.isDeleted, false),
          ),
        )
        .returning({ id: activities.id });

      // Audit per affected row. audit-events doc lists this
      // canonical event name.
      for (const a of updated) {
        await writeAudit({
          actorId: session.id,
          action: "activities.imported_by.remapped",
          targetType: "activity",
          targetId: a.id,
          after: {
            importedByName: parsed.data.importedByName,
            newUserId: parsed.data.newUserId,
          },
        });
      }

      revalidatePath("/admin/imports/remap");
      return { updated: updated.length };
    },
  );
}
