"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  deleteTag,
  getOrCreateTag,
  searchTags,
  updateTag,
  type TagRow,
} from "@/lib/tags";
import { TAG_COLORS } from "@/db/schema/tags";
import { requireAdmin, requireSession } from "@/lib/auth-helpers";

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
    console.error("[tags] update failed", err);
    return { ok: false, error: "Could not update tag." };
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
    console.error("[tags] delete failed", err);
    return { ok: false, error: "Could not delete tag." };
  }
}
