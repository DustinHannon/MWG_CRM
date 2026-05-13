import "server-only";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accountTags,
  contactTags,
  leadTags,
  opportunityTags,
  taskTags,
  tags,
  type TagColor,
} from "@/db/schema/tags";
import { writeAudit } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";

export type TagRow = typeof tags.$inferSelect;

/**
 * Tag-aware entity types and the lookup table that maps each entity
 * to its join table + column refs. Centralising the lookup keeps
 * tag application/removal logic uniform across all five entities.
 */
export type TagEntityType =
  | "lead"
  | "account"
  | "contact"
  | "opportunity"
  | "task";

interface JunctionConfig<JT> {
  table: JT;
  entityColumn: unknown;
  tagColumn: unknown;
}

// Per-entity join table accessors. Drizzle's typed column refs make
// it awkward to put these in a single map without `as any`, so we
// dispatch via switch per call. The functions below provide the
// uniform surface.
export interface PublicTag {
  id: string;
  name: string;
  color: string;
}

/** Read all tags attached to a single record across any tag-aware entity. */
export async function listTagsForEntity(
  entityType: TagEntityType,
  entityId: string,
): Promise<TagRow[]> {
  switch (entityType) {
    case "lead":
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
        .where(eq(leadTags.leadId, entityId))
        .orderBy(tags.name);
    case "account":
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
        .from(accountTags)
        .innerJoin(tags, eq(tags.id, accountTags.tagId))
        .where(eq(accountTags.accountId, entityId))
        .orderBy(tags.name);
    case "contact":
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
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(eq(contactTags.contactId, entityId))
        .orderBy(tags.name);
    case "opportunity":
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
        .from(opportunityTags)
        .innerJoin(tags, eq(tags.id, opportunityTags.tagId))
        .where(eq(opportunityTags.opportunityId, entityId))
        .orderBy(tags.name);
    case "task":
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
        .from(taskTags)
        .innerJoin(tags, eq(tags.id, taskTags.tagId))
        .where(eq(taskTags.taskId, entityId))
        .orderBy(tags.name);
  }
}

/**
 * Apply a single tag to an entity. Idempotent — uses ON CONFLICT to
 * tolerate the race where two tabs apply the same tag concurrently.
 * Returns `true` when a new (entity, tag) pair was actually inserted;
 * `false` when the pair already existed. Callers use the flag to
 * avoid spamming the audit log with `tag.applied` rows for no-op
 * re-applies.
 */
export async function applyTagToEntity(
  entityType: TagEntityType,
  entityId: string,
  tagId: string,
  actorId: string,
): Promise<boolean> {
  switch (entityType) {
    case "lead": {
      const rows = await db
        .insert(leadTags)
        .values({ leadId: entityId, tagId, addedById: actorId })
        .onConflictDoNothing()
        .returning({ id: leadTags.tagId });
      return rows.length > 0;
    }
    case "account": {
      const rows = await db
        .insert(accountTags)
        .values({ accountId: entityId, tagId, addedById: actorId })
        .onConflictDoNothing()
        .returning({ id: accountTags.tagId });
      return rows.length > 0;
    }
    case "contact": {
      const rows = await db
        .insert(contactTags)
        .values({ contactId: entityId, tagId, addedById: actorId })
        .onConflictDoNothing()
        .returning({ id: contactTags.tagId });
      return rows.length > 0;
    }
    case "opportunity": {
      const rows = await db
        .insert(opportunityTags)
        .values({ opportunityId: entityId, tagId, addedById: actorId })
        .onConflictDoNothing()
        .returning({ id: opportunityTags.tagId });
      return rows.length > 0;
    }
    case "task": {
      const rows = await db
        .insert(taskTags)
        .values({ taskId: entityId, tagId, addedById: actorId })
        .onConflictDoNothing()
        .returning({ id: taskTags.tagId });
      return rows.length > 0;
    }
  }
}

/**
 * Remove a single tag from an entity. No-op if not currently applied.
 * Returns `true` when a row was actually deleted so callers can skip
 * audit emissions for no-op removes.
 */
