"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  applyTagToEntity,
  bulkTagEntities,
  countTagUsage,
  findTagByNameCaseInsensitive,
  getOrCreateTag,
  getTagById,
  recolorTag,
  removeTagFromEntity,
  renameTag,
  searchTags,
  type TagEntityType,
  type TagRow,
} from "@/lib/tags";
import { TAG_COLORS, tags as tagsTable } from "@/db/schema/tags";
import { permissions } from "@/db/schema/users";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { eq, inArray, sql } from "drizzle-orm";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import {
  requireLeadAccess,
  requireOwnedEntityAccess,
  requirePermission,
  requireSession,
  requireTaskAccess,
} from "@/lib/auth-helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import { rateLimit } from "@/lib/security/rate-limit";
import { tagName } from "@/lib/validation/primitives";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { isHexColor, isPaletteColor, nextDefaultPaletteColor } from "./helpers";
import {
  BULK_SCOPE_EXPANSION_CAP,
  expandAccountFilteredScope,
  expandContactFilteredScope,
  expandLeadFilteredScope,
  expandOpportunityFilteredScope,
  expandTaskFilteredScope,
  type BulkScopeExpansion,
} from "@/lib/bulk-actions/expand-filtered";
import { getPermissions } from "@/lib/auth-helpers";

/**
 * Server actions for tag operations. Two layers:
 *
 *  - Application actions (`applyTagAction`, `removeTagAction`) — any
 *    user with `canApplyTags` may invoke. Gated server-side, never just
 *    via UI hide.
 *  - Governance actions (`renameTagAction`, `changeTagColorAction`,
 *    `deleteTagAction`) — require `canManageTagDefinitions`.
 *
 * Legacy actions kept for backward compatibility:
 *  - `searchTagsAction`, `getOrCreateTagAction` — used by TagInput.
 *  - `updateTagAction` — preserved for any external caller.
 *
 * Bulk operations:
 *  - `bulkTagAction({ entityType, recordIds, tagIds, operation })` —
 *    generalised across all five tag-aware entities.
 */

interface PublicTag {
  id: string;
  name: string;
  color: string;
}

function strip(t: TagRow): PublicTag {
  return { id: t.id, name: t.name, color: t.color };
}

/** Mapping from entity type to the detail-page revalidation path. */
function entityDetailPath(
  entityType: TagEntityType,
  entityId: string,
): string {
  switch (entityType) {
    case "lead":
      return `/leads/${entityId}`;
    case "account":
      return `/accounts/${entityId}`;
    case "contact":
      return `/contacts/${entityId}`;
    case "opportunity":
      return `/opportunities/${entityId}`;
    case "task":
      return "/tasks";
  }
}

/**
 * Per-entity access gate for tag apply / remove operations. Mirrors the
 * delete-access matrix in `src/lib/access/can-delete.ts`:
 *   - lead/account/contact/opportunity: admin OR owner OR canViewAllRecords
 *   - task: admin OR creator OR assignee OR canViewOthersTasks
 *
 * Server-side enforcement closes the horizontal privilege escalation where
 * a user with `canApplyTags` but without per-record access could otherwise
 * tag records they can't see. `canApplyTags` alone is the WRITE permission
 * to the tagging surface; the per-record visibility gate is enforced on
 * top so users only tag records they can already access.
 */
async function requireTagApplicabilityAccess(
  user: Awaited<ReturnType<typeof requireSession>>,
  entityType: TagEntityType,
  entityId: string,
): Promise<void> {
  if (entityType === "lead") {
    // Reject soft-deleted leads so tagging matches the archived-record
    // posture the other four entities already enforce (account/contact/
    // opportunity via requireOwnedEntityAccess, task via requireTaskAccess
    // all throw on `isDeleted`). requireLeadAccess intentionally does NOT
    // filter on isDeleted because lead-edit paths reuse it on archived
    // rows, so the check lives here rather than there.
    const row = await db
      .select({ isDeleted: leads.isDeleted })
      .from(leads)
      .where(eq(leads.id, entityId))
      .limit(1);
    if (!row[0] || row[0].isDeleted) {
      throw new ForbiddenError("Lead not found.");
    }
    await requireLeadAccess(user, entityId);
    return;
  }
  if (entityType === "task") {
    await requireTaskAccess(user, entityId);
    return;
  }
  await requireOwnedEntityAccess(user, entityType, entityId);
}

