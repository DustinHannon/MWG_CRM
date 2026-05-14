"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import {
  marketingListMembers,
  marketingLists,
  marketingStaticListMembers,
  type MarketingListSourceEntity,
} from "@/db/schema/marketing-lists";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  getPermissions,
  requireSession,
  type MarketingPermissionKey,
  type SessionUser,
} from "@/lib/auth-helpers";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { refreshList } from "@/lib/marketing/lists/refresh";
import {
  bulkUpdateStaticListMembers,
  deleteStaticListMembersById,
  getStaticListMemberById,
  updateStaticListMember,
} from "@/lib/marketing/lists/static-members";
import {
  type FilterDsl,
  filterDslSchema,
} from "@/lib/security/filter-dsl";
import {
  type ActionResult,
  withErrorBoundary,
} from "@/lib/server-action";

/**
 * Marketing list server actions.
 *
 * Every action runs through `withErrorBoundary`, gates on session +
 * the specific fine-grained list permission for the action (or admin),
 * validates input via Zod, mutates via the lib helpers, and writes an
 * audit event.
 */

const listInputBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  filterDsl: filterDslSchema,
});

const listCreateSchema = listInputBaseSchema.extend({
  // caller may specify the source entity for dynamic
  // lists. Defaults to 'leads' (the only wired source today).
  sourceEntity: z
    .enum(["leads", "contacts", "accounts", "opportunities", "mixed"])
    .optional()
    .default("leads"),
});
const listUpdateSchema = listInputBaseSchema.extend({
  id: z.string().uuid(),
  // OCC on list edits. List-edit UI passes the version
  // it loaded; the UPDATE refuses to write if another writer bumped it.
  // Optional only for programmatic API callers; the UI always passes.
  expectedVersion: z.number().int().nonnegative().optional(),
  sourceEntity: z
    .enum(["leads", "contacts", "accounts", "opportunities", "mixed"])
    .optional(),
});

// static-imported list creation. No filter DSL needed;
// members are populated by a separate import flow (Sub-agent C).
const staticListCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
});

const staticMemberUpdateSchema = z.object({
  memberId: z.string().uuid(),
  field: z.enum(["name", "email"]),
  value: z.string().trim().max(500),
});

const staticMemberBulkUpdateSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(5000),
  field: z.literal("name"),
  value: z.string().trim().max(500).optional(),
});

const staticMemberRemoveSchema = z.object({
  listId: z.string().uuid(),
  memberIds: z.array(z.string().uuid()).min(1).max(5000),
});

const idSchema = z.string().uuid();

const bulkAddSchema = z.object({
  listId: z.string().uuid(),
  leadIds: z
    .array(z.string().uuid())
    .min(1)
    .max(5000),
});

async function requireListPermission(
  perm: MarketingPermissionKey,
): Promise<SessionUser> {
  const user = await requireSession();
  if (user.isAdmin) return user;
  const perms = await getPermissions(user.id);
  if (!perms[perm]) {
    throw new ForbiddenError(
      "You don't have permission to perform this list action.",
    );
  }
  return user;
}

export async function createListAction(input: {
  name: string;
  description?: string;
  filterDsl: FilterDsl;
  // explicit source entity for dynamic lists. Defaults
  // to 'leads' if omitted, behavior.
  sourceEntity?: MarketingListSourceEntity;
}): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary({ action: "marketing.list.create" }, async () => {
    const user = await requireListPermission("canMarketingListsCreate");
    const parsed = listCreateSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Invalid input.",
      );
    }

    const [row] = await db
      .insert(marketingLists)
      .values({
        name: parsed.data.name,
        description: parsed.data.description,
        filterDsl: parsed.data.filterDsl,
        // explicit type tagging. Existing rows
        // back-filled to 'dynamic' by the migration.
        listType: "dynamic",
        sourceEntity: parsed.data.sourceEntity,
        createdById: user.id,
        updatedById: user.id,
      })
      .returning({ id: marketingLists.id });
    if (!row) throw new ValidationError("Failed to create list.");

    // Initial population. Bounded at 50k by refreshList. Best-effort —
    // refresh failures don't block creation but we surface the error so
    // the UI can prompt for a manual refresh.
    try {
      await refreshList(row.id, user.id);
    } catch (err) {
      // The list row exists; refresh can be retried from detail page.
      // Re-throw validation errors so the user can correct the DSL.
      if (err instanceof ValidationError) throw err;
      // non-validation failures (DB blip, connectivity)
      // get logged structured so production diagnostics catch them.
      // The list still exists; membership is empty until next refresh.
      logger.warn("marketing.list.refresh_after_create_failed", {
        listId: row.id,
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.LIST_CREATE,
      targetType: "marketing_list",
      targetId: row.id,
      after: {
        name: parsed.data.name,
        filterDsl: parsed.data.filterDsl,
      },
    });

    revalidatePath("/marketing/lists");
    return { id: row.id };
  });
}