export async function removeTagFromEntity(
  entityType: TagEntityType,
  entityId: string,
  tagId: string,
): Promise<boolean> {
  switch (entityType) {
    case "lead": {
      const rows = await db
        .delete(leadTags)
        .where(and(eq(leadTags.leadId, entityId), eq(leadTags.tagId, tagId)))
        .returning({ id: leadTags.tagId });
      return rows.length > 0;
    }
    case "account": {
      const rows = await db
        .delete(accountTags)
        .where(
          and(eq(accountTags.accountId, entityId), eq(accountTags.tagId, tagId)),
        )
        .returning({ id: accountTags.tagId });
      return rows.length > 0;
    }
    case "contact": {
      const rows = await db
        .delete(contactTags)
        .where(
          and(eq(contactTags.contactId, entityId), eq(contactTags.tagId, tagId)),
        )
        .returning({ id: contactTags.tagId });
      return rows.length > 0;
    }
    case "opportunity": {
      const rows = await db
        .delete(opportunityTags)
        .where(
          and(
            eq(opportunityTags.opportunityId, entityId),
            eq(opportunityTags.tagId, tagId),
          ),
        )
        .returning({ id: opportunityTags.tagId });
      return rows.length > 0;
    }
    case "task": {
      const rows = await db
        .delete(taskTags)
        .where(and(eq(taskTags.taskId, entityId), eq(taskTags.tagId, tagId)))
        .returning({ id: taskTags.tagId });
      return rows.length > 0;
    }
  }
}

/**
 * Count how many records (across all five entities) reference a tag.
 * Used by the governance-delete confirmation to warn operators.
 */
export async function countTagUsage(tagId: string): Promise<{
  leads: number;
  accounts: number;
  contacts: number;
  opportunities: number;
  tasks: number;
  total: number;
}> {
  const [leadRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadTags)
    .where(eq(leadTags.tagId, tagId));
  const [accountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountTags)
    .where(eq(accountTags.tagId, tagId));
  const [contactRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contactTags)
    .where(eq(contactTags.tagId, tagId));
  const [opportunityRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunityTags)
    .where(eq(opportunityTags.tagId, tagId));
  const [taskRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(taskTags)
    .where(eq(taskTags.tagId, tagId));

  const leads = leadRow?.n ?? 0;
  const accounts = accountRow?.n ?? 0;
  const contacts = contactRow?.n ?? 0;
  const opportunities = opportunityRow?.n ?? 0;
  const tasks = taskRow?.n ?? 0;
  return {
    leads,
    accounts,
    contacts,
    opportunities,
    tasks,
    total: leads + accounts + contacts + opportunities + tasks,
  };
}

/**
 * Find a tag by name (case-insensitive exact match). Returns null when
 * no row exists. Used by applyTagAction to round-trip a freshly-typed
 * name to an existing tag before creating a new one.
 */
export async function findTagByNameCaseInsensitive(
  name: string,
): Promise<TagRow | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const [row] = await db
    .select()
    .from(tags)
    .where(ilike(tags.name, trimmed))
    .limit(1);
  return row ?? null;
}

/**
 * Read a tag row by id. Used by governance actions before mutating
 * to capture `before` state for audit, and to fan out NotFoundError
 * when the row is missing.
 */
export async function getTagById(id: string): Promise<TagRow | null> {
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  return row ?? null;
}

/**
 * Rename a tag and refresh its slug. Throws when the slug or name
 * collides with another row — caller translates to ConflictError.
 */
export async function renameTag(
  id: string,
  newName: string,
): Promise<TagRow> {
  const trimmed = newName.trim();
  if (trimmed.length === 0) throw new ValidationError("Tag name is empty");
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const finalSlug =
    slug.length === 0 ? `tag-${Math.random().toString(16).slice(2, 10)}` : slug;
  // Slug-collision pre-check. Name UNIQUE is enforced by the caller
  // (renameTagAction does a case-insensitive findTagByNameCaseInsensitive).
  // Slug UNIQUE can collide independently: name "B Tag" (slug=b-tag)
  // renamed to "Hot Lead!" recomputes slug=hot-lead which collides
  // with an existing tag named "Hot-Lead". Pre-checking yields a clear
  // ConflictError naming the colliding tag instead of a generic
  // "value is already in use" surfaced from the translated 23505.
  const slugClash = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.slug, finalSlug))
    .limit(1);
  if (slugClash[0] && slugClash[0].id !== id) {
    throw new ConflictError(
      `A tag named "${slugClash[0].name}" already uses a similar slug. Pick a more distinctive name.`,
    );
  }
  const [updated] = await db
    .update(tags)
    .set({ name: trimmed, slug: finalSlug, updatedAt: sql`now()` })
    .where(eq(tags.id, id))
    .returning();
  return updated;
}