/**
 * Set-based access gate for a bulk tag operation. Enforces the exact same
 * matrix as {@link requireTagApplicabilityAccess} (lead/account/contact/
 * opportunity: admin OR owner OR canViewAllRecords; task: admin OR creator
 * OR assignee OR canViewOthersTasks) but in a single SELECT over all
 * `recordIds` instead of one or two SELECTs per record — so a 5,000-record
 * batch costs O(1) DB round-trips rather than O(n). Archived rows are
 * rejected for every entity type (matching the single-record gate).
 *
 * Throws the canonical `@/lib/errors` ForbiddenError (a KnownError) with a
 * generic message that does not leak which specific record id failed, so
 * the error maps cleanly to a FORBIDDEN client envelope.
 */
async function requireBulkTagAccess(
  user: Awaited<ReturnType<typeof requireSession>>,
  entityType: TagEntityType,
  recordIds: string[],
  flags: { canViewAll: boolean; canViewOthers: boolean },
): Promise<void> {
  // De-dupe so the existence check below compares against the distinct
  // set the caller actually submitted.
  const uniqueIds = Array.from(new Set(recordIds));
  if (uniqueIds.length === 0) return;

  const denied = (): never => {
    throw new ForbiddenError(
      `You don't have access to one or more of the selected ${entityType}s.`,
    );
  };

  if (entityType === "task") {
    const rows = await db
      .select({
        createdById: tasks.createdById,
        assignedToId: tasks.assignedToId,
        isDeleted: tasks.isDeleted,
      })
      .from(tasks)
      .where(inArray(tasks.id, uniqueIds));
    // Every requested id must resolve to a live row.
    if (rows.length !== uniqueIds.length) denied();
    for (const row of rows) {
      if (row.isDeleted) denied();
      if (user.isAdmin || flags.canViewOthers) continue;
      if (row.createdById === user.id || row.assignedToId === user.id) continue;
      denied();
    }
    return;
  }

  // lead / account / contact / opportunity — owner-based access. Each
  // branch selects from the concrete table (rather than a union-typed
  // variable) so the column references stay statically typed under TS
  // strict; the rows resolve to a uniform { ownerId, isDeleted } shape.
  let rows: { ownerId: string | null; isDeleted: boolean }[];
  switch (entityType) {
    case "lead":
      rows = await db
        .select({ ownerId: leads.ownerId, isDeleted: leads.isDeleted })
        .from(leads)
        .where(inArray(leads.id, uniqueIds));
      break;
    case "account":
      rows = await db
        .select({
          ownerId: crmAccounts.ownerId,
          isDeleted: crmAccounts.isDeleted,
        })
        .from(crmAccounts)
        .where(inArray(crmAccounts.id, uniqueIds));
      break;
    case "contact":
      rows = await db
        .select({ ownerId: contacts.ownerId, isDeleted: contacts.isDeleted })
        .from(contacts)
        .where(inArray(contacts.id, uniqueIds));
      break;
    case "opportunity":
      rows = await db
        .select({
          ownerId: opportunities.ownerId,
          isDeleted: opportunities.isDeleted,
        })
        .from(opportunities)
        .where(inArray(opportunities.id, uniqueIds));
      break;
  }
  // Every requested id must resolve to a live (non-archived) row.
  if (rows.length !== uniqueIds.length) denied();
  for (const row of rows) {
    if (row.isDeleted) denied();
    if (user.isAdmin || flags.canViewAll) continue;
    if (row.ownerId === user.id) continue;
    denied();
  }
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
      // Creating a tag mutates global state — every user across the
      // app sees the new tag in the typeahead. Gate on canApplyTags
      // so users without the perm can't seed the tag library through
      // the legacy combobox path.
      //
      // Inline ForbiddenError rather than requirePermission, which
      // redirects to /dashboard — bouncing a user mid-form-fill to a
      // different route would lose their in-flight form state. Throwing
      // here lets withErrorBoundary return a clean ActionResult so
      // the caller (TagInput) surfaces a toast and the form survives.
      if (!session.isAdmin) {
        const perm = await db
          .select({ canApplyTags: permissions.canApplyTags })
          .from(permissions)
          .where(eq(permissions.userId, session.id))
          .limit(1);
        if (!perm[0]?.canApplyTags) {
          throw new ForbiddenError(
            "You don't have permission to apply tags.",
          );
        }
      }
      const trimmed = name.trim();
      if (trimmed.length === 0) return null;
      const validated = tagName.parse(trimmed);
      const created = await getOrCreateTag(validated, "slate", session.id);
      return strip(created);
    },
  );
}