export async function updateListAction(input: {
  id: string;
  name: string;
  description?: string;
  filterDsl: FilterDsl;
  expectedVersion?: number;
}): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.list.update" }, async () => {
    const user = await requireListPermission("canMarketingListsEdit");
    const parsed = listUpdateSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Invalid input.",
      );
    }

    const [existing] = await db
      .select({
        id: marketingLists.id,
        name: marketingLists.name,
        description: marketingLists.description,
        filterDsl: marketingLists.filterDsl,
        isDeleted: marketingLists.isDeleted,
      })
      .from(marketingLists)
      .where(eq(marketingLists.id, parsed.data.id))
      .limit(1);
    if (!existing || existing.isDeleted) {
      throw new NotFoundError("marketing list");
    }

    // OCC: when caller passes `expectedVersion`, the
    // UPDATE atomically requires `version = expectedVersion` AND bumps
    // it. 0 rows affected ⇒ another writer beat us → ConflictError.
    // `isDeleted=false` clause prevents a stale edit form from silently
    // overwriting a row that was archived between load and submit
    // (matches the leads.ts pattern at lines 498-502).
    const whereClauses = [
      eq(marketingLists.id, parsed.data.id),
      eq(marketingLists.isDeleted, false),
    ];
    if (parsed.data.expectedVersion !== undefined) {
      whereClauses.push(
        eq(marketingLists.version, parsed.data.expectedVersion),
      );
    }
    const updated = await db
      .update(marketingLists)
      .set({
        name: parsed.data.name,
        description: parsed.data.description,
        filterDsl: parsed.data.filterDsl,
        updatedById: user.id,
        updatedAt: sql`now()`,
        version: sql`${marketingLists.version} + 1`,
      })
      .where(and(...whereClauses))
      .returning({ id: marketingLists.id });
    if (
      updated.length === 0 &&
      parsed.data.expectedVersion !== undefined
    ) {
      throw new ConflictError(
        "Another user has updated this list. Reload to see the latest changes.",
      );
    }

    // Re-evaluate membership against the new DSL.
    // ValidationError rethrows to the user (bad DSL); any other failure
    // (DB connectivity, etc.) gets logged structured so it's visible
    // in production diagnostics but does NOT block the user since the
    // list update itself already landed. Membership stays stale until
    // the next manual refresh or list-refresh cron run.
    try {
      await refreshList(parsed.data.id, user.id);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      logger.warn("marketing.list.refresh_after_update_failed", {
        listId: parsed.data.id,
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.LIST_UPDATE,
      targetType: "marketing_list",
      targetId: parsed.data.id,
      before: {
        name: existing.name,
        description: existing.description,
        filterDsl: existing.filterDsl,
      },
      after: {
        name: parsed.data.name,
        description: parsed.data.description,
        filterDsl: parsed.data.filterDsl,
      },
    });

    revalidatePath("/marketing/lists");
    revalidatePath(`/marketing/lists/${parsed.data.id}`);
  });
}

