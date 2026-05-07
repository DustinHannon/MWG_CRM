"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  bulkTagLeads,
  deleteTag,
  getOrCreateTag,
  searchTags,
  updateTag,
  type TagRow,
} from "@/lib/tags";
import { TAG_COLORS } from "@/db/schema/tags";
import { writeAudit } from "@/lib/audit";
import {
  requireAdmin,
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { ForbiddenError } from "@/lib/errors";
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
      const created = await getOrCreateTag(trimmed, "slate", session.id);
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
      // One audit row per lead — keeps the trail searchable per-record.
      // (Wave 4 FIX-019 will collapse to a single bulk insert.)
      for (const leadId of parsed.leadIds) {
        await writeAudit({
          actorId: session.id,
          action:
            parsed.operation === "add"
              ? "lead.tag_bulk_add"
              : "lead.tag_bulk_remove",
          targetType: "lead",
          targetId: leadId,
          after: { tagIds: parsed.tagIds },
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
