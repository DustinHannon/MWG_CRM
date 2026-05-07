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
import { logger } from "@/lib/logger";

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

export async function searchTagsAction(query: string): Promise<PublicTag[]> {
  await requireSession();
  const rows = await searchTags(query);
  return rows.map(strip);
}

export async function getOrCreateTagAction(
  name: string,
): Promise<PublicTag | null> {
  const session = await requireSession();
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const created = await getOrCreateTag(trimmed, "slate", session.id);
  return strip(created);
}

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60).optional(),
  color: z.enum(TAG_COLORS).optional(),
});

export async function updateTagAction(
  patch: z.infer<typeof updateSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = updateSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  try {
    await updateTag(parsed.data.id, parsed.data, session.id);
    revalidatePath("/admin/tags");
    return { ok: true };
  } catch (err) {
    logger.error("tag.update_failed", {
      tagId: parsed.data.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not update tag." };
  }
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

export async function bulkTagLeadsAction(
  raw: z.infer<typeof bulkSchema>,
): Promise<
  | { ok: true; leadsTouched: number; tagsAdded: number; tagsRemoved: number }
  | { ok: false; error: string }
> {
  const session = await requireSession();
  const parsed = bulkSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  // Fail-fast access check on every lead — refuse the whole batch.
  for (const id of parsed.data.leadIds) {
    try {
      await requireLeadAccess(session, id);
    } catch {
      return {
        ok: false,
        error: "You don't have access to one or more of the selected leads.",
      };
    }
  }
  try {
    const summary = await bulkTagLeads(
      parsed.data.leadIds,
      parsed.data.tagIds,
      parsed.data.operation,
      session.id,
    );
    // One audit row per lead — keeps the trail searchable per-record.
    for (const leadId of parsed.data.leadIds) {
      await writeAudit({
        actorId: session.id,
        action:
          parsed.data.operation === "add"
            ? "lead.tag_bulk_add"
            : "lead.tag_bulk_remove",
        targetType: "lead",
        targetId: leadId,
        after: { tagIds: parsed.data.tagIds },
      });
    }
    return { ok: true, ...summary };
  } catch (err) {
    logger.error("tag.bulk_failed", {
      operation: parsed.data.operation,
      leadCount: parsed.data.leadIds.length,
      tagCount: parsed.data.tagIds.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not apply bulk tag operation." };
  }
}

export async function deleteTagAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  try {
    await deleteTag(id, session.id);
    revalidatePath("/admin/tags");
    return { ok: true };
  } catch (err) {
    logger.error("tag.delete_failed", {
      tagId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not delete tag." };
  }
}