export async function deleteListAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.list.delete" }, async () => {
    const user = await requireListPermission("canMarketingListsDelete");
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) throw new ValidationError("Invalid list id.");

    const [existing] = await db
      .select({
        id: marketingLists.id,
        name: marketingLists.name,
        isDeleted: marketingLists.isDeleted,
      })
      .from(marketingLists)
      .where(eq(marketingLists.id, parsedId.data))
      .limit(1);
    if (!existing || existing.isDeleted) {
      throw new NotFoundError("marketing list");
    }

    // refuse to archive a list referenced by any
    // active (scheduled or sending) campaign. Mirrors the template
    // delete-block; surfaces the blocking campaigns to the UI.
    const blockingCampaigns = await db
      .select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
        status: marketingCampaigns.status,
      })
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.listId, parsedId.data),
          eq(marketingCampaigns.isDeleted, false),
          inArray(marketingCampaigns.status, ["scheduled", "sending"]),
        ),
      )
      .limit(20);
    if (blockingCampaigns.length > 0) {
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_DELETE_BLOCKED,
        targetType: "marketing_list",
        targetId: parsedId.data,
        after: { blockingCampaigns },
      });
      throw new ConflictError(
        `Cannot archive: ${blockingCampaigns.length} active campaign(s) reference this list. Cancel or complete them first.`,
        { code: "LIST_IN_USE", references: blockingCampaigns },
      );
    }

    await db
      .update(marketingLists)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: user.id,
        updatedAt: sql`now()`,
      })
      .where(eq(marketingLists.id, parsedId.data));

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.LIST_DELETE,
      targetType: "marketing_list",
      targetId: parsedId.data,
      before: { name: existing.name },
    });

    revalidatePath("/marketing/lists");
  });
}

export async function refreshListAction(
  id: string,
): Promise<ActionResult<{ added: number; removed: number; total: number }>> {
  return withErrorBoundary(
    { action: "marketing.list.refresh" },
    async () => {
      const user = await requireListPermission("canMarketingListsRefresh");
      const parsedId = idSchema.safeParse(id);
      if (!parsedId.success) throw new ValidationError("Invalid list id.");

      const result = await refreshList(parsedId.data, user.id);
      revalidatePath(`/marketing/lists/${parsedId.data}`);
      return {
        added: result.added,
        removed: result.removed,
        total: result.total,
      };
    },
  );
}

export async function bulkAddLeadsToListAction(input: {
  listId: string;
  leadIds: string[];
}): Promise<ActionResult<{ added: number }>> {
  return withErrorBoundary(
    { action: "marketing.list.member_bulk_add" },
    async () => {
      const user = await requireListPermission("canMarketingListsBulkAdd");
      const parsed = bulkAddSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }

      // Confirm the list exists and is active.
      const [list] = await db
        .select({
          id: marketingLists.id,
          isDeleted: marketingLists.isDeleted,
        })
        .from(marketingLists)
        .where(eq(marketingLists.id, parsed.data.listId))
        .limit(1);
      if (!list || list.isDeleted) {
        throw new NotFoundError("marketing list");
      }

      // Resolve eligible leads (active, not do-not-email, with an email).
      const candidates = await db
        .select({ id: leads.id, email: leads.email })
        .from(leads)
        .where(
          and(
            inArray(leads.id, parsed.data.leadIds),
            eq(leads.isDeleted, false),
            eq(leads.doNotEmail, false),
          ),
        );
      const eligible = candidates.filter(
        (c): c is { id: string; email: string } => Boolean(c.email),
      );

      let added = 0;
      if (eligible.length > 0) {
        for (let i = 0; i < eligible.length; i += 1000) {
          const slice = eligible.slice(i, i + 1000);
          const inserted = await db
            .insert(marketingListMembers)
            .values(
              slice.map((c) => ({
                listId: parsed.data.listId,
                leadId: c.id,
                email: c.email,
              })),
            )
            .onConflictDoNothing()
            .returning({ leadId: marketingListMembers.leadId });
          added += inserted.length;
        }

        if (added > 0) {
          // Refresh the snapshot count so the index page stays accurate.
          const [{ n }] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(marketingListMembers)
            .where(
              eq(marketingListMembers.listId, parsed.data.listId),
            );
          await db
            .update(marketingLists)
            .set({
              memberCount: n ?? 0,
              updatedAt: sql`now()`,
            })
            .where(eq(marketingLists.id, parsed.data.listId));
        }
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_MEMBER_BULK_ADD,
        targetType: "marketing_list",
        targetId: parsed.data.listId,
        after: {
          requestedCount: parsed.data.leadIds.length,
          eligibleCount: eligible.length,
          addedCount: added,
        },
      });

      revalidatePath(`/marketing/lists/${parsed.data.listId}`);
      revalidatePath("/marketing/lists");
      return { added };
    },
  );
}

