"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications, tasks } from "@/db/schema/tasks";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { markAllSeen } from "@/lib/notifications";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import {
  canDeleteAccount,
  canDeleteContact,
  canDeleteLead,
  canDeleteOpportunity,
  canDeleteTask,
} from "@/lib/access/can-delete";
import { restoreLeadsById } from "@/lib/leads";
import { restoreAccountsById } from "@/lib/accounts";
import { restoreContactsById } from "@/lib/contacts";
import { restoreOpportunitiesById } from "@/lib/opportunities";
import { restoreTasksById } from "@/lib/tasks";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Clear the topbar bell badge by advancing the caller's last-seen
 * cursor (`user_preferences.notifications_last_seen_at`). Deliberately
 * does NOT mutate any notification row's is_read — the /notifications
 * activity log persists in full regardless of seen/read state.
 * Revalidates the app layout so the badge (countUnseen) recomputes on
 * the next render wherever the user currently is.
 */
export async function markAllSeenAction(): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "notifications.mark_all_seen" },
    async () => {
      const session = await requireSession();
      await markAllSeen(session.id);
      revalidatePath("/", "layout");
    },
  );
}

const ARCHIVE_ENTITY_TYPES = [
  "lead",
  "account",
  "contact",
  "opportunity",
  "task",
] as const;

const restoreFromNotificationSchema = z.object({
  notificationId: z.string().uuid(),
  entityType: z.enum(ARCHIVE_ENTITY_TYPES),
  entityId: z.string().uuid(),
});

/**
 * Restore the entity referenced by an `archive_pending` notification.
 * The notification carries the entity discriminator (entity_type +
 * entity_id) snapshotted at archive time; this action validates the
 * row belongs to the caller (the prompt's recipient), re-fetches the
 * archived entity, runs the SAME canDelete<E> gate as the
 * per-entity restoreXAction (parity), and invokes the same atomic
 * cascade-restore lib. On success the notification row is marked
 * is_read = true so the UI hides the Restore button on the next
 * render.
 *
 * @actor owner / creator / assignee (per entity), or admin
 */