const updateSchema = z.object({
  id: z.string().uuid(),
  // Aligned with the tagName primitive (50-char cap + charset).
  name: z.string().trim().min(1).max(50).optional(),
  color: z.enum(TAG_COLORS).optional(),
});

/**
 * Legacy update path — kept so any external caller that imported it
 * keeps compiling. Internally requires `canManageTagDefinitions`
 * (mirrors the new governance actions).
 */
export async function updateTagAction(
  patch: z.infer<typeof updateSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "tag.update" }, async () => {
    const user = await requireSession();
    await requirePermission(user, "canManageTagDefinitions");
    const parsed = updateSchema.parse(patch);
    const before = await getTagById(parsed.id);
    if (!before) throw new NotFoundError("tag");
    await db
      .update(tagsTable)
      .set({
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.color ? { color: parsed.color } : {}),
      })
      .where(eq(tagsTable.id, parsed.id));
    await writeAudit({
      actorId: user.id,
      action: "tag.update",
      targetType: "tag",
      targetId: parsed.id,
      before,
      after: parsed,
    });
    revalidatePath("/");
  });
}

// ---------------------------------------------------------------
// 5.6 — new entity-aware tag actions.
// ---------------------------------------------------------------

const applySchema = z
  .object({
    entityType: z.enum(["lead", "account", "contact", "opportunity", "task"]),
    entityId: z.string().uuid(),
    tagId: z.string().uuid().optional(),
    // Pre-validate the length here so the action returns a clean
    // ValidationError before reaching the tagName primitive (which
    // enforces the 50-char cap + charset). Keeping the cap aligned
    // with the primitive avoids drift between the schema, the
    // primitive, and the UI maxLength.
    newTagName: z.string().min(1).max(50).optional(),
  })
  .refine((d) => Boolean(d.tagId) || Boolean(d.newTagName), {
    message: "Provide tagId or newTagName",
  });

/**
 * Apply a tag to a single record. When `newTagName` is supplied the
 * server first attempts a case-insensitive lookup; on miss it creates
 * the tag with a rotated default palette colour (the lib's
 * `getOrCreateTag` emits the single `tag.create` audit row). The
 * application itself is idempotent — a duplicate (entityId, tagId)
 * write is treated as success.
 *
 * One audit row per apply; bulk operations use bulk_applied for
 * amortization.
 */
