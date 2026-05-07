import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { savedViews } from "@/db/schema/views";
import { permissions } from "@/db/schema/users";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

/**
 * Centralized authorization gates. Every server action that takes a record
 * id MUST call one of these before reading or writing — never trust the id
 * to be access-controlled implicitly. Returns the loaded record on success
 * to save the caller a second query.
 *
 * Pattern is:
 *   const lead = await requireLeadAccess(leadId, userId, "write");
 *
 * `read`/`write`/`delete` actions are distinguished so we can later tighten
 * write/delete (e.g., delete may require admin) without changing call sites.
 */

type Action = "read" | "write" | "delete";

interface UserPermissionsView {
  canViewAllRecords?: boolean;
  canDeleteLeads?: boolean;
  isAdmin?: boolean;
}

async function loadPerms(userId: string): Promise<UserPermissionsView> {
  const [row] = await db
    .select({
      canViewAllRecords: permissions.canViewAllRecords,
      canDeleteLeads: permissions.canDeleteLeads,
    })
    .from(permissions)
    .where(eq(permissions.userId, userId))
    .limit(1);
  return row ?? {};
}

async function denyAndLog(
  userId: string,
  entityType: string,
  entityId: string,
  action: Action,
): Promise<never> {
  logger.warn("access.denied", {
    userId,
    entityType,
    entityId,
    action,
  });
  // Best-effort audit; never fail the request if audit insert errors.
  await writeAudit({
    actorId: userId,
    action: `access.denied.${entityType}.${action}`,
    targetType: entityType,
    targetId: entityId,
  });
  throw new ForbiddenError();
}

/**
 * Lead access. Owner, optional assignee (future-proof — column may not
 * exist on every record), or someone with the org-wide can_view_all_leads
 * permission. Admin role is treated as having all-records access.
 */
export async function requireLeadAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  if (!lead) throw new NotFoundError("lead");

  const isOwner = lead.ownerId === userId;
  if (isOwner) return lead;
  if (options?.isAdmin) return lead;
  const perms = await loadPerms(userId);
  if (perms.canViewAllRecords) return lead;
  await denyAndLog(userId, "lead", id, action);
}

export async function requireAccountAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [row] = await db
    .select()
    .from(crmAccounts)
    .where(eq(crmAccounts.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("account");
  if (row.ownerId === userId) return row;
  if (options?.isAdmin) return row;
  const perms = await loadPerms(userId);
  if (perms.canViewAllRecords) return row;
  await denyAndLog(userId, "account", id, action);
}

export async function requireContactAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [row] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("contact");
  if (row.ownerId === userId) return row;
  if (options?.isAdmin) return row;
  const perms = await loadPerms(userId);
  if (perms.canViewAllRecords) return row;
  await denyAndLog(userId, "contact", id, action);
}

export async function requireOpportunityAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [row] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("opportunity");
  if (row.ownerId === userId) return row;
  if (options?.isAdmin) return row;
  const perms = await loadPerms(userId);
  if (perms.canViewAllRecords) return row;
  await denyAndLog(userId, "opportunity", id, action);
}

export async function requireTaskAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("task");
  if (row.assignedToId === userId) return row;
  if (row.createdById === userId) return row;
  if (options?.isAdmin) return row;
  const perms = await loadPerms(userId);
  if (perms.canViewAllRecords) return row;
  await denyAndLog(userId, "task", id, action);
}

/**
 * Saved-view access — only the owner. Admins can see/manage but the brief
 * doesn't include a sharing surface yet, so even can_view_all_records
 * doesn't grant read on someone else's saved views.
 */
export async function requireSavedViewAccess(
  id: string,
  userId: string,
  action: Action,
  options?: { isAdmin?: boolean },
) {
  const [row] = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("saved view");
  if (row.userId === userId) return row;
  if (options?.isAdmin) return row;
  await denyAndLog(userId, "saved_view", id, action);
}