export async function restoreFromNotificationAction(input: {
  notificationId: string;
  entityType: string;
  entityId: string;
}): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "notifications.restore_from_archive_prompt" },
    async () => {
      const session = await requireSession();
      const parsed = restoreFromNotificationSchema.parse(input);

      // Confirm the notification belongs to the caller and is an
      // actionable archive prompt for the claimed target. Prevents a
      // hostile client from passing arbitrary entity ids.
      const [notif] = await db
        .select({
          id: notifications.id,
          userId: notifications.userId,
          kind: notifications.kind,
          entityType: notifications.entityType,
          entityId: notifications.entityId,
          isRead: notifications.isRead,
        })
        .from(notifications)
        .where(eq(notifications.id, parsed.notificationId))
        .limit(1);
      if (!notif || notif.userId !== session.id) {
        throw new NotFoundError("Notification not found.");
      }
      if (notif.kind !== "archive_pending") {
        throw new ValidationError(
          "That notification is not an archive prompt.",
        );
      }
      if (
        notif.entityType !== parsed.entityType ||
        notif.entityId !== parsed.entityId
      ) {
        throw new ValidationError(
          "Notification target does not match the requested restore.",
        );
      }

      // Per-entity restore: re-fetch the archived row, run the same
      // predicate the per-entity restoreXAction enforces, then
      // invoke the same cascade-restore lib (single code path).
      //
      // Ownership re-check (M-7): the canDelete<E> predicate below
      // is the AUTHORITATIVE ownership gate. It reads the LIVE row's
      // ownerId / createdById / assignedToId — so a user whose
      // ownership of the entity LATER changed (transfer-of-ownership
      // after the archive_pending notification was emitted) is
      // caught here and rejected with ForbiddenError. The
      // `notif.userId === session.id` check above is for
      // notification-row attribution only (does the caller actually
      // own this notification row?); it is NOT an authorization
      // check on the underlying entity. Stale notifications that
      // outlive their recipient's ownership cannot grant restore.
      switch (parsed.entityType) {
        case "lead": {
          const [row] = await db
            .select({ id: leads.id, ownerId: leads.ownerId })
            .from(leads)
            .where(eq(leads.id, parsed.entityId))
            .limit(1);
          if (!row) throw new NotFoundError("Lead not found.");
          if (!canDeleteLead(session, row)) {
            throw new ForbiddenError("You can't restore this lead.");
          }
          await restoreLeadsById([parsed.entityId], session.id);
          await writeAudit({
            actorId: session.id,
            action: "lead.restore",
            targetType: "lead",
            targetId: parsed.entityId,
            after: { via: "notification" },
          });
          revalidatePath("/leads");
          revalidatePath("/leads/archived");
          revalidatePath(`/leads/${parsed.entityId}`);
          break;
        }
        case "account": {
          const [row] = await db
            .select({ id: crmAccounts.id, ownerId: crmAccounts.ownerId })
            .from(crmAccounts)
            .where(eq(crmAccounts.id, parsed.entityId))
            .limit(1);
          if (!row) throw new NotFoundError("Account not found.");
          if (!canDeleteAccount(session, row)) {
            throw new ForbiddenError("You can't restore this account.");
          }
          await restoreAccountsById([parsed.entityId], session.id);
          await writeAudit({
            actorId: session.id,
            action: "account.restore",
            targetType: "account",
            targetId: parsed.entityId,
            after: { via: "notification" },
          });
          revalidatePath("/accounts");
          revalidatePath("/accounts/archived");
          revalidatePath(`/accounts/${parsed.entityId}`);
          break;
        }
        case "contact": {
          const [row] = await db
            .select({ id: contacts.id, ownerId: contacts.ownerId })
            .from(contacts)
            .where(eq(contacts.id, parsed.entityId))
            .limit(1);
          if (!row) throw new NotFoundError("Contact not found.");
          if (!canDeleteContact(session, row)) {
            throw new ForbiddenError("You can't restore this contact.");
          }
          await restoreContactsById([parsed.entityId], session.id);
          await writeAudit({
            actorId: session.id,
            action: "contact.restore",
            targetType: "contact",
            targetId: parsed.entityId,
            after: { via: "notification" },
          });
          revalidatePath("/contacts");
          revalidatePath("/contacts/archived");
          revalidatePath(`/contacts/${parsed.entityId}`);
          break;
        }
        case "opportunity": {
          const [row] = await db
            .select({ id: opportunities.id, ownerId: opportunities.ownerId })
            .from(opportunities)
            .where(eq(opportunities.id, parsed.entityId))
            .limit(1);
          if (!row) throw new NotFoundError("Opportunity not found.");
          if (!canDeleteOpportunity(session, row)) {
            throw new ForbiddenError("You can't restore this opportunity.");
          }
          await restoreOpportunitiesById([parsed.entityId], session.id);
          await writeAudit({
            actorId: session.id,
            action: "opportunity.restore",
            targetType: "opportunity",
            targetId: parsed.entityId,
            after: { via: "notification" },
          });
          revalidatePath("/opportunities");
          revalidatePath("/opportunities/pipeline");
          revalidatePath("/opportunities/archived");
          revalidatePath(`/opportunities/${parsed.entityId}`);
          break;
        }
        case "task": {
          const [row] = await db
            .select({
              id: tasks.id,
              createdById: tasks.createdById,
              assignedToId: tasks.assignedToId,
            })
            .from(tasks)
            .where(eq(tasks.id, parsed.entityId))
            .limit(1);
          if (!row) throw new NotFoundError("Task not found.");
          if (!canDeleteTask(session, row)) {
            throw new ForbiddenError("You can't restore this task.");
          }
          await restoreTasksById([parsed.entityId], session.id);
          await writeAudit({
            actorId: session.id,
            action: "task.restore",
            targetType: "task",
            targetId: parsed.entityId,
            after: { via: "notification" },
          });
          revalidatePath("/tasks");
          revalidatePath("/tasks/archived");
          break;
        }
      }

      // Mark the prompt resolved so the UI hides the Restore button.
      // Scoped to this caller's own notification row.
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(
          and(
            eq(notifications.id, parsed.notificationId),
            eq(notifications.userId, session.id),
          ),
        );

      // Narrow revalidation only (M-6). The per-entity revalidatePath
      // calls inside each switch arm already touch the relevant list
      // / detail / archive paths; a layout-wide revalidation was
      // overkill — only the bell badge + /notifications page need a
      // recompute beyond the per-entity surfaces, both of which the
      // bell pulls fresh via its own next/cache layer.
      revalidatePath("/notifications");
    },
  );
}