export async function applyTagAction(
  input: z.infer<typeof applySchema>,
): Promise<ActionResult<PublicTag>> {
  return withErrorBoundary(
    { action: "tag.apply" },
    async (): Promise<PublicTag> => {
      const user = await requireSession();
      await requirePermission(user, "canApplyTags");
      const parsed = applySchema.parse(input);

      // Per-entity access gate. canApplyTags is necessary but not
      // sufficient — the user must also be able to access the
      // specific record (owner / admin / canViewAllRecords for CRM
      // entities; creator / assignee / admin / canViewOthersTasks
      // for tasks). Without this gate, any user with canApplyTags
      // could tag records they can't otherwise see.
      await requireTagApplicabilityAccess(
        user,
        parsed.entityType,
        parsed.entityId,
      );

      let resolved: TagRow | null = null;
      if (parsed.tagId) {
        resolved = await getTagById(parsed.tagId);
        if (!resolved) throw new NotFoundError("tag");
      } else if (parsed.newTagName) {
        const validatedName = tagName.parse(parsed.newTagName);
        resolved = await findTagByNameCaseInsensitive(validatedName);
        if (!resolved) {
          // Rotate through the palette for new auto-created tags.
          // Use count(*) so the read scales — selecting one column
          // for every row of the tags table is O(n) for what should
          // be a constant-time read.
          const [{ n }] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(tagsTable);
          const color = nextDefaultPaletteColor(n);
          // getOrCreateTag emits the single canonical `tag.create` audit
          // row on a real insert (lib layer, src/lib/tags.ts). Do NOT
          // write a second creation row here — one logical tag-definition
          // creation must produce exactly one forensic row.
          resolved = await getOrCreateTag(validatedName, color, user.id);
        }
      }
      if (!resolved) throw new NotFoundError("tag");

      const inserted = await applyTagToEntity(
        parsed.entityType,
        parsed.entityId,
        resolved.id,
        user.id,
      );

      // Only emit tag.applied when the (entity, tag) pair was
      // actually new. Re-applying an already-attached tag is a
      // no-op at the DB level (ON CONFLICT DO NOTHING) so it
      // shouldn't spam the audit log either.
      if (inserted) {
        await writeAudit({
          actorId: user.id,
          action: "tag.applied",
          targetType: parsed.entityType,
          targetId: parsed.entityId,
          after: {
            entityType: parsed.entityType,
            entityId: parsed.entityId,
            tagId: resolved.id,
            tagName: resolved.name,
          },
        });
      }

      revalidatePath(entityDetailPath(parsed.entityType, parsed.entityId));
      return strip(resolved);
    },
  );
}

const removeSchema = z.object({
  entityType: z.enum(["lead", "account", "contact", "opportunity", "task"]),
  entityId: z.string().uuid(),
  tagId: z.string().uuid(),
});

/** Remove a single tag from a single record. */
export async function removeTagAction(
  input: z.infer<typeof removeSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "tag.remove" }, async () => {
    const user = await requireSession();
    await requirePermission(user, "canApplyTags");
    const parsed = removeSchema.parse(input);

    // Same per-entity gate as applyTagAction (see comment there).
    await requireTagApplicabilityAccess(
      user,
      parsed.entityType,
      parsed.entityId,
    );

    const tag = await getTagById(parsed.tagId);
    if (!tag) throw new NotFoundError("tag");

    const removed = await removeTagFromEntity(
      parsed.entityType,
      parsed.entityId,
      parsed.tagId,
    );

    // Only emit tag.removed when a row was actually deleted; double-
    // remove (e.g. from a stale UI) is a no-op and shouldn't write
    // an audit row for nothing.
    if (removed) {
      await writeAudit({
        actorId: user.id,
        action: "tag.removed",
        targetType: parsed.entityType,
        targetId: parsed.entityId,
        after: {
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          tagId: parsed.tagId,
          tagName: tag.name,
        },
      });
    }

    revalidatePath(entityDetailPath(parsed.entityType, parsed.entityId));
  });
}

const renameSchema = z.object({
  tagId: z.string().uuid(),
  // Aligned with the tagName primitive (50-char cap + charset). The
  // TagEditModal input also caps at 50 to match.
  newName: z.string().trim().min(1).max(50),
});

/** Governance — rename a tag globally. */
export async function renameTagAction(
  input: z.infer<typeof renameSchema>,
): Promise<ActionResult<PublicTag>> {
  return withErrorBoundary(
    { action: "tag.rename" },
    async (): Promise<PublicTag> => {
      const user = await requireSession();
      await requirePermission(user, "canManageTagDefinitions");
      const parsed = renameSchema.parse(input);
      const validatedName = tagName.parse(parsed.newName);

      const before = await getTagById(parsed.tagId);
      if (!before) throw new NotFoundError("tag");

      // case-insensitive collision check.
      const collision = await findTagByNameCaseInsensitive(validatedName);
      if (collision && collision.id !== parsed.tagId) {
        throw new ConflictError("A tag with that name already exists.");
      }

      const updated = await renameTag(parsed.tagId, validatedName);

      await writeAudit({
        actorId: user.id,
        action: "tag.renamed",
        targetType: "tag",
        targetId: parsed.tagId,
        before: { name: before.name },
        after: { name: updated.name },
      });

      // Tags appear on many surfaces; revalidate the layout root.
      revalidatePath("/", "layout");
      return strip(updated);
    },
  );
}