// =============================================================================
// Static-imported list actions
//
// Static lists are seeded by the Excel import flow (Sub-agent C) and
// mass-edited from the static-list detail page. Each mutation gates on
// `canMarketingListsEdit` OR creator-match per the brief's "edit own"
// semantic (existing schema is single-boolean; creator check is
// inline). Each per-row mutation writes one audit row so the forensic
// trail stays granular even for bulk operations.
// =============================================================================

/**
 * Permission gate for static-list member mutations. Mirrors the
 * dynamic-list gate but additionally allows the list's creator to edit
 * their own static lists without holding `canMarketingListsEdit`.
 */
async function requireStaticListEditAccess(
  user: SessionUser,
  listId: string,
): Promise<{ id: string; createdById: string; isDeleted: boolean }> {
  const [list] = await db
    .select({
      id: marketingLists.id,
      createdById: marketingLists.createdById,
      isDeleted: marketingLists.isDeleted,
      listType: marketingLists.listType,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, listId))
    .limit(1);
  if (!list || list.isDeleted) throw new NotFoundError("marketing list");
  if (list.listType !== "static_imported") {
    throw new ValidationError(
      "This action is only valid for static-imported lists.",
    );
  }
  if (user.isAdmin) return list;
  const perms = await getPermissions(user.id);
  const isCreator = list.createdById === user.id;
  const hasEditAll = perms.canMarketingListsEdit;
  if (!hasEditAll && !isCreator) {
    throw new ForbiddenError(
      "You don't have permission to edit this list.",
    );
  }
  return list;
}

/**
 * Create a static-imported list row (no members yet).
 * Sub-agent C's import flow inserts members afterwards via the
 * `createStaticListMembers` lib helper.
 *
 * The list is created with an empty filter_dsl placeholder because
 * the column is NOT NULL; resolution.ts branches on list_type before
 * touching it.
 */
export async function createStaticListAction(input: {
  name: string;
  description?: string;
}): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary(
    { action: "marketing.list.create" },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin) {
        const perms = await getPermissions(user.id);
        if (!perms.canMarketingListsImport && !perms.canMarketingListsCreate) {
          throw new ForbiddenError(
            "You don't have permission to import static lists.",
          );
        }
      }
      const parsed = staticListCreateSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }

      const [row] = await db
        .insert(marketingLists)
        .values({
          name: parsed.data.name,
          description: parsed.data.description,
          // Placeholder DSL — never evaluated for static lists.
          filterDsl: { combinator: "AND", rules: [] },
          listType: "static_imported",
          sourceEntity: null,
          memberCount: 0,
          createdById: user.id,
          updatedById: user.id,
        })
        .returning({ id: marketingLists.id });
      if (!row) throw new ValidationError("Failed to create list.");

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_CREATE,
        targetType: "marketing_list",
        targetId: row.id,
        after: {
          name: parsed.data.name,
          listType: "static_imported",
        },
      });

      revalidatePath("/marketing/lists");
      return { id: row.id };
    },
  );
}

/**
 * Inline edit of a single static-list member's name or
 * email. Triggered from the detail page after a 600ms debounce on
 * blur.
 */