/** Recolour a tag. Caller validates the colour string. */
export async function recolorTag(
  id: string,
  newColor: string,
): Promise<TagRow> {
  const [updated] = await db
    .update(tags)
    .set({ color: newColor, updatedAt: sql`now()` })
    .where(eq(tags.id, id))
    .returning();
  return updated;
}

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
  if (trimmed.length === 0) throw new ValidationError("Tag name is empty");

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

  // Race-safe insert: two concurrent callers seeing no existing row
  // would both reach the INSERT. The UNIQUE constraint on name (and
  // slug) would cause one to fail with 23505 and surface a confusing
  // ConflictError for what is logically idempotent. onConflictDoNothing
  // + case-insensitive re-select makes the operation safe under
  // concurrency: the loser of the race resolves to the winner's row.
  const inserted = await db
    .insert(tags)
    .values({
      name: trimmed,
      slug: finalSlug,
      color,
      createdById,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const reselect = await db
    .select()
    .from(tags)
    .where(ilike(tags.name, trimmed))
    .limit(1);
  if (reselect[0]) return reselect[0];

  throw new ValidationError(
    "Could not create or retrieve tag (unexpected DB state)",
  );
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

/**
 * bulk tag operations. Apply or remove a list of tags across
 * many leads in a single transaction. `ON CONFLICT DO NOTHING` keeps adds
 * idempotent. Caller is responsible for permission checks (call
 * `requireLeadAccess` per id before invoking).
 *
 * @param leadIds Up to 1000 lead UUIDs.
 * @param tagIds Tag UUIDs to add or remove.
 * @param operation 'add' inserts; 'remove' deletes the (lead, tag) pairs.
 * @param actorId Author of the change — recorded as `lead_tags.added_by_id`.
 * @returns { leadsTouched, tagsAdded, tagsRemoved } summary.
 * @throws ValidationError when leadIds.length > 1000.
 */
export async function bulkTagLeads(
  leadIds: string[],
  tagIds: string[],
  operation: "add" | "remove",
  actorId: string,
): Promise<{ leadsTouched: number; tagsAdded: number; tagsRemoved: number }> {
  if (leadIds.length === 0 || tagIds.length === 0) {
    return { leadsTouched: 0, tagsAdded: 0, tagsRemoved: 0 };
  }
  if (leadIds.length > 1000) {
    throw new ValidationError("Bulk tag operation capped at 1000 leads.");
  }
  const uniqueLeads = Array.from(new Set(leadIds));
  const uniqueTags = Array.from(new Set(tagIds));

  let added = 0;
  let removed = 0;

  await db.transaction(async (tx) => {
    if (operation === "add") {
      const rows = uniqueLeads.flatMap((leadId) =>
        uniqueTags.map((tagId) => ({ leadId, tagId, addedById: actorId })),
      );
      const result = await tx
        .insert(leadTags)
        .values(rows)
        .onConflictDoNothing()
        .returning({ leadId: leadTags.leadId });
      added = result.length;
    } else {
      const result = await tx
        .delete(leadTags)
        .where(
          and(
            inArray(leadTags.leadId, uniqueLeads),
            inArray(leadTags.tagId, uniqueTags),
          ),
        )
        .returning({ leadId: leadTags.leadId });
      removed = result.length;
    }
  });

  return {
    leadsTouched: uniqueLeads.length,
    tagsAdded: added,
    tagsRemoved: removed,
  };
}

/**
 * Generalised bulk-tag helper covering all five tag-aware entities.
 * Mirrors `bulkTagLeads` but dispatches to the correct junction table
 * based on `entityType`. Idempotent on add (ON CONFLICT DO NOTHING).
 * Returns counts so the caller can construct a toast.
 */
export async function bulkTagEntities(
  entityType: TagEntityType,
  recordIds: string[],
  tagIds: string[],
  operation: "add" | "remove",
  actorId: string,
): Promise<{ recordsTouched: number; tagsAdded: number; tagsRemoved: number }> {
  if (recordIds.length === 0 || tagIds.length === 0) {
    return { recordsTouched: 0, tagsAdded: 0, tagsRemoved: 0 };
  }
  if (recordIds.length > 1000) {
    throw new ValidationError(
      "Bulk tag operation capped at 1000 records.",
    );
  }
  const uniqueRecords = Array.from(new Set(recordIds));
  const uniqueTags = Array.from(new Set(tagIds));

  let added = 0;
  let removed = 0;

  await db.transaction(async (tx) => {
    if (operation === "add") {
      switch (entityType) {
        case "lead": {
          const rows = uniqueRecords.flatMap((leadId) =>
            uniqueTags.map((tagId) => ({ leadId, tagId, addedById: actorId })),
          );
          const result = await tx
            .insert(leadTags)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: leadTags.leadId });
          added = result.length;
          break;
        }
        case "account": {
          const rows = uniqueRecords.flatMap((accountId) =>
            uniqueTags.map((tagId) => ({
              accountId,
              tagId,
              addedById: actorId,
            })),
          );
          const result = await tx
            .insert(accountTags)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: accountTags.accountId });
          added = result.length;
          break;
        }
        case "contact": {
          const rows = uniqueRecords.flatMap((contactId) =>
            uniqueTags.map((tagId) => ({
              contactId,
              tagId,
              addedById: actorId,
            })),
          );
          const result = await tx
            .insert(contactTags)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: contactTags.contactId });
          added = result.length;
          break;
        }
        case "opportunity": {
          const rows = uniqueRecords.flatMap((opportunityId) =>
            uniqueTags.map((tagId) => ({
              opportunityId,
              tagId,
              addedById: actorId,
            })),
          );
          const result = await tx
            .insert(opportunityTags)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: opportunityTags.opportunityId });
          added = result.length;
          break;
        }
        case "task": {
          const rows = uniqueRecords.flatMap((taskId) =>
            uniqueTags.map((tagId) => ({ taskId, tagId, addedById: actorId })),
          );
          const result = await tx
            .insert(taskTags)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: taskTags.taskId });
          added = result.length;
          break;
        }
      }
    } else {
      switch (entityType) {
        case "lead": {
          const result = await tx
            .delete(leadTags)
            .where(
              and(
                inArray(leadTags.leadId, uniqueRecords),
                inArray(leadTags.tagId, uniqueTags),
              ),
            )
            .returning({ id: leadTags.leadId });
          removed = result.length;
          break;
        }
        case "account": {
          const result = await tx
            .delete(accountTags)
            .where(
              and(
                inArray(accountTags.accountId, uniqueRecords),
                inArray(accountTags.tagId, uniqueTags),
              ),
            )
            .returning({ id: accountTags.accountId });
          removed = result.length;
          break;
        }
        case "contact": {
          const result = await tx
            .delete(contactTags)
            .where(
              and(
                inArray(contactTags.contactId, uniqueRecords),
                inArray(contactTags.tagId, uniqueTags),
              ),
            )
            .returning({ id: contactTags.contactId });
          removed = result.length;
          break;
        }
        case "opportunity": {
          const result = await tx
            .delete(opportunityTags)
            .where(
              and(
                inArray(opportunityTags.opportunityId, uniqueRecords),
                inArray(opportunityTags.tagId, uniqueTags),
              ),
            )
            .returning({ id: opportunityTags.opportunityId });
          removed = result.length;
          break;
        }
        case "task": {
          const result = await tx
            .delete(taskTags)
            .where(
              and(
                inArray(taskTags.taskId, uniqueRecords),
                inArray(taskTags.tagId, uniqueTags),
              ),
            )
            .returning({ id: taskTags.taskId });
          removed = result.length;
          break;
        }
      }
    }
  });

  return {
    recordsTouched: uniqueRecords.length,
    tagsAdded: added,
    tagsRemoved: removed,
  };
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