const colorSchema = z.object({
  tagId: z.string().uuid(),
  newColor: z.string().min(1).max(20),
});

/** Governance — change a tag's colour. Accepts palette name or `#RRGGBB`. */
export async function changeTagColorAction(
  input: z.infer<typeof colorSchema>,
): Promise<ActionResult<PublicTag>> {
  return withErrorBoundary(
    { action: "tag.color_change" },
    async (): Promise<PublicTag> => {
      const user = await requireSession();
      await requirePermission(user, "canManageTagDefinitions");
      const parsed = colorSchema.parse(input);

      // Validate either palette name or hex. ValidationError (not
      // ConflictError) — bad input is a 400, not a 409 state-conflict.
      if (!isPaletteColor(parsed.newColor) && !isHexColor(parsed.newColor)) {
        throw new ValidationError(
          "Use a palette name or a hex value like #1a2b3c.",
        );
      }

      const before = await getTagById(parsed.tagId);
      if (!before) throw new NotFoundError("tag");

      const updated = await recolorTag(parsed.tagId, parsed.newColor);

      await writeAudit({
        actorId: user.id,
        action: "tag.color_changed",
        targetType: "tag",
        targetId: parsed.tagId,
        before: { color: before.color },
        after: { color: updated.color },
      });

      revalidatePath("/", "layout");
      return strip(updated);
    },
  );
}

const deleteSchema = z.object({ tagId: z.string().uuid() });

/**
 * Governance — globally delete a tag. Cascades through every join
 * table (junction tables FK on tag_id ON DELETE CASCADE). Records
 * affected per entity type are captured in the audit detail so the
 * deletion is traceable in retrospect.
 */
export async function deleteTagAction(
  input: z.infer<typeof deleteSchema>,
): Promise<ActionResult<{ affected: { total: number } }>> {
  return withErrorBoundary(
    { action: "tag.delete", entityType: "tag", entityId: input.tagId },
    async (): Promise<{ affected: { total: number } }> => {
      const user = await requireSession();
      await requirePermission(user, "canManageTagDefinitions");
      const parsed = deleteSchema.parse(input);

      const before = await getTagById(parsed.tagId);
      if (!before) throw new NotFoundError("tag");

      const usage = await countTagUsage(parsed.tagId);

      await db.delete(tagsTable).where(eq(tagsTable.id, parsed.tagId));

      await writeAudit({
        actorId: user.id,
        action: "tag.deleted",
        targetType: "tag",
        targetId: parsed.tagId,
        before,
        after: {
          tagId: parsed.tagId,
          name: before.name,
          color: before.color,
          affectedCounts: {
            leads: usage.leads,
            accounts: usage.accounts,
            contacts: usage.contacts,
            opportunities: usage.opportunities,
            tasks: usage.tasks,
          },
        },
      });

      revalidatePath("/", "layout");
      return { affected: { total: usage.total } };
    },
  );
}

// ---------------------------------------------------------------
// Bulk-tag generalised to all five tag-aware entity types.
// One audit row per (entityType, recordId) plus a single
// `tag.bulk_applied` / `tag.bulk_removed` summary row tagging the
// entire batch for forensic traceability.
// ---------------------------------------------------------------

/**
 * Bulk-tag inputs accept either:
 *   - The legacy explicit-id shape: `recordIds: string[]` capped at
 *     1000 for one-shot batches.
 *   - The new scope shape: `scope: BulkScope` which is either an id
 *     list (no cap — the action walks in 200-id batches) or a
 *     `filtered` discriminator with the page-level filters that the
 *     action expands server-side via {@link expandLeadFilteredScope}
 *     / {@link expandAccountFilteredScope} /
 *     {@link expandContactFilteredScope} /
 *     {@link expandOpportunityFilteredScope} /
 *     {@link expandTaskFilteredScope}. The expansion is capped at
 *     {@link BULK_SCOPE_EXPANSION_CAP} (5,000) records; a cap-hit
 *     surfaces in the batch-level audit row's `expansionCapped`
 *     field for retrospective triage.
 */