export async function updateStaticListMemberAction(input: {
  memberId: string;
  field: "name" | "email";
  value: string;
}): Promise<ActionResult<{ memberId: string }>> {
  return withErrorBoundary(
    { action: "marketing.list.member_edit" },
    async () => {
      const user = await requireSession();
      const parsed = staticMemberUpdateSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }

      const existing = await getStaticListMemberById(parsed.data.memberId);
      if (!existing) throw new NotFoundError("static list member");

      const list = await requireStaticListEditAccess(user, existing.listId);

      const patch =
        parsed.data.field === "email"
          ? { email: parsed.data.value }
          : { name: parsed.data.value };
      const updated = await updateStaticListMember({
        memberId: parsed.data.memberId,
        patch,
        actorId: user.id,
      });
      if (!updated) throw new NotFoundError("static list member");

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_MEMBER_EDITED,
        targetType: "marketing_static_list_member",
        targetId: updated.id,
        before: {
          email: existing.email,
          name: existing.name,
        },
        after: {
          listId: list.id,
          field: parsed.data.field,
          value: parsed.data.value,
        },
      });

      revalidatePath(`/marketing/lists/${list.id}`);
      return { memberId: updated.id };
    },
  );
}

/**
 * Bulk edit a single field across many static-list
 * members. Only `name` is exposed for bulk write (bulk email rewrites
 * risk uniqueness conflicts and are restricted to the per-row inline
 * path).
 */
export async function bulkUpdateStaticListMembersAction(input: {
  listId: string;
  memberIds: string[];
  field: "name";
  value: string | null;
}): Promise<ActionResult<{ updated: number }>> {
  return withErrorBoundary(
    { action: "marketing.list.bulk_edit" },
    async () => {
      const user = await requireSession();
      const parsed = staticMemberBulkUpdateSchema.safeParse({
        memberIds: input.memberIds,
        field: input.field,
        value: input.value ?? undefined,
      });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }
      const list = await requireStaticListEditAccess(user, input.listId);

      const { updated } = await bulkUpdateStaticListMembers({
        memberIds: parsed.data.memberIds,
        field: "name",
        value: parsed.data.value ?? null,
        actorId: user.id,
      });

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_BULK_EDITED,
        targetType: "marketing_list",
        targetId: list.id,
        after: {
          fieldChanged: "name",
          count: updated,
        },
      });

      revalidatePath(`/marketing/lists/${list.id}`);
      return { updated };
    },
  );
}

/**
 * Remove one or many static-list members. Single-row
 * delete + bulk delete share this action. Writes one audit row
 * removed member so the forensic trail captures every email that
 * left the list.
 */
export async function removeStaticListMembersAction(input: {
  listId: string;
  memberIds: string[];
}): Promise<ActionResult<{ removed: number }>> {
  return withErrorBoundary(
    { action: "marketing.list.member_remove" },
    async () => {
      const user = await requireSession();
      const parsed = staticMemberRemoveSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid input.",
        );
      }
      const list = await requireStaticListEditAccess(user, parsed.data.listId);

      // Fetch the rows up-front so the audit trail carries the email
      // values that are about to disappear.
      const existingRows = await db
        .select({
          id: marketingStaticListMembers.id,
          email: marketingStaticListMembers.email,
          name: marketingStaticListMembers.name,
        })
        .from(marketingStaticListMembers)
        .where(
          and(
            eq(marketingStaticListMembers.listId, parsed.data.listId),
            inArray(marketingStaticListMembers.id, parsed.data.memberIds),
          ),
        );

      const { removed } = await deleteStaticListMembersById({
        listId: parsed.data.listId,
        memberIds: parsed.data.memberIds,
      });

      // Audit per row so bulk removes still produce forensic-grade
      // entries. Single-INSERT batch helper (writeAuditBatch) so the
      // N per-row rows land as one round-trip.
      await writeAuditBatch({
        actorId: user.id,
        events: existingRows.map((row) => ({
          action: MARKETING_AUDIT_EVENTS.LIST_MEMBER_REMOVED,
          targetType: "marketing_static_list_member",
          targetId: row.id,
          before: {
            listId: list.id,
            email: row.email,
            name: row.name,
          },
        })),
      });

      revalidatePath(`/marketing/lists/${list.id}`);
      revalidatePath("/marketing/lists");
      return { removed };
    },
  );
}
