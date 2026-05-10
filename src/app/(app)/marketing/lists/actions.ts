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
} from "@/db/schema/marketing-lists";
import { writeAudit } from "@/lib/audit";
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
  type SessionUser,
} from "@/lib/auth-helpers";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { refreshList } from "@/lib/marketing/lists/refresh";
import {
  type FilterDsl,
  filterDslSchema,
} from "@/lib/security/filter-dsl";
import {
  type ActionResult,
  withErrorBoundary,
} from "@/lib/server-action";

/**
 * Phase 21 — Marketing list server actions.
 *
 * Every action runs through `withErrorBoundary`, gates on session +
 * canManageMarketing (or admin), validates input via Zod, mutates via
 * the lib helpers, and writes an audit event.
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

const listCreateSchema = listInputBaseSchema;
const listUpdateSchema = listInputBaseSchema.extend({
  id: z.string().uuid(),
});

const idSchema = z.string().uuid();

const bulkAddSchema = z.object({
  listId: z.string().uuid(),
  leadIds: z
    .array(z.string().uuid())
    .min(1)
    .max(5000),
});

async function requireMarketingManager(): Promise<SessionUser> {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    throw new ForbiddenError("You don't have permission to manage marketing.");
  }
  return user;
}

export async function createListAction(input: {
  name: string;
  description?: string;
  filterDsl: FilterDsl;
}): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary({ action: "marketing.list.create" }, async () => {
    const user = await requireMarketingManager();
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
      // Phase 25 §4.1 — non-validation failures (DB blip, connectivity)
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
}): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.list.update" }, async () => {
    const user = await requireMarketingManager();
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

    await db
      .update(marketingLists)
      .set({
        name: parsed.data.name,
        description: parsed.data.description,
        filterDsl: parsed.data.filterDsl,
        updatedById: user.id,
        updatedAt: sql`now()`,
      })
      .where(eq(marketingLists.id, parsed.data.id));

    // Re-evaluate membership against the new DSL. Phase 25 §4.1 —
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
    const user = await requireMarketingManager();
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

    // Phase 24 §6.5.2 — refuse to archive a list referenced by any
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
      const user = await requireMarketingManager();
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
      const user = await requireMarketingManager();
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