const bulkSchemaLegacy = z.object({
  entityType: z.enum(["lead", "account", "contact", "opportunity", "task"]),
  recordIds: z.array(z.string().uuid()).min(1).max(1000),
  scope: z.undefined().optional(),
  tagIds: z.array(z.string().uuid()).min(1),
  operation: z.enum(["add", "remove"]),
});

const bulkScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ids"),
    ids: z.array(z.string().uuid()).min(1),
  }),
  z.object({
    kind: z.literal("filtered"),
    filters: z.unknown(),
    entity: z.enum(["lead", "account", "contact", "opportunity", "task"]),
  }),
]);

const bulkSchemaScope = z.object({
  entityType: z.enum(["lead", "account", "contact", "opportunity", "task"]),
  recordIds: z.undefined().optional(),
  scope: bulkScopeSchema,
  tagIds: z.array(z.string().uuid()).min(1),
  operation: z.enum(["add", "remove"]),
});

const bulkSchema = z.union([bulkSchemaLegacy, bulkSchemaScope]);

export type BulkTagInput = z.infer<typeof bulkSchema>;

export interface BulkTagSummary {
  recordsTouched: number;
  tagsAdded: number;
  tagsRemoved: number;
}

const ENTITY_LIST_PATH: Record<
  "lead" | "account" | "contact" | "opportunity" | "task",
  string
> = {
  lead: "/leads",
  account: "/accounts",
  contact: "/contacts",
  opportunity: "/opportunities",
  task: "/tasks",
};

