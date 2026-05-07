"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  bulkTagLeads,
  deleteTag,
  getOrCreateTag,
  searchTags,
  updateTag,
  type TagRow,
} from "@/lib/tags";
import { auditLog } from "@/db/schema/audit";
import { TAG_COLORS } from "@/db/schema/tags";
import { users } from "@/db/schema/users";
import { eq } from "drizzle-orm";
import {
  requireAdmin,
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tagName } from "@/lib/validation/primitives";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Server action wrappers around src/lib/tags.ts. searchTagsAction +
 * getOrCreateTagAction are callable by any signed-in user (used on the
 * lead create/edit form). updateTagAction + deleteTagAction are
 * admin-only (used on /admin/tags).
 */

interface PublicTag {
  id: string;
  name: string;
  color: string;
}

function strip(t: TagRow): PublicTag {
  return { id: t.id, name: t.name, color: t.color };
}

export async function searchTagsAction(
  query: string,
): Promise<ActionResult<PublicTag[]>> {
  return withErrorBoundary(
    { action: "tag.search" },
    async (): Promise<PublicTag[]> => {
      await requireSession();
      const rows = await searchTags(query);
      return rows.map(strip);
    },
  );
}

export async function getOrCreateTagAction(
  name: string,
): Promise<ActionResult<PublicTag | null>> {
  return withErrorBoundary(
    { action: "tag.get_or_create" },
    async (): Promise<PublicTag | null> => {
      const session = await requireSession();
      const trimmed = name.trim();
      if (trimmed.length === 0) return null;
      // Phase 8D Wave 7 (FIX-018) — apply the tagName primitive at the
      // boundary. Throws ValidationError via withErrorBoundary on bad
      // length/charset; closes F-038's lack of length/charset gates.
      const validated = tagName.parse(trimmed);
      const created = await getOrCreateTag(validated, "slate", session.id);
      return strip(created);
    },
  );
}

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60).optional(),
  color: z.enum(TAG_COLORS).optional(),
});

export async function updateTagAction(
  patch: z.infer<typeof updateSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "tag.update" }, async () => {
    const session = await requireAdmin();
    const parsed = updateSchema.parse(patch);
    await updateTag(parsed.id, parsed, session.id);
    revalidatePath("/admin/tags");
  });
}

/**
 * Phase 4E — bulk add or remove a list of tags across many leads.
 * Refuses the entire batch if the user lacks access to any of the leads.
 *
 * @actor signed-in user with edit access to every lead in the list.
 */
const bulkSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(1000),
  tagIds: z.array(z.string().uuid()).min(1),
  operation: z.enum(["add", "remove"]),
});

export interface BulkTagSummary {
  leadsTouched: number;
  tagsAdded: number;
  tagsRemoved: number;
}

export async function bulkTagLeadsAction(
  raw: z.infer<typeof bulkSchema>,
): Promise<ActionResult<BulkTagSummary>> {
  return withErrorBoundary(
    { action: "tag.bulk" },
    async (): Promise<BulkTagSummary> => {
      const session = await requireSession();
      const parsed = bulkSchema.parse(raw);
      // Fail-fast access check on every lead — refuse the whole batch.
      for (const id of parsed.leadIds) {
        try {
          await requireLeadAccess(session, id);
        } catch {
          throw new ForbiddenError(
            "You don't have access to one or more of the selected leads.",
          );
        }
      }
      const summary = await bulkTagLeads(
        parsed.leadIds,
        parsed.tagIds,
        parsed.operation,
        session.id,
      );
      // Phase 8D Wave 7 (FIX-019) — collapse N sequential writeAudit
      // calls into a single bulk INSERT. Resolves the actor email
      // snapshot once up front and constructs the row array, then
      // commits in one round-trip. Same per-lead audit shape; just
      // ~1000x faster for the max-batch case (1000 leads).
      const action =
        parsed.operation === "add"
          ? "lead.tag_bulk_add"
          : "lead.tag_bulk_remove";

      try {
        const [actor] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, session.id))
          .limit(1);
        const snapshot = actor?.email ?? null;
        const auditRows = parsed.leadIds.map((leadId) => ({
          actorId: session.id,
          actorEmailSnapshot: snapshot,
          action,
          targetType: "lead",
          targetId: leadId,
          afterJson: { tagIds: parsed.tagIds } as object,
        }));
        await db.insert(auditLog).values(auditRows);
      } catch (err) {
        // Best-effort, like writeAudit — never block the mutation it's
        // recording.
        logger.error("audit.bulk_write_failed", {
          action,
          leadCount: parsed.leadIds.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      return summary;
    },
  );
}

export async function deleteTagAction(id: string): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "tag.delete", entityType: "tag", entityId: id },
    async () => {
      const session = await requireAdmin();
      await deleteTag(id, session.id);
      revalidatePath("/admin/tags");
    },
  );
}
