import "server-only";
import { eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leadTags, tags, TAG_COLORS, type TagColor } from "@/db/schema/tags";
import { writeAudit } from "@/lib/audit";

export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.enum(TAG_COLORS).optional(),
});

export type TagRow = typeof tags.$inferSelect;

export async function listTags(): Promise<TagRow[]> {
  return db.select().from(tags).orderBy(tags.name);
}

export async function searchTags(query: string, limit = 8): Promise<TagRow[]> {
  const q = query.trim();
  if (q.length === 0) {
    return db.select().from(tags).orderBy(tags.name).limit(limit);
  }
  return db
    .select()
    .from(tags)
    .where(ilike(tags.name, `%${q}%`))
    .orderBy(tags.name)
    .limit(limit);
}

/**
 * Find an existing tag by name (case-insensitive) or create it.
 * Returns the tag id. Used by lead create/edit when the user types
 * a new tag name.
 */
export async function getOrCreateTag(
  name: string,
  color: TagColor = "slate",
  createdById: string | null,
): Promise<TagRow> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("Tag name is empty");

  const existing = await db
    .select()
    .from(tags)
    .where(ilike(tags.name, trimmed))
    .limit(1);
  if (existing[0]) return existing[0];

  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const finalSlug =
    slug.length === 0 ? `tag-${Math.random().toString(16).slice(2, 10)}` : slug;

  const inserted = await db
    .insert(tags)
    .values({
      name: trimmed,
      slug: finalSlug,
      color,
      createdById,
    })
    .returning();
  return inserted[0];
}

export async function updateTag(
  id: string,
  patch: { name?: string; color?: TagColor },
  actorId: string,
): Promise<void> {
  const before = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  await db
    .update(tags)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(tags.id, id));
  await writeAudit({
    actorId,
    action: "tag.update",
    targetType: "tags",
    targetId: id,
    before: before[0] ?? null,
    after: patch,
  });
}

export async function deleteTag(id: string, actorId: string): Promise<void> {
  const before = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  await db.delete(tags).where(eq(tags.id, id));
  await writeAudit({
    actorId,
    action: "tag.delete",
    targetType: "tags",
    targetId: id,
    before: before[0] ?? null,
  });
}

export async function setLeadTags(
  leadId: string,
  tagIds: string[],
  actorId: string,
): Promise<void> {
  const unique = Array.from(new Set(tagIds));
  await db.transaction(async (tx) => {
    await tx.delete(leadTags).where(eq(leadTags.leadId, leadId));
    if (unique.length > 0) {
      await tx.insert(leadTags).values(
        unique.map((tagId) => ({
          leadId,
          tagId,
          addedById: actorId,
        })),
      );
    }
  });
}

export async function getTagsForLead(leadId: string): Promise<TagRow[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
      createdById: tags.createdById,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(leadTags)
    .innerJoin(tags, eq(tags.id, leadTags.tagId))
    .where(eq(leadTags.leadId, leadId))
    .orderBy(tags.name);
}