export async function bulkTagAction(
  raw: BulkTagInput,
): Promise<ActionResult<BulkTagSummary>> {
  return withErrorBoundary(
    { action: "tag.bulk" },
    async (): Promise<BulkTagSummary> => {
      const session = await requireSession();
      await requirePermission(session, "canApplyTags");
      const parsed = bulkSchema.parse(raw);

      // Rate-limit before the (potentially 5,000-record) scope expansion
      // and access query run. bulkTagAction is a session-user-triggerable
      // action that fans out to large set-based DB reads/writes; without a
      // throttle a single user holding canApplyTags could loop it and
      // saturate the shared session-pooler connection. Dedicated per-user
      // `bulk_tag` bucket (keyed on the user id) so this expensive surface
      // doesn't share budget with the cheaper cursor-scroll `internal_list`
      // limit. Fail-open is handled inside rateLimit on a DB blip.
      const rl = await rateLimit(
        { kind: "bulk_tag", principal: session.id },
        30,
        60,
      );
      if (!rl.allowed) {
        throw new RateLimitError(
          "Too many bulk-tag requests. Please wait and retry.",
        );
      }

      // Caller's effective visibility flags, resolved once. Reused by
      // both the filtered-scope expansion and the set-based access gate
      // below so neither re-reads the permissions row per record.
      const perms = session.isAdmin ? null : await getPermissions(session.id);
      const canViewAll = session.isAdmin || (perms?.canViewAllRecords ?? false);
      const canViewOthers =
        session.isAdmin || (perms?.canViewOthersTasks ?? false);

      // Resolve the concrete `recordIds` from whichever shape was
      // submitted. The legacy shape is direct; the new `scope`
      // shape either reuses the embedded id list, or — for the
      // `filtered` discriminator — walks the entity's view-paginated
      // results via the expand-filtered helper.
      let recordIds: string[];
      let expansion: BulkScopeExpansion | null = null;
      if (parsed.scope) {
        if (parsed.scope.kind === "ids") {
          recordIds = parsed.scope.ids;
          if (recordIds.length > 1000) {
            throw new ValidationError(
              "Cap of 1,000 records per bulk-tag invocation. Split the operation.",
            );
          }
        } else {
          // `filtered` scope. The expansion walks the same
          // runXxxView / listTasksForUser path the UI sees, capped at
          // BULK_SCOPE_EXPANSION_CAP so a pathological filter set
          // can't exhaust memory or DB. The action's set-based access
          // gate below still applies, so a user who somehow expanded
          // into records they don't own is short-circuited before any
          // mutation runs.
          switch (parsed.scope.entity) {
            case "lead":
              expansion = await expandLeadFilteredScope({
                user: session,
                canViewAll,
                filters: parsed.scope.filters,
              });
              break;
            case "account":
              expansion = await expandAccountFilteredScope({
                user: session,
                canViewAll,
                filters: parsed.scope.filters,
              });
              break;
            case "contact":
              expansion = await expandContactFilteredScope({
                user: session,
                canViewAll,
                filters: parsed.scope.filters,
              });
              break;
            case "opportunity":
              expansion = await expandOpportunityFilteredScope({
                user: session,
                canViewAll,
                filters: parsed.scope.filters,
              });
              break;
            case "task":
              expansion = await expandTaskFilteredScope({
                user: session,
                canViewOthers,
                filters: parsed.scope.filters,
              });
              break;
          }
          recordIds = expansion.ids;
          if (recordIds.length === 0) {
            throw new ValidationError(
              "No records match the active filters.",
            );
          }
        }
      } else {
        recordIds = parsed.recordIds;
      }

      const { entityType, tagIds, operation } = parsed;

      // Set-based access gate for every entity type. canApplyTags is
      // necessary but not sufficient — the user must also be able to
      // access each selected record. A single SELECT over all recordIds
      // enforces the same owner/assignee/visibility matrix as the
      // single-record gate (admin OR owner OR canViewAllRecords for CRM
      // entities; admin OR creator OR assignee OR canViewOthersTasks for
      // tasks; archived rows always rejected). If any record is
      // inaccessible the whole batch is rejected with a generic message
      // that doesn't leak which specific id failed, so no mutation runs.
      // This is O(1) DB round-trips instead of O(n) per-record SELECTs.
      await requireBulkTagAccess(session, entityType, recordIds, {
        canViewAll,
        canViewOthers,
      });

      const summary = await bulkTagEntities(
        entityType,
        recordIds,
        tagIds,
        operation,
        session.id,
      );

      const perRecordAction =
        operation === "add"
          ? `${entityType}.tag_bulk_add`
          : `${entityType}.tag_bulk_remove`;
      const batchAction =
        operation === "add" ? "tag.bulk_applied" : "tag.bulk_removed";

      // Per-record audit rows so each record's history surfaces the
      // bulk operation. Uses the canonical writeAuditBatch helper so
      // requestId / email snapshot / failure logging follow the same
      // shape as every other audit write (single email lookup, single
      // INSERT, best-effort try/catch internally).
      await writeAuditBatch({
        actorId: session.id,
        events: recordIds.map((recordId) => ({
          action: perRecordAction,
          targetType: entityType,
          targetId: recordId,
          after: { tagIds },
        })),
      });

      // Single batch-level audit row — one row per invocation
      // that captures the full payload (entity type, record ids,
      // tag ids, summary counts) so the bulk operation is
      // traceable even when per-record audit writes fail.
      await writeAudit({
        actorId: session.id,
        action: batchAction,
        targetType: entityType,
        targetId: recordIds[0] ?? "",
        after: {
          entityType,
          recordIds,
          tagIds,
          recordsTouched: summary.recordsTouched,
          tagsAdded: summary.tagsAdded,
          tagsRemoved: summary.tagsRemoved,
          // Surface the expansion cap when the operation clipped
          // its reach — retroactive forensics can spot operations
          // that hit the cap and would have spread wider.
          ...(expansion?.capped
            ? {
                expansionCapped: true,
                expansionCap: BULK_SCOPE_EXPANSION_CAP,
              }
            : {}),
        },
      });

      revalidatePath(ENTITY_LIST_PATH[entityType]);
      return summary;
    },
  );
}
